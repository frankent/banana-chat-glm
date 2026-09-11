<?php

namespace App\Jobs;

use App\Models\InAppNotification;
use App\Models\KanbanTicket;
use App\Models\Workspace;
use App\Models\WorkspaceMember;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;

/** FR-KAN-004: recover missed deadlines after downtime; durable, idempotent reminders. */
class NotifyDueTickets implements ShouldQueue
{
    use Dispatchable,InteractsWithQueue,Queueable,SerializesModels;

    public function handle(): void
    {
        KanbanTicket::whereNotNull('due_at')->where('due_at', '<=', now())->whereNull('due_notified_at')->whereNotNull('assignee_id')->select(['id', 'workspace_id'])->chunkById(100, function ($tickets) {
            foreach ($tickets as $row) {
                DB::transaction(function () use ($row) {
                    // Same lock order as ticket/lane edits: completion and reminder cannot race.
                    if (! Workspace::whereKey($row->workspace_id)->lockForUpdate()->first()) {
                        return;
                    }
                    $ticket = KanbanTicket::lockForUpdate()->find($row->id);
                    if (! $ticket || ! $ticket->due_at || $ticket->due_at->isFuture() || $ticket->due_notified_at || ! $ticket->assignee_id || $ticket->lane->is_done) {
                        return;
                    }
                    $membership = WorkspaceMember::where('workspace_id', $ticket->workspace_id)->where('user_id', $ticket->assignee_id)->where('status', 'active')->whereHas('user', fn ($q) => $q->where('status', 'active'))->whereHas('workspace', fn ($q) => $q->where('status', 'active'))->first();
                    if (! $membership) {
                        return;
                    }
                    InAppNotification::create(['user_id' => $ticket->assignee_id, 'workspace_id' => $ticket->workspace_id, 'type' => 'ticket_due', 'data' => ['ticket_id' => $ticket->id, 'number' => $ticket->number, 'title' => $ticket->title, 'due_at' => $ticket->due_at->toIso8601String()]]);
                    $ticket->update(['due_notified_at' => now()]);
                });
            }
        });
    }
}
