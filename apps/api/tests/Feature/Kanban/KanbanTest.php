<?php

use App\Filament\Pages\Kanban;
use App\Jobs\NotifyDueTickets;
use App\Models\InAppNotification;
use App\Models\KanbanComment;
use App\Models\KanbanLane;
use App\Models\User;
use App\Models\Workspace;
use App\Models\WorkspaceMember;

beforeEach(function () {
    $this->owner = User::factory()->create();
    $this->member = User::factory()->create();
    $this->outsider = User::factory()->create();
    $this->ws = Workspace::factory()->create(['slug' => 'board-test']);
    $this->other = Workspace::factory()->create(['slug' => 'other-board']);
    $this->ws->members()->attach($this->owner->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->member->id, ['role' => 'member']);
    $this->other->members()->attach($this->owner->id, ['role' => 'owner']);
    $this->other->members()->attach($this->outsider->id, ['role' => 'member']);
    [, $token] = loginAs($this->owner);
    $this->headers = wsHeaders($token, 'board-test');
    $this->otherHeaders = wsHeaders($token, 'other-board');
    [, $memberToken] = loginAs($this->member);
    $this->memberHeaders = wsHeaders($memberToken, 'board-test');
});

function ticketInput($test): array
{
    $lanes = $test->getJson('/api/v1/board', $test->headers)->assertOk()->json('data.lanes');

    return ['title' => 'Fix checkout', 'lane_id' => $lanes[0]['id'], 'assignee_id' => $test->member->id, 'priority' => 'high', 'type' => 'bug', 'description' => '**Steps** to reproduce', 'due_at' => now()->addMinute()->toIso8601String()];
}

test('TC-KAN-001 board is shared within workspace and tickets cannot cross workspace', function () {
    $input = ticketInput($this);
    $ticket = $this->postJson('/api/v1/board/tickets', $input, $this->headers)->assertCreated()->json('data');
    $this->getJson('/api/v1/board/tickets', $this->memberHeaders)->assertOk()->assertJsonPath('data.tickets.0.title', $input['title']);
    $this->getJson('/api/v1/board/tickets', $this->otherHeaders)->assertOk()->assertJsonCount(0, 'data.tickets');
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'], $this->otherHeaders)->assertNotFound();
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 1, 'title' => 'leak'], $this->otherHeaders)->assertNotFound();
    $this->postJson('/api/v1/board/tickets', array_replace($input, ['assignee_id' => $this->outsider->id]), $this->headers)->assertUnprocessable();
    $this->postJson('/api/v1/board/tickets', $input, $this->otherHeaders)->assertUnprocessable();
});

test('TC-KAN-002 lane administration permissions order and safe delete', function () {
    ticketInput($this);
    $this->postJson('/api/v1/board/lanes', ['name' => 'Review'], $this->memberHeaders)->assertForbidden();
    $lane = $this->postJson('/api/v1/board/lanes', ['name' => 'Review', 'color' => '#9080dd', 'position' => 1], $this->headers)->assertCreated()->json('data');
    $this->patchJson('/api/v1/board/lanes/'.$lane['id'], ['name' => 'QA', 'is_done' => true], $this->headers)->assertOk()->assertJsonPath('data.name', 'QA');
    $this->deleteJson('/api/v1/board/lanes/'.$lane['id'], [], $this->otherHeaders)->assertNotFound();
    $this->deleteJson('/api/v1/board/lanes/'.$lane['id'], [], $this->headers)->assertNoContent();
    $input = ticketInput($this);
    $this->postJson('/api/v1/board/tickets', $input, $this->headers)->assertCreated();
    $this->deleteJson('/api/v1/board/lanes/'.$input['lane_id'], [], $this->headers)->assertStatus(409);
});

test('TC-KAN-003 edits moves comments history and concurrent edit conflicts', function () {
    $input = ticketInput($this);
    $ticket = $this->postJson('/api/v1/board/tickets', $input, $this->headers)->assertCreated()->json('data');
    $lanes = $this->getJson('/api/v1/board', $this->headers)->json('data.lanes');
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 1, 'lane_id' => $lanes[1]['id']], $this->memberHeaders)->assertOk()->assertJsonPath('data.version', 2);
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 1, 'title' => 'stale'], $this->headers)->assertStatus(409);
    $this->postJson('/api/v1/board/tickets/'.$ticket['id'].'/comments', ['body' => 'Working on it'], $this->memberHeaders)->assertCreated();
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'], $this->headers)->assertOk()->assertJsonPath('data.comments.0.body', 'Working on it')->assertJsonCount(2, 'data.history');
    $this->getJson('/api/v1/board/tickets?assignee=me', $this->headers)->assertJsonCount(0, 'data.tickets');
    $this->getJson('/api/v1/board/tickets?q=checkout', $this->memberHeaders)->assertJsonCount(1, 'data.tickets');
});

test('TC-KAN-004 deadline reminder is durable once per deadline assignment and skips done', function () {
    $ticket = $this->postJson('/api/v1/board/tickets', ticketInput($this), $this->headers)->assertCreated()->json('data');
    $this->travel(2)->minutes();
    (new NotifyDueTickets)->handle();
    (new NotifyDueTickets)->handle();
    expect(InAppNotification::where('type', 'ticket_due')->count())->toBe(1);
    expect(InAppNotification::where('type', 'ticket_due')->first()->user_id)->toBe($this->member->id);
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 1, 'due_at' => now()->addMinute()->toIso8601String()], $this->headers)->assertOk();
    $this->travel(2)->minutes();
    (new NotifyDueTickets)->handle();
    expect(InAppNotification::where('type', 'ticket_due')->count())->toBe(2);
    $done = $this->getJson('/api/v1/board', $this->headers)->json('data.lanes.2.id');
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 2, 'lane_id' => $done, 'due_at' => now()->subMinute()->toIso8601String()], $this->headers)->assertOk();
    (new NotifyDueTickets)->handle();
    expect(InAppNotification::where('type', 'ticket_due')->count())->toBe(2);
});

test('TC-KAN-005 reminders exclude inactive assignments and notification feed stays in workspace', function () {
    $ticket = $this->postJson('/api/v1/board/tickets', ticketInput($this), $this->headers)->assertCreated()->json('data');
    $this->travel(2)->minutes();
    WorkspaceMember::where('workspace_id', $this->ws->id)->where('user_id', $this->member->id)->update(['status' => 'removed']);
    (new NotifyDueTickets)->handle();
    expect(InAppNotification::where('type', 'ticket_due')->count())->toBe(0);
    WorkspaceMember::where('workspace_id', $this->ws->id)->where('user_id', $this->member->id)->update(['status' => 'active']);
    (new NotifyDueTickets)->handle();
    $this->getJson('/api/v1/me/notifications', $this->memberHeaders)->assertOk()->assertJsonPath('data.notifications.0.type', 'ticket_due');
    $this->other->members()->attach($this->member->id, ['role' => 'member']);
    $otherHeaders = array_replace($this->memberHeaders, ['X-Workspace-Id' => 'other-board']);
    $this->getJson('/api/v1/me/notifications', $otherHeaders)->assertOk()->assertJsonCount(0, 'data.notifications');
    $this->postJson('/api/v1/board/tickets/'.$ticket['id'].'/comments', ['body' => 'cross workspace'], $otherHeaders)->assertNotFound();
});

test('TC-KAN-007 Filament admin manages lanes and rejects regular users', function () {
    expect(Kanban::canAccess())->toBeFalse();
    $admin = User::factory()->create(['is_system_admin' => true]);
    $this->actingAs($admin, 'admin');
    Livewire\Livewire::test(Kanban::class)
        ->set('workspaceId', $this->ws->id)->call('loadLanes')
        ->set('newName', 'QA review')->call('add')->assertHasNoErrors()
        ->set('lanes.0.name', 'Backlog')->call('save', 0)->assertHasNoErrors();
    expect(KanbanLane::where('workspace_id', $this->ws->id)->where('name', 'QA review')->exists())->toBeTrue();
    expect(KanbanLane::where('workspace_id', $this->ws->id)->where('name', 'Backlog')->exists())->toBeTrue();
    $this->actingAs($this->member, 'admin');
    expect(Kanban::canAccess())->toBeFalse();
});

test('TC-KAN-009 completed reopen resets reminder and reassignment targets current member', function () {
    $ticket = $this->postJson('/api/v1/board/tickets', ticketInput($this), $this->headers)->assertCreated()->json('data');
    $this->travel(2)->minutes();
    (new NotifyDueTickets)->handle();
    $lanes = $this->getJson('/api/v1/board', $this->headers)->json('data.lanes');
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 1, 'lane_id' => $lanes[2]['id']], $this->headers)->assertOk();
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 2, 'lane_id' => $lanes[0]['id'], 'assignee_id' => $this->owner->id], $this->headers)->assertOk();
    (new NotifyDueTickets)->handle();
    (new NotifyDueTickets)->handle();
    expect(InAppNotification::where('type', 'ticket_due')->where('user_id', $this->owner->id)->count())->toBe(1);
    expect(InAppNotification::where('type', 'ticket_due')->count())->toBe(2);
});

test('TC-KAN-008 ticket and comment cursors do not truncate the shared board', function () {
    $ticket = $this->postJson('/api/v1/board/tickets', ticketInput($this), $this->headers)->assertCreated()->json('data');
    for ($i = 2; $i <= 102; $i++) {
        \App\Models\KanbanTicket::create(['workspace_id' => $this->ws->id, 'lane_id' => $ticket['lane_id'], 'number' => $i, 'title' => 'Pagination '.$i]);
    }
    $first = $this->getJson('/api/v1/board/tickets', $this->headers)->assertOk()->assertJsonCount(100, 'data.tickets')->json('data');
    $second = $this->getJson('/api/v1/board/tickets?cursor='.$first['next_cursor'], $this->headers)->assertOk()->assertJsonCount(2, 'data.tickets')->json('data');
    expect(array_intersect(array_column($first['tickets'], 'id'), array_column($second['tickets'], 'id')))->toBe([]);
    for ($i = 0; $i < 52; $i++) {
        KanbanComment::create(['ticket_id' => $ticket['id'], 'author_id' => $this->member->id, 'body' => 'Comment '.$i]);
    }
    $page = $this->getJson('/api/v1/board/tickets/'.$ticket['id'], $this->headers)->assertOk()->assertJsonCount(50, 'data.comments')->json('data');
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'?before='.$page['comments_cursor'], $this->headers)->assertOk()->assertJsonCount(2,'data.comments');
});
