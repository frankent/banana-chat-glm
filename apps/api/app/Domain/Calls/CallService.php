<?php

namespace App\Domain\Calls;

use App\Domain\Notification\PushDecisionService;
use App\Enums\NotificationMode;
use App\Events\CallChanged;
use App\Events\NotificationAlert;
use App\Models\CallParticipant;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use Illuminate\Support\Facades\DB;

class CallService
{
    public function __construct(private MediaServer $media) {}

    public function allowed(string $uid, string $rid): bool
    {
        return DB::table('rooms as r')->join('workspaces as w', 'w.id', '=', 'r.workspace_id')
            ->join('workspace_members as wm', 'wm.workspace_id', '=', 'w.id')
            ->join('room_members as rm', function ($j) {
                $j->on('rm.room_id', '=', 'r.id')->on('rm.user_id', '=', 'wm.user_id');
            })
            ->join('users as u', 'u.id', '=', 'wm.user_id')
            ->where('r.id', $rid)->where('u.id', $uid)->whereNull('r.deleted_at')->where('w.status', 'active')->where('u.status', 'active')->where('u.must_change_password', false)
            ->where('wm.status', 'active')->whereNull('rm.left_at')->exists();
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

    public function serialize(RoomCall $c, ?string $viewer = null): array
    {
        $room = Room::withoutGlobalScopes()->find($c->room_id);

        return array_merge($c->only(['id', 'room_id', 'workspace_id', 'kind', 'started_by', 'connected_at', 'created_at', 'ended_at']), [
            'room_name' => $room?->isDm() && $viewer ? DB::table('room_members as rm')->join('users as u', 'u.id', '=', 'rm.user_id')->where('rm.room_id', $room->id)->whereNull('rm.left_at')->where('u.id', '!=', $viewer)->value('u.display_name') : $room?->name,
            'room_type' => $room?->type->value,
            'caller_name' => DB::table('users')->where('id', $c->started_by)->value('display_name'),
            'participants' => CallParticipant::where('call_id', $c->id)->whereNull('left_at')->pluck('user_id')->all(),
        ]);
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
            $call = RoomCall::create(['room_id' => $room->id, 'workspace_id' => $room->workspace_id, 'started_by' => $uid, 'kind' => $kind]);
            $this->media->request('CreateRoom', 'call-'.$call->id, ['name' => 'call-'.$call->id, 'empty_timeout' => 60, 'departure_timeout' => 20, 'max_participants' => $room->isDm() ? 2 : config('calls.max_participants')]);
            $this->changed($call);
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
            $isDm = Room::withoutGlobalScopes()->findOrFail($call->room_id)->isDm();
            abort_if(! $existing && CallParticipant::where('call_id', $call->id)->whereNull('left_at')->count() >= ($isDm ? 2 : config('calls.max_participants')), 409, 'Call is full.');
            $p = $existing ?? CallParticipant::create(['call_id' => $call->id, 'user_id' => $uid, 'session_id' => $session]);
            if ($existing) {
                $p->touch();
            }
            $this->changed($call);

            return ['call' => $this->serialize($call, $uid), 'url' => config('calls.url'), 'token' => $this->media->token([
                'sub' => $p->id, 'name' => DB::table('users')->where('id', $uid)->value('display_name'),
                'video' => ['roomJoin' => true, 'room' => 'call-'.$call->id, 'canSubscribe' => true, 'canPublish' => true, 'canPublishData' => false, 'canPublishSources' => $call->kind === 'voice' ? ['microphone'] : ['microphone', 'camera', 'screen_share', 'screen_share_audio']],
            ])];
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
