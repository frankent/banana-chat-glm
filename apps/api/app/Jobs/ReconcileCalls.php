<?php

namespace App\Jobs;

use App\Domain\Calls\CallService;
use App\Domain\Calls\MediaServer;
use App\Models\CallParticipant;
use App\Models\Room;
use App\Models\RoomCall;
use App\Models\Workspace;
use Illuminate\Support\Facades\Log;

/** FR-CALL-004: run directly on the 10s scheduler, not behind the general job queue. */
class ReconcileCalls
{
    public function handle(CallService $calls, MediaServer $media): void
    {
        if (! config('calls.enabled')) {
            return;
        }
        // Include recently-ended rooms to retry failed SFU deletion; deleted workspace rooms are caught by ListRooms.
        $rooms = $media->request('ListRooms', '', []);
        foreach ($rooms['rooms'] ?? [] as $remote) {
            $name = $remote['name'] ?? '';
            if (! str_starts_with($name, 'call-')) {
                continue;
            }
            $call = RoomCall::find(substr($name, 5));
            try {
                if (! $call || $call->ended_at) {
                    $media->request('DeleteRoom', $name, ['room' => $name]);

                    continue;
                }
                // A logged-out browser may already have left the SFU. Revoke its app record too.
                foreach (CallParticipant::where('call_id', $call->id)->whereNull('left_at')->get() as $participant) {
                    if (! $calls->participantAllowed($participant, $call)) {
                        $participant->update(['left_at' => now()]);
                    }
                }
                $participants = $media->request('ListParticipants', $name, ['room' => $name])['participants'] ?? [];
                $present = [];
                foreach ($participants as $remoteP) {
                    $p = CallParticipant::where('call_id', $call->id)->find($remoteP['identity']);
                    if (! $p || ! $calls->participantAllowed($p, $call)) {
                        $p?->update(['left_at' => now()]);
                        $media->request('RemoveParticipant', $name, ['room' => $name, 'identity' => $remoteP['identity']]);
                    } else {
                        $present[] = $p->id;
                    }
                }
                $connected = count(array_filter($participants, fn ($p) => in_array($p['state'] ?? null, ['ACTIVE', 2], true)));
                if ($connected >= 2 && ! $call->connected_at) {
                    $call->update(['connected_at' => now()]);
                }
                // A 30-second reconnect grace avoids ending calls during a transient network handoff.
                CallParticipant::where('call_id', $call->id)->whereNull('left_at')->whereNotIn('id', $present)->where('updated_at', '<', now()->subSeconds(30))->update(['left_at' => now()]);
                if ($present) {
                    CallParticipant::whereIn('id', $present)->update(['updated_at' => now()]);
                }
                $dmDisconnected = Room::withoutGlobalScopes()->find($call->room_id)?->isDm() && CallParticipant::where('call_id', $call->id)->whereNotNull('left_at')->exists();
                $room = Room::withoutGlobalScopes()->find($call->room_id);
                $available = $room && ! $room->deleted_at && Workspace::whereKey($call->workspace_id)->where('status', 'active')->exists();
                if ($dmDisconnected || ! $available
                    || (! $call->connected_at && Room::withoutGlobalScopes()->find($call->room_id)?->isDm() && $call->created_at->lt(now()->subSeconds(60)))
                    || (! CallParticipant::where('call_id', $call->id)->whereNull('left_at')->exists() && $call->created_at->lt(now()->subSeconds(30)))) {
                    $calls->end($call);
                }
            } catch (\Throwable $e) {
                Log::warning('Call reconciliation failed', ['call_id' => $call?->id, 'exception' => get_class($e)]);
            }
        }
        $names = array_column($rooms['rooms'] ?? [], 'name');
        RoomCall::whereNull('ended_at')->where('created_at', '<', now()->subSeconds(90))->each(function ($c) use ($names, $calls) {
            if (! in_array('call-'.$c->id, $names, true)) {
                $calls->end($c);
            }
        });
    }
}
