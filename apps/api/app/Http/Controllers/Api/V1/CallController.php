<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Calls\CallService;
use App\Domain\Calls\MediaServer;
use App\Domain\Calls\MeetingService;
use App\Http\Controllers\Controller;
use App\Models\CallParticipant;
use App\Models\Meeting;
use App\Models\MeetingParticipant;
use App\Models\Room;
use App\Models\RoomCall;
use App\Support\WorkspaceContext;
use Illuminate\Http\Request;

class CallController extends Controller
{
    public function __construct(private WorkspaceContext $context, private CallService $calls) {}

    private function enabled(): void
    {
        abort_unless(config('calls.enabled') && config('calls.secret') && config('calls.url'), 503, 'Calling is not configured.');
    }

    private function call(Request $r, string $id): RoomCall
    {
        $this->enabled();
        $c = RoomCall::where('workspace_id', $this->context->id())->findOrFail($id);
        abort_unless($this->calls->allowed($r->user()->id, $c->room_id), 404);

        return $c;
    }

    public function index(Request $r)
    {
        if (! config('calls.enabled')) {
            return response()->json(['data' => ['enabled' => false, 'calls' => []]]);
        }
        $calls = RoomCall::where('workspace_id', $this->context->id())->whereNull('ended_at')
            ->whereIn('room_id', fn ($q) => $q->select('room_id')->from('room_members')->where('user_id', $r->user()->id)->whereNull('left_at'))->get()
            ->filter(fn ($c) => $this->calls->allowed($r->user()->id, $c->room_id))->map(fn ($c) => $this->calls->serialize($c, $r->user()->id))->values();

        return response()->json(['data' => ['enabled' => true, 'calls' => $calls]]);
    }

    public function start(Request $r, string $id)
    {
        $this->enabled();
        $data = $r->validate(['kind' => ['required', 'in:voice,video']]);
        $room = Room::where('workspace_id', $this->context->id())->findOrFail($id);
        abort_unless($this->calls->allowed($r->user()->id, $room->id), 404);

        return response()->json(['data' => $this->calls->serialize($this->calls->start($room, $r->user()->id, $data['kind']), $r->user()->id)]);
    }

    public function join(Request $r, string $id)
    {
        return response()->json(['data' => $this->calls->join($this->call($r, $id), $r->user()->id, $r->attributes->get('chat_session')->id)]);
    }

    public function leave(Request $r, string $id)
    {
        $this->calls->leave($this->call($r, $id), $r->user()->id, $r->attributes->get('chat_session')->id);

        return response()->noContent();
    }

    public function end(Request $r, string $id)
    {
        $c = $this->call($r, $id);
        abort_unless($c->started_by === $r->user()->id, 403);
        $this->calls->end($c);

        return response()->noContent();
    }

    public function decline(Request $r, string $id)
    {
        $c = $this->call($r, $id);
        abort_if($c->started_by === $r->user()->id, 422);
        if (Room::findOrFail($c->room_id)->isDm() && ! $c->connected_at) {
            $this->calls->end($c);
        }

        return response()->noContent();
    }

    public function authorizeMedia(Request $r, MediaServer $media)
    {
        $this->enabled();
        try {
            $claims = $media->decode($r->bearerToken() ?? '');
        } catch (\Throwable $e) {
            abort(401);
        }
        if (str_starts_with($claims->video->room ?? '', 'meeting-')) {
            $participant = MeetingParticipant::find($claims->sub ?? '');
            $meeting = $participant ? Meeting::find($participant->meeting_id) : null;
            abort_unless($meeting && $claims->video->room === 'meeting-'.$meeting->id
                && app(MeetingService::class)->participantAllowed($participant, $meeting), 403);

            return response()->noContent();
        }
        $p = CallParticipant::find($claims->sub ?? '');
        abort_unless($p, 403);
        $c = RoomCall::find($p->call_id);
        abort_unless($c && ($claims->video->room ?? '') === 'call-'.$c->id && $this->calls->participantAllowed($p, $c), 403);

        return response()->noContent();
    }
}
