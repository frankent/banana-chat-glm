<?php

use App\Models\KanbanLane;
use App\Models\KanbanTicket;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;

beforeEach(function () {
    $this->owner = User::factory()->create();
    $this->member = User::factory()->create();
    $this->outsider = User::factory()->create();
    $this->ws = Workspace::factory()->create(['slug' => 'card-test']);
    $this->other = Workspace::factory()->create(['slug' => 'card-other']);
    $this->ws->members()->attach($this->owner->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->member->id, ['role' => 'member']);
    $this->other->members()->attach($this->owner->id, ['role' => 'owner']);
    $this->other->members()->attach($this->outsider->id, ['role' => 'member']);
    [, $token] = loginAs($this->owner);
    $this->token = $token;
    $this->headers = wsHeaders($token, 'card-test');
    $this->otherHeaders = wsHeaders($token, 'card-other');
    [, $outsiderToken] = loginAs($this->outsider);
    $this->outsiderHeaders = wsHeaders($outsiderToken, 'card-test');
});

function makeCardTicket($test, array $override = []): array
{
    $lanes = $test->getJson('/api/v1/board', $test->headers)->assertOk()->json('data.lanes');
    $input = array_replace(['title' => 'Fix checkout', 'lane_id' => $lanes[0]['id'], 'assignee_id' => $test->member->id, 'priority' => 'high', 'type' => 'bug', 'description' => 'SECRET-DESCRIPTION', 'due_at' => now()->addDay()->toIso8601String()], $override);

    return $test->postJson('/api/v1/board/tickets', $input, $test->headers)->assertCreated()->json('data');
}

test('TC-KAN-016 card payload is slim and contains no forbidden fields', function () {
    $ticket = makeCardTicket($this);
    $this->postJson('/api/v1/board/tickets/'.$ticket['id'].'/comments', ['body' => 'SECRET-COMMENT'], $this->headers)->assertCreated();
    $res = $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->headers)->assertOk();
    $res->assertHeader('Cache-Control', 'no-store, private');
    $data = $res->json('data');
    expect(array_keys($data))->toEqualCanonicalizing(['id', 'workspace_id', 'number', 'title', 'type', 'priority', 'due_at', 'version', 'updated_at', 'assignee', 'lane']);
    expect($data['id'])->toBe($ticket['id'])->and($data['workspace_id'])->toBe($this->ws->id)
        ->and($data['title'])->toBe('Fix checkout')->and($data['type'])->toBe('bug')->and($data['priority'])->toBe('high')
        ->and($data['version'])->toBe(1)->and($data['number'])->toBe($ticket['number']);
    expect($data['assignee'])->toBe(['id' => $this->member->id, 'display_name' => $this->member->display_name]);
    expect(array_keys($data['lane']))->toEqualCanonicalizing(['id', 'name', 'color', 'is_done'])
        ->and($data['lane']['id'])->toBe($ticket['lane_id'])->and($data['lane']['is_done'])->toBeBool();
    foreach (['description', 'comments', 'history', 'attachments', 'labels', 'reporter', 'reporter_id', 'assignee_id', 'lane_id'] as $key) {
        expect($data)->not->toHaveKey($key);
    }
    $raw = $res->getContent();
    expect($raw)->not->toContain('SECRET-DESCRIPTION')->not->toContain('SECRET-COMMENT')->not->toContain($this->owner->username);
    expect(array_keys($data['assignee']))->toBe(['id', 'display_name']);
});

test('TC-KAN-016 unassigned ticket has null assignee and lane tracks the ticket', function () {
    $ticket = makeCardTicket($this, ['assignee_id' => null]);
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->headers)->assertOk()
        ->assertJsonPath('data.assignee', null)->assertJsonPath('data.lane.id', $ticket['lane_id']);
});

test('TC-KAN-017 foreign-workspace ticket is 404 (no leak), non-member 403, unauthenticated 401', function () {
    $ticket = makeCardTicket($this);
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->otherHeaders)->assertNotFound()->assertDontSee('Fix checkout');
    $this->getJson('/api/v1/board/tickets/01ARZ3NDEKTSV4RRFFQ69G5FAV/card', $this->headers)->assertNotFound();
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->outsiderHeaders)->assertForbidden()->assertJsonPath('error.code', 'WS_FORBIDDEN')->assertDontSee('Fix checkout');
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', ['X-Workspace-Id' => 'card-test'])->assertUnauthorized();
    // Non-ULID id never reaches the controller.
    $this->getJson('/api/v1/board/tickets/not-a-ulid/card', $this->headers)->assertNotFound();
});

test('TC-KAN-018 archived workspace: card behaves like show (WS_ARCHIVED 403 from middleware)', function () {
    $ticket = makeCardTicket($this);
    $this->ws->update(['status' => 'archived']);
    $show = $this->getJson('/api/v1/board/tickets/'.$ticket['id'], $this->headers);
    $card = $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->headers);
    $card->assertForbidden()->assertJsonPath('error.code', 'WS_ARCHIVED')->assertDontSee('Fix checkout');
    expect($card->status())->toBe($show->status())->and($card->json('error.code'))->toBe($show->json('error.code'));
});

test('TC-KAN-019 lane rename and move are reflected and the endpoint creates no default lanes', function () {
    $ticket = makeCardTicket($this);
    $lanes = $this->getJson('/api/v1/board', $this->headers)->json('data.lanes');
    $this->patchJson('/api/v1/board/lanes/'.$lanes[0]['id'], ['name' => 'Renamed lane'], $this->headers)->assertOk();
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->headers)->assertJsonPath('data.lane.name', 'Renamed lane');
    $this->patchJson('/api/v1/board/tickets/'.$ticket['id'], ['version' => 1, 'lane_id' => $lanes[1]['id']], $this->headers)->assertOk();
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->headers)->assertJsonPath('data.lane.id', $lanes[1]['id'])->assertJsonPath('data.version', 2);

    // Read-only: a ticket row inserted without initialising a board must not cause lane/board writes.
    $fresh = Workspace::factory()->create(['slug' => 'card-fresh']);
    $fresh->members()->attach($this->owner->id, ['role' => 'owner']);
    $lane = KanbanLane::create(['workspace_id' => $fresh->id, 'name' => 'Only', 'color' => '#112233', 'position' => 0]);
    $t = KanbanTicket::create(['workspace_id' => $fresh->id, 'lane_id' => $lane->id, 'number' => 1, 'title' => 'x', 'version' => 1]);
    $before = KanbanLane::where('workspace_id', $fresh->id)->count();
    $this->getJson('/api/v1/board/tickets/'.$t->id.'/card', wsHeaders($this->token, 'card-fresh'))->assertOk();
    expect(KanbanLane::where('workspace_id', $fresh->id)->count())->toBe($before);
    expect(DB::table('kanban_boards')->where('workspace_id', $fresh->id)->exists())->toBeFalse();
});

test('TC-KAN-020 board-card limiter is registered and applied to the route', function () {
    $route = collect(Route::getRoutes()->getRoutes())->first(fn ($r) => $r->uri() === 'api/v1/board/tickets/{id}/card');
    expect($route)->not->toBeNull()->and($route->gatherMiddleware())->toContain('throttle:board-card');
    expect(RateLimiter::limiter('board-card'))->not->toBeNull();
    $limit = RateLimiter::limiter('board-card')(request());
    expect($limit->maxAttempts)->toBe(240)->and($limit->decaySeconds)->toBe(60);
});

test('TC-KAN-016 query count is bounded (no N+1, constant)', function () {
    $ticket = makeCardTicket($this);
    DB::enableQueryLog();
    $this->getJson('/api/v1/board/tickets/'.$ticket['id'].'/card', $this->headers)->assertOk();
    $count = count(DB::getQueryLog());
    DB::disableQueryLog();
    // auth/token + workspace + membership + ticket + assignee + lane (+ token touch); fixed ceiling.
    expect($count)->toBeLessThanOrEqual(12);
});
