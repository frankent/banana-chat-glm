<?php

namespace App\Domain\Calls;

use App\Domain\Media\AvatarUrls;
use App\Domain\Notification\PushDecisionService;
use App\Domain\Room\SystemMessageWriter;
use App\Enums\NotificationMode;
use App\Events\CallChanged;
use App\Events\NotificationAlert;
use App\Models\Attachment;
use App\Models\CallParticipant;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

class CallService
{
    public function __construct(private MediaServer $media, private CallCapacity $capacity, private SystemMessageWriter $systemMessages) {}

    public function allowed(string $uid, string $rid): bool
    {
        return DB::table('rooms as r')->join('workspaces as w', 'w.id', '=', 'r.workspace_id')
            ->join('workspace_members as wm', 'wm.workspace_id', '=', 'w.id')
            ->join('room_members as rm', function ($j) {
                $j->on('rm.room_id', '=', 'r.id')->on('rm.user_id', '=', 'wm.user_id');
            })
            ->join('users as u', 'u.id', '=', 'wm.user_id')
            ->where('r.id', $rid)->where('u.id', $uid)->whereNull('r.deleted_at')->where('w.status', 'active')->where('u.status', 'active')->where('u.must_change_password', false)
            ->where('wm.status', 'active')->whereNull('rm.left_at')
            // FR-ROOM-012 — expired secret rooms deny call access immediately
            ->where(fn ($q) => $q->where('r.is_secret', false)->orWhere('r.secret_expires_at', '>', now()))
            ->exists();
    }

    public function participantAllowed(CallParticipant $p, RoomCall $call): bool
    {
        return ! $p->left_at && ! $call->ended_at && $this->allowed($p->user_id, $call->room_id)
            && DB::table('sessions')->where('id', $p->session_id)->where('user_id', $p->user_id)->whereNull('revoked_at')->where('expires_at', '>', now())->exists();
    }

    public function changed(RoomCall $call): void
    {
        $users = DB::table('room_members')->where('room_id', $call->room_id)->whereNull('left_at')->pluck('user_id')->all();
        if ($users) {
            broadcast(new CallChanged($call->workspace_id, $users));
        }
    }

    public function serialize(RoomCall $c, ?string $viewer = null, ?Collection $userAvatars = null): array
    {
        $room = Room::withoutGlobalScopes()->find($c->room_id);
        $dm = (bool) ($room?->isDm() && $viewer);
        // FR-PROF-007 / DEC-089: the DM counterpart from the viewer's
        // perspective powers room_name and peer_avatar alike.
        $peer = $dm ? DB::table('room_members as rm')->join('users as u', 'u.id', '=', 'rm.user_id')->where('rm.room_id', $room->id)->whereNull('rm.left_at')->where('u.id', '!=', $viewer)->first(['u.id', 'u.display_name']) : null;
        $avatars = $userAvatars ?? $this->userAvatars([$c->started_by, $peer?->id]);

        return array_merge($c->only(['id', 'room_id', 'workspace_id', 'kind', 'started_by', 'connected_at', 'created_at', 'ended_at']), [
            'room_name' => $dm ? $peer?->display_name : $room?->name,
            'room_type' => $room?->type->value,
            'caller_name' => DB::table('users')->where('id', $c->started_by)->value('display_name'),
            'caller_avatar' => $avatars->get($c->started_by),
            'peer_avatar' => $dm && $peer ? $avatars->get($peer->id) : null,
            'participants' => CallParticipant::where('call_id', $c->id)->whereNull('left_at')->pluck('user_id')->all(),
        ]);
    }

    /**
     * FR-PROF-007 / DEC-089 — user_id => avatar map behind caller_avatar and
     * peer_avatar. Single calls resolve their own two ids; GET /calls
     * preloads one map for every row via avatarsFor() instead.
     *
     * @param  iterable<string|null>  $ids
     * @return Collection<string, array{sm: string, md: string, animated: string|null}|null>
     */
    private function userAvatars(iterable $ids): Collection
    {
        $ids = collect($ids)->filter()->unique()->values();
        if ($ids->isEmpty()) {
            return collect();
        }
        $attachmentIds = DB::table('users')->whereIn('id', $ids)->pluck('avatar_attachment_id', 'id');
        $avatars = AvatarUrls::mapFor($attachmentIds->values()->all());

        return $ids->mapWithKeys(fn (string $id) => [$id => $avatars->get($attachmentIds[$id] ?? null)]);
    }

    /**
     * ONE batched avatar map for a whole call list — started_by plus every
     * member of every call room covers caller_avatar and the DM peer for any
     * viewer (the N+1 guard for GET /calls).
     *
     * @param  iterable<RoomCall>  $calls
     * @return Collection<string, array{sm: string, md: string, animated: string|null}|null>
     */
    public function avatarsFor(iterable $calls): Collection
    {
        $calls = collect($calls);
        if ($calls->isEmpty()) {
            return collect();
        }
        $members = DB::table('room_members')->whereIn('room_id', $calls->pluck('room_id'))->whereNull('left_at')->pluck('user_id');

        return $this->userAvatars($members->merge($calls->pluck('started_by'))->all());
    }

    public function start(Room $room, string $uid, string $kind): RoomCall
    {
        abort_unless(in_array($room->type->value, ['dm', 'group'], true), 422);
        abort_if($kind === 'voice' && ! $room->isDm(), 422, 'Voice calls are available in direct rooms.');

        return DB::transaction(function () use ($room, $uid, $kind) {
            Room::withoutGlobalScopes()->whereKey($room->id)->lockForUpdate()->firstOrFail();
            abort_unless($this->allowed($uid, $room->id), 404);
            $existing = RoomCall::where('room_id', $room->id)->whereNull('ended_at')->first();
            if ($existing) {
                return $existing;
            }
            // FR-CALL-006 / DEC-057: snapshot the live setting — LiveKit CreateRoom never
            // updates max_participants of an existing room, so admission and the SFU limit
            // must share this stored value for the whole life of the call.
            $call = RoomCall::create(['room_id' => $room->id, 'workspace_id' => $room->workspace_id, 'started_by' => $uid, 'kind' => $kind, 'capacity' => $this->capacity->forRoom($room->isDm())]);
            $this->media->request('CreateRoom', 'call-'.$call->id, ['name' => 'call-'.$call->id, 'empty_timeout' => 60, 'departure_timeout' => 20, 'max_participants' => $call->capacity]);
            $this->changed($call);
            // FR-CALL-010 / DEC-091 — a "call started" card with Join in the
            // timeline; only for a NEW call (the $existing branch above posts
            // nothing). Context = ids only; the card reads live call state.
            $this->systemMessages->write($room, User::findOrFail($uid), 'call_started', ['call_id' => $call->id, 'kind' => $kind]);
            foreach (DB::table('room_members')->where('room_id', $room->id)->whereNull('left_at')->where('user_id', '!=', $uid)->pluck('user_id') as $recipientId) {
                $recipient = User::find($recipientId);
                $setting = $recipient?->notificationSetting;
                $roomSetting = RoomNotificationSetting::where('room_id', $room->id)->where('user_id', $recipientId)->first();
                if ($recipient && $this->allowed($recipientId, $room->id) && ($setting?->sound ?? true)
                    && ! app(PushDecisionService::class)->inDnd($setting, $recipient->timezone)
                    && $roomSetting?->mode !== NotificationMode::None && ! ($roomSetting?->muted_until?->isFuture() ?? false)) {
                    broadcast(new NotificationAlert($recipientId, $call->id, $room->id, $room->workspace_id, 'call'));
                }
            }

            return $call;
        });
    }

    public function join(RoomCall $call, string $uid, string $session): array
    {
        return DB::transaction(function () use ($call, $uid, $session) {
            $call = RoomCall::whereKey($call->id)->lockForUpdate()->firstOrFail();
            abort_if($call->ended_at, 409, 'Call ended.');
            abort_unless($this->allowed($uid, $call->room_id), 404);
            $existing = CallParticipant::where('call_id', $call->id)->where('user_id', $uid)->whereNull('left_at')->first();
            abort_if($existing && $existing->session_id !== $session, 409, 'Already joined on another device.');
            abort_if(! $existing && CallParticipant::where('call_id', $call->id)->whereNull('left_at')->count() >= $call->capacity, 409, 'Call is full.');
            $p = $existing ?? CallParticipant::create(['call_id' => $call->id, 'user_id' => $uid, 'session_id' => $session]);
            if ($existing) {
                $p->touch();
            }
            $this->changed($call);

            // FR-CALL-009 / DEC-086: participant join tokens live for
            // calls.token_ttl (default 6h) so a backgrounded phone's reconnect
            // is not 401'd by /_call_auth while the call is still active.
            $user = DB::table('users')->where('id', $uid)->first(['display_name', 'avatar_attachment_id']);
            // FR-PROF-007 / DEC-089: the standard LiveKit `metadata` claim —
            // the joiner's avatar object (or explicit null), nothing else. A
            // rejoin (FR-CALL-009) mints a fresh token, so a changed photo
            // shows on the next reconnect; mid-call changes are not pushed.
            $avatar = AvatarUrls::for($user->avatar_attachment_id ? Attachment::withoutGlobalScopes()->find($user->avatar_attachment_id) : null, AvatarUrls::expiresAtForCallToken());

            return ['call' => $this->serialize($call, $uid), 'url' => config('calls.url'), 'token' => $this->media->token([
                'sub' => $p->id, 'name' => $user->display_name, 'metadata' => json_encode(['avatar' => $avatar]),
                'video' => ['roomJoin' => true, 'room' => 'call-'.$call->id, 'canSubscribe' => true, 'canPublish' => true, 'canPublishData' => false, 'canPublishSources' => $call->kind === 'voice' ? ['microphone'] : ['microphone', 'camera', 'screen_share', 'screen_share_audio']],
            ], (int) config('calls.token_ttl'))];
        });
    }

    public function end(RoomCall $call): void
    {
        // Persist revocation first: the signaling gate fails closed even if SFU is unavailable.
        $call->update(['ended_at' => $call->ended_at ?? now()]);
        CallParticipant::where('call_id', $call->id)->whereNull('left_at')->update(['left_at' => now()]);
        $this->changed($call);
        $this->media->request('DeleteRoom', 'call-'.$call->id, ['room' => 'call-'.$call->id]);
    }

    public function leave(RoomCall $call, string $uid, string $session): void
    {
        $action = DB::transaction(function () use ($call, $uid, $session) {
            $call = RoomCall::whereKey($call->id)->lockForUpdate()->firstOrFail();
            $p = CallParticipant::where('call_id', $call->id)->where('user_id', $uid)->where('session_id', $session)->whereNull('left_at')->first();
            if (! $p) {
                return null;
            }
            $p->update(['left_at' => now()]);
            $end = Room::withoutGlobalScopes()->findOrFail($call->room_id)->isDm() || ! CallParticipant::where('call_id', $call->id)->whereNull('left_at')->exists();
            if ($end) {
                $call->update(['ended_at' => now()]);
                CallParticipant::where('call_id', $call->id)->whereNull('left_at')->update(['left_at' => now()]);
            }
            $this->changed($call);

            return [$end, $p->id];
        });
        if ($action) {
            $this->media->request($action[0] ? 'DeleteRoom' : 'RemoveParticipant', 'call-'.$call->id,
                $action[0] ? ['room' => 'call-'.$call->id] : ['room' => 'call-'.$call->id, 'identity' => $action[1]]);
        }
    }
}
