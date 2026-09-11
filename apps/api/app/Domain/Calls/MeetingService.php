<?php

namespace App\Domain\Calls;

use App\Models\Meeting;
use App\Models\MeetingParticipant;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/** FR-MEET-001..004: public media capabilities never confer chat membership. */
class MeetingService
{
    public function __construct(private MediaServer $media) {}

    public function available(Meeting $m): bool
    {
        return ! $m->ended_at && $m->expires_at->isFuture() && DB::table('workspace_members as wm')
            ->join('workspaces as w', 'w.id', '=', 'wm.workspace_id')->join('users as u', 'u.id', '=', 'wm.user_id')
            ->where('w.id', $m->workspace_id)->where('u.id', $m->created_by)->where('w.status', 'active')
            ->where('u.status', 'active')->where('u.must_change_password', false)->where('wm.status', 'active')->exists();
    }

    public function participantAllowed(MeetingParticipant $p, Meeting $m): bool
    {
        if ($p->left_at || ! $this->available($m)) {
            return false;
        }
        if (! $p->user_id) {
            return true;
        }

        return DB::table('sessions as s')->join('users as u', 'u.id', '=', 's.user_id')
            ->where('s.id', $p->session_id)->where('u.id', $p->user_id)->whereNull('s.revoked_at')->where('s.expires_at', '>', now())
            ->where('u.status', 'active')->where('u.must_change_password', false)->exists();
    }

    public function summary(Meeting $m): array
    {
        return $m->only(['id', 'code', 'title', 'expires_at', 'ended_at', 'created_at']);
    }

    public function join(Meeting $m, ?User $user, ?string $session, ?string $name, ?string $resume): array
    {
        return DB::transaction(function () use ($m, $user, $session, $name, $resume) {
            $m = Meeting::whereKey($m->id)->lockForUpdate()->firstOrFail();
            abort_unless($this->available($m), 410);
            // Scheduler touches connected participants every 10s; reserve only a reconnect grace.
            MeetingParticipant::where('meeting_id', $m->id)->whereNull('left_at')->where('updated_at', '<', now()->subSeconds(30))->update(['left_at' => now()]);
            $p = $resume ? MeetingParticipant::where('meeting_id', $m->id)->where('token_hash', hash('sha256', $resume))->whereNull('left_at')->first() : null;
            if ($p) {
                abort_unless($p->user_id === $user?->id && (! $user || $p->session_id === $session), 403);
            }
            if (! $p && $user) {
                $p = MeetingParticipant::where('meeting_id', $m->id)->where('user_id', $user->id)->whereNull('left_at')->first();
                abort_if($p && $p->session_id !== $session, 409);
            }
            if (! $p && ! $user) {
                validator(['name' => $name], ['name' => ['required', 'string', 'min:1', 'max:80']])->validate();
            }
            abort_if(! $p && MeetingParticipant::where('meeting_id', $m->id)->whereNull('left_at')->count() >= config('calls.max_participants'), 409);
            // Explicit creation wakes an empty SFU room while auto_create stays disabled.
            $remote = 'meeting-'.$m->id;
            $this->media->request('CreateRoom', $remote, ['name' => $remote, 'empty_timeout' => 60, 'departure_timeout' => 20, 'max_participants' => config('calls.max_participants')]);
            $secret = bin2hex(random_bytes(32));
            if (! $p) {
                $p = new MeetingParticipant(['meeting_id' => $m->id, 'user_id' => $user?->id, 'session_id' => $session, 'name' => $user?->display_name ?? $name]);
            }
            if ($user) {
                $p->name = $user->display_name;
            }
            $p->token_hash = hash('sha256', $secret);
            $p->save();
            $p->touch();

            return ['meeting' => $this->summary($m), 'participant_token' => $secret, 'participant_id' => $p->id, 'can_end' => $user?->id === $m->created_by,
                'workspace_slug' => $user?->id === $m->created_by ? DB::table('workspaces')->where('id', $m->workspace_id)->value('slug') : null,
                'url' => config('calls.url'), 'token' => $this->media->token(['sub' => $p->id, 'name' => $p->name.($p->user_id ? '' : ' (Guest)'),
                    'video' => ['roomJoin' => true, 'room' => $remote, 'canSubscribe' => true, 'canPublish' => true, 'canPublishData' => false, 'canPublishSources' => ['microphone', 'camera', 'screen_share', 'screen_share_audio']]])];
        });
    }

    public function end(Meeting $m): void
    {
        DB::transaction(function () use ($m) {
            $m = Meeting::whereKey($m->id)->lockForUpdate()->firstOrFail();
            $m->update(['ended_at' => $m->ended_at ?? now()]);
            MeetingParticipant::where('meeting_id', $m->id)->whereNull('left_at')->update(['left_at' => now()]);
        });
        $this->media->request('DeleteRoom', 'meeting-'.$m->id, ['room' => 'meeting-'.$m->id]);
    }

    public function leave(Meeting $m, string $secret): void
    {
        $p = MeetingParticipant::where('meeting_id', $m->id)->where('token_hash', hash('sha256', $secret))->first();
        abort_unless($p, 403);
        $p->update(['left_at' => $p->left_at ?? now()]);
        $this->media->request('RemoveParticipant','meeting-'.$m->id,['room' => 'meeting-'.$m->id, 'identity' => $p->id]);
    }
}
