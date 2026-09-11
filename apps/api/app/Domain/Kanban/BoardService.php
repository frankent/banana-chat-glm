<?php

namespace App\Domain\Kanban;

use App\Enums\UserStatus;
use App\Events\BoardChanged;
use App\Models\KanbanHistory;
use App\Models\KanbanLane;
use App\Models\KanbanTicket;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;

/** FR-KAN-001..003: same mutation boundary for member API and admin panel. */
class BoardService
{
    public function initialize(string $workspaceId): void
    {
        DB::transaction(function () use ($workspaceId) {
            Workspace::whereKey($workspaceId)->lockForUpdate()->firstOrFail();
            if (DB::table('kanban_boards')->where('workspace_id', $workspaceId)->exists()) {
                return;
            }
            DB::table('kanban_boards')->insert(['workspace_id' => $workspaceId, 'next_number' => 1]);
            foreach ([['To do', '#8b9b79', false], ['In progress', '#dfb44e', false], ['Done', '#58a995', true]] as $i => $lane) {
                KanbanLane::create(['workspace_id' => $workspaceId, 'name' => $lane[0], 'color' => $lane[1], 'is_done' => $lane[2], 'position' => $i]);
            }
        });
    }

    public function canManage(User $actor, string $workspaceId): bool
    {
        return $actor->is_system_admin || WorkspaceMember::where('workspace_id', $workspaceId)->where('user_id', $actor->id)->where('status', 'active')->whereIn('role', ['owner', 'admin'])->exists();
    }

    public function saveLane(User $actor, string $workspaceId, ?string $id, array $input): KanbanLane
    {
        abort_unless($this->canManage($actor, $workspaceId), 403);
        $data = Validator::make($input, [
            'name' => [$id ? 'sometimes' : 'required', 'string', 'max:60', 'regex:/\S/'],
            'color' => ['sometimes', 'regex:/^#[0-9a-fA-F]{6}$/'], 'position' => ['sometimes', 'integer', 'min:0', 'max:100'], 'is_done' => ['sometimes', 'boolean'],
        ])->validate();
        $this->initialize($workspaceId);

        return DB::transaction(function () use ($actor, $workspaceId, $id, $data) {
            Workspace::whereKey($workspaceId)->lockForUpdate()->firstOrFail();
            $lane = $id ? KanbanLane::where('workspace_id', $workspaceId)->findOrFail($id) : new KanbanLane(['workspace_id' => $workspaceId, 'position' => KanbanLane::where('workspace_id', $workspaceId)->count()]);
            abort_if(! $id && KanbanLane::where('workspace_id', $workspaceId)->count() >= 30, 422, 'Maximum 30 lanes.');
            $wasDone = $lane->is_done;
            $lane->fill($data)->save();
            if ($wasDone && ! $lane->is_done) {
                KanbanTicket::where('workspace_id', $workspaceId)->where('lane_id', $lane->id)->update(['due_notified_at' => null]);
            }
            $ordered = KanbanLane::where('workspace_id', $workspaceId)->where('id', '!=', $lane->id)->orderBy('position')->orderBy('id')->get();
            $ordered->splice(min($lane->position, $ordered->count()), 0, [$lane]);
            foreach ($ordered as $i => $item) {
                $item->update(['position' => $i]);
            }
            DB::table('audit_logs')->insert($this->audit($actor, $workspaceId, 'kanban.lane_saved', $lane->id));
            broadcast(new BoardChanged($workspaceId));

            return $lane->refresh();
        });
    }

    public function deleteLane(User $actor, string $workspaceId, string $id): void
    {
        abort_unless($this->canManage($actor, $workspaceId), 403);
        DB::transaction(function () use ($actor, $workspaceId, $id) {
            Workspace::whereKey($workspaceId)->lockForUpdate()->firstOrFail();
            $lane = KanbanLane::where('workspace_id', $workspaceId)->findOrFail($id);
            abort_if(KanbanLane::where('workspace_id', $workspaceId)->count() <= 1, 409, 'Keep at least one lane.');
            abort_if(KanbanTicket::where('workspace_id', $workspaceId)->where('lane_id', $id)->exists(), 409, 'Move tickets out before deleting this lane.');
            $lane->delete();
            DB::table('audit_logs')->insert($this->audit($actor, $workspaceId, 'kanban.lane_deleted', $id));
            broadcast(new BoardChanged($workspaceId));
        });
    }

    private function audit(User $actor, string $workspaceId, string $action, string $id): array
    {
        return ['id' => (string) Str::ulid(), 'actor_id' => $actor->id, 'actor_type' => $actor->is_system_admin ? 'admin' : 'user', 'workspace_id' => $workspaceId, 'action' => $action, 'target_type' => 'kanban_lane', 'target_id' => $id, 'created_at' => now()];
    }

    public function saveTicket(User $actor, string $workspaceId, ?string $id, array $input): KanbanTicket
    {
        $this->initialize($workspaceId);

        return DB::transaction(function () use ($actor, $workspaceId, $id, $input) {
            Workspace::whereKey($workspaceId)->lockForUpdate()->firstOrFail();
            $ticket = $id ? KanbanTicket::where('workspace_id', $workspaceId)->lockForUpdate()->findOrFail($id) : new KanbanTicket(['workspace_id' => $workspaceId, 'version' => 1, 'reporter_id' => $actor->id]);
            $data = Validator::make($input, [
                'title' => [$id ? 'sometimes' : 'required', 'string', 'max:200', 'regex:/\S/'], 'description' => ['nullable', 'string', 'max:20000'],
                'lane_id' => [$id ? 'sometimes' : 'required', Rule::exists('kanban_lanes', 'id')->where('workspace_id', $workspaceId)],
                'type' => ['sometimes', Rule::in(['task', 'bug', 'story'])], 'priority' => ['sometimes', Rule::in(['low', 'medium', 'high', 'urgent'])],
                'assignee_id' => ['nullable', Rule::exists('workspace_members', 'user_id')->where('workspace_id', $workspaceId)->where('status', 'active')],
                'due_at' => ['nullable', 'date'], 'labels' => ['sometimes', 'array', 'max:10'], 'labels.*' => ['string', 'max:30', 'distinct'],
                'version' => [$id ? 'required' : 'sometimes', 'integer', 'min:1'],
            ])->validate();
            if (isset($data['assignee_id'])) {
                abort_unless(User::whereKey($data['assignee_id'])->where('status', UserStatus::Active)->exists(), 422, 'Assignee must be active.');
            }
            if ($id) {
                abort_if($ticket->version !== $data['version'], 409, 'Ticket changed. Reload before saving.');
            }
            unset($data['version']);
            $old = $ticket->getAttributes();
            $wasDone = $id && $ticket->lane->is_done;
            $ticket->fill($data);
            if (! $id) {
                $number = DB::table('kanban_boards')->where('workspace_id', $workspaceId)->value('next_number');
                DB::table('kanban_boards')->where('workspace_id', $workspaceId)->increment('next_number');
                $ticket->number = $number;
            } else {
                $ticket->version++;
            }
            if ($ticket->isDirty(['due_at', 'assignee_id']) || ($wasDone && ! KanbanLane::findOrFail($ticket->lane_id)->is_done)) {
                $ticket->due_notified_at = null;
            }
            $changes = [];
            foreach ($ticket->getDirty() as $key => $value) {
                if (! in_array($key, ['version', 'due_notified_at', 'workspace_id', 'reporter_id'])) {
                    $changes[$key] = ['from' => $old[$key] ?? null, 'to' => $value];
                }
            }
            $ticket->save();
            KanbanHistory::create(['ticket_id' => $ticket->id, 'actor_id' => $actor->id, 'changes' => $changes]);
            broadcast(new BoardChanged($workspaceId));

            return $ticket->refresh()->load(['assignee', 'reporter']);
        });
    }
}
