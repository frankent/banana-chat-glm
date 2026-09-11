<?php

namespace App\Jobs;

use App\Domain\Calls\MediaServer;
use App\Domain\Calls\MeetingService;
use App\Models\Meeting;
use App\Models\MeetingParticipant;
use Illuminate\Support\Facades\Log;

/** FR-MEET-004 — enforce public meeting lifecycle independently of clients. */
class ReconcileMeetings
{
    public function handle(MeetingService $meetings, MediaServer $media): void
    {
        if (! config('calls.enabled')) {
            return;
        }
        foreach ($media->request('ListRooms', '')['rooms'] ?? [] as $remote) {
            $name = $remote['name'] ?? '';
            if (! str_starts_with($name, 'meeting-')) {
                continue;
            }
            $m = Meeting::find(substr($name, 8));
            try {
                if (! $m || ! $meetings->available($m)) {
                    if ($m) {
                        $meetings->end($m);
                    } else {
                        $media->request('DeleteRoom', $name, ['room' => $name]);
                    }

                    continue;
                }
                foreach (MeetingParticipant::where('meeting_id', $m->id)->whereNull('left_at')->get() as $p) {
                    if (! $meetings->participantAllowed($p, $m)) {
                        $p->update(['left_at' => now()]);
                    }
                }
                $present = [];
                foreach ($media->request('ListParticipants', $name, ['room' => $name])['participants'] ?? [] as $remoteP) {
                    $p = MeetingParticipant::where('meeting_id', $m->id)->find($remoteP['identity']);
                    if (! $p || ! $meetings->participantAllowed($p, $m)) {
                        $p?->update(['left_at' => now()]);
                        $media->request('RemoveParticipant', $name, ['room' => $name, 'identity' => $remoteP['identity']]);
                    } else {
                        $present[] = $p->id;
                    }
                }
                MeetingParticipant::where('meeting_id', $m->id)->whereNull('left_at')->whereNotIn('id', $present)->where('updated_at', '<', now()->subSeconds(30))->update(['left_at' => now()]);
                if ($present) {
                    MeetingParticipant::whereIn('id', $present)->whereNull('left_at')->update(['updated_at' => now()]);
                }
            } catch (\Throwable $e) {
                Log::warning('Meeting reconciliation failed', ['meeting_id' => $m?->id, 'exception' => get_class($e)]);
            }
        }
    }
}
