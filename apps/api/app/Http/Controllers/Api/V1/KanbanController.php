<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Kanban\BoardService;
use App\Events\BoardChanged;
use App\Http\Controllers\Controller;
use App\Models\KanbanComment;
use App\Models\KanbanHistory;
use App\Models\KanbanLane;
use App\Models\KanbanTicket;
use App\Support\WorkspaceContext;
use Illuminate\Http\Request;

/** API-140..148 / FR-KAN-001..005; explicit workspace lookup before every ID access. */
class KanbanController extends Controller
{
    public function __construct(private WorkspaceContext $context, private BoardService $boards) {}

    public function board(Request $request)
    {
        $wid = $this->context->id();
        $this->boards->initialize($wid);

        return response()->json(['data' => ['lanes' => KanbanLane::where('workspace_id', $wid)->orderBy('position')->orderBy('id')->get(), 'can_manage' => $this->boards->canManage($request->user(), $wid)]]);
    }

    public function createLane(Request $request)
    {
        return response()->json(['data' => $this->boards->saveLane($request->user(), $this->context->id(), null, $request->all())], 201);
    }

    public function updateLane(Request $request, string $id)
    {
        return response()->json(['data' => $this->boards->saveLane($request->user(), $this->context->id(), $id, $request->all())]);
    }

    public function deleteLane(Request $request, string $id)
    {
        $this->boards->deleteLane($request->user(), $this->context->id(), $id);

        return response()->noContent();
    }

    private function ticket(string $id): KanbanTicket
    {
        return KanbanTicket::where('workspace_id', $this->context->id())->findOrFail($id);
    }

    public function tickets(Request $request)
    {
        $data = $request->validate(['q' => ['nullable', 'string', 'max:200'], 'assignee' => ['nullable', 'string', 'max:26'], 'priority' => ['nullable', 'in:low,medium,high,urgent'], 'cursor' => ['nullable', 'ulid']]);
        $query = KanbanTicket::where('workspace_id', $this->context->id())->with(['assignee', 'reporter']);
        if (! empty($data['q'])) {
            $query->where(function ($q) use ($data) {
                $q->where('title', 'ilike', '%'.$data['q'].'%')->orWhereRaw('CAST(number AS TEXT) = ?', [$data['q']]);
            });
        }
        if (! empty($data['assignee'])) {
            $query->where('assignee_id', $data['assignee'] === 'me' ? $request->user()->id : $data['assignee']);
        }
        if (! empty($data['priority'])) {
            $query->where('priority', $data['priority']);
        }
        if (! empty($data['cursor'])) {
            $query->where('id', '<', $data['cursor']);
        }
        $rows = $query->orderByDesc('id')->limit(101)->get();

        return response()->json(['data' => ['tickets' => $rows->take(100)->map(fn ($t) => $this->serialize($t))->values(), 'next_cursor' => $rows->count() > 100 ? $rows[99]->id : null]]);
    }

    public function show(Request $request, string $id)
    {
        $ticket = $this->ticket($id)->load(['assignee', 'reporter']);
        $request->validate(['before' => ['nullable', 'ulid']]);
        $comments = KanbanComment::where('ticket_id', $id)->with('author')->when($request->query('before'), fn ($q, $before) => $q->where('id', '<', $before))->orderByDesc('id')->limit(51)->get();
        $history = KanbanHistory::where('ticket_id', $id)->with('actor')->orderByDesc('id')->limit(100)->get();

        return response()->json(['data' => array_merge($this->serialize($ticket), [
            'comments' => $comments->take(50)->map(fn ($c) => ['id' => $c->id, 'body' => $c->body, 'created_at' => $c->created_at, 'author' => $c->author?->only(['id', 'display_name', 'username'])])->values(),
            'comments_cursor' => $comments->count() > 50 ? $comments[49]->id : null,
            'history' => $history->map(fn ($h) => ['id' => $h->id, 'changes' => $h->changes, 'created_at' => $h->created_at, 'actor' => $h->actor?->only(['id', 'display_name', 'username'])]),
        ])]);
    }

    public function create(Request $request)
    {
        return response()->json(['data' => $this->serialize($this->boards->saveTicket($request->user(), $this->context->id(), null, $request->all()))], 201);
    }

    public function update(Request $request, string $id)
    {
        return response()->json(['data' => $this->serialize($this->boards->saveTicket($request->user(), $this->context->id(), $id, $request->all()))]);
    }

    public function comment(Request $request, string $id)
    {
        $ticket = $this->ticket($id);
        $data = $request->validate(['body' => ['required', 'string', 'max:10000', 'regex:/\S/']]);
        $comment = KanbanComment::create(['ticket_id' => $ticket->id, 'author_id' => $request->user()->id, 'body' => $data['body']]);
        broadcast(new BoardChanged($this->context->id()));

        return response()->json(['data' => $comment], 201);
    }

    private function serialize(KanbanTicket $ticket): array
    {
        return array_merge($ticket->only(['id', 'workspace_id', 'number', 'title', 'description', 'lane_id', 'type', 'priority', 'assignee_id', 'reporter_id', 'labels', 'due_at', 'version', 'created_at', 'updated_at']), [
            'assignee' => $ticket->assignee?->only(['id', 'display_name', 'username']), 'reporter' => $ticket->reporter?->only(['id', 'display_name', 'username']),
        ]);
    }
}
