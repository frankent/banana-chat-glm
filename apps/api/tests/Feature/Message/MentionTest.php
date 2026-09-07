<?php

use App\Domain\Message\MentionParser;
use App\Enums\RoomRole;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * FR-MSG-008 / API-044 — mentions (TC-MSG-049..054).
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai']);
    $this->outsider = User::factory()->create(['username' => 'outsider']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);
    $this->ws->members()->attach($this->outsider->id, ['role' => 'member']);

    $this->room = Room::query()->create([
        'workspace_id' => $this->ws->id,
        'type' => 'group',
        'name' => 'Engineering',
        'created_by' => $this->tony->id,
        'owner_id' => $this->tony->id,
        'member_count' => 2,
        'last_message_at' => now(),
    ]);

    foreach ([[$this->tony, RoomRole::Owner], [$this->somchai, RoomRole::Member]] as [$user, $role]) {
        RoomMember::query()->create([
            'room_id' => $this->room->id,
            'user_id' => $user->id,
            'workspace_id' => $this->ws->id,
            'role' => $role,
            'added_by' => $this->tony->id,
        ]);
    }

    [, $this->tonyToken] = loginAs($this->tony);
    [, $this->somchaiToken] = loginAs($this->somchai);
    [, $this->outsiderToken] = loginAs($this->outsider);
});

function sendMention($test, string $token, string $roomId, string $body): array
{
    $res = $test->postJson("/api/v1/rooms/{$roomId}/messages", [
        'client_message_id' => (string) Str::uuid(),
        'body' => $body,
    ], wsHeaders($token, 'acme'))->assertStatus(201)->json('data.message');

    return $res;
}

// ---- TC-MSG-049 parser (unit-ish through the send path) ----

test('TC-MSG-049 @tony and @a.b parse; emails do not', function () {
    $parser = app(MentionParser::class);

    [$users, $all] = $parser->parse('hey @tony look at kiat@gmail.com and @a.b too @all @tony');
    expect($users)->toBe(['tony', 'a.b'])
        ->and($all)->toBeTrue();

    [$users2, $all2] = $parser->parse('no mentions here, plain text');
    expect($users2)->toBe([])
        ->and($all2)->toBeFalse();
});

// ---- TC-MSG-050 non-member mention ignored ----

test('TC-MSG-050 mentioning a non-room-member is not recorded', function () {
    $message = sendMention($this, $this->tonyToken, $this->room->id, 'ping @outsider and @somchai');

    expect($message['mentions'])->toBe([$this->somchai->id]);
    expect(DB::table('message_mentions')->where('user_id', $this->outsider->id)->doesntExist())->toBeTrue();
});

test('mentions ride on the message payload (send + history)', function () {
    $message = sendMention($this, $this->tonyToken, $this->room->id, 'yo @somchai');

    expect($message['mentions'])->toBe([$this->somchai->id]);

    $page = $this->getJson("/api/v1/rooms/{$this->room->id}/messages", wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.messages');
    expect(collect($page)->firstWhere('id', $message['id'])['mentions'])->toBe([$this->somchai->id]);
});

// ---- TC-MSG-051 @all rules ----

test('TC-MSG-051 @all by a plain member in a >20 room is ignored; owner @all expands', function () {
    // grow the room past 20 members
    for ($i = 0; $i < 20; $i++) {
        $extra = User::factory()->create(['username' => "bulk{$i}"]);
        $this->ws->members()->attach($extra->id, ['role' => 'member']);
        RoomMember::query()->create([
            'room_id' => $this->room->id,
            'user_id' => $extra->id,
            'workspace_id' => $this->ws->id,
            'role' => RoomRole::Member,
            'added_by' => $this->tony->id,
        ]);
    }
    $this->room->update(['member_count' => 22]);

    $ignored = sendMention($this, $this->somchaiToken, $this->room->id, 'attention @all');
    expect($ignored['mentions'])->toBe([]);

    $owner = sendMention($this, $this->tonyToken, $this->room->id, 'attention @all');
    // every active member except the sender
    expect(count($owner['mentions']))->toBe(21)
        ->and(in_array($this->tony->id, $owner['mentions'], true))->toBeFalse()
        ->and(in_array($this->somchai->id, $owner['mentions'], true))->toBeTrue();
});

test('@all in a small room works for a plain member', function () {
    $message = sendMention($this, $this->somchaiToken, $this->room->id, 'heads up @all');
    expect($message['mentions'])->toBe([$this->tony->id]); // sender excluded
});

// ---- TC-MSG-053 edit re-parses ----

test('TC-MSG-053 editing a message re-parses mentions', function () {
    $message = sendMention($this, $this->tonyToken, $this->room->id, 'hi @somchai');

    // edit: mention gone
    $this->patchJson("/api/v1/messages/{$message['id']}", ['body' => 'no mentions now'], wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.message');
    expect(DB::table('message_mentions')->where('message_id', $message['id'])->count())->toBe(0);

    // edit again: mention back
    $res = $this->patchJson("/api/v1/messages/{$message['id']}", ['body' => 'again @somchai'], wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.message');
    expect($res['mentions'])->toBe([$this->somchai->id]);
});

// ---- TC-MSG-054 /me/mentions ----

test('TC-MSG-054 /me/mentions newest→oldest with cursor, ws-scoped, deleted excluded', function () {
    // somchai's view: tony mentions him twice; one older message mentions tony (not somchai)
    $first = sendMention($this, $this->tonyToken, $this->room->id, 'one @somchai');
    usleep(1100_000); // distinct created_at (Postgres microsecond precision)
    $second = sendMention($this, $this->tonyToken, $this->room->id, 'two @somchai');
    sendMention($this, $this->somchaiToken, $this->room->id, 'reply @tony');

    // other workspace's mention must not leak (workspace scoping)
    $otherWs = Workspace::factory()->create(['slug' => 'globex']);
    $otherWs->members()->attach($this->somchai->id, ['role' => 'member']);

    $page = $this->getJson('/api/v1/me/mentions', wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk()
        ->json('data');

    expect(count($page['messages']))->toBe(2)
        ->and($page['messages'][0]['id'])->toBe($second['id'])
        ->and($page['messages'][1]['id'])->toBe($first['id']);

    // cursor past the newest → only the older one
    $page2 = $this->getJson('/api/v1/me/mentions?cursor='.$second['id'], wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk()
        ->json('data.messages');
    expect(count($page2))->toBe(1)
        ->and($page2[0]['id'])->toBe($first['id']);

    // deleted mention drops out
    $this->deleteJson("/api/v1/messages/{$second['id']}", [], wsHeaders($this->tonyToken, 'acme'))->assertStatus(204);
    $page3 = $this->getJson('/api/v1/me/mentions', wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk()
        ->json('data.messages');
    expect(count($page3))->toBe(1)
        ->and($page3[0]['id'])->toBe($first['id']);
});

test('has_mentions flips in /me/workspaces', function () {
    expect(collect($this->getJson('/api/v1/me/workspaces', wsHeaders($this->somchaiToken, 'acme'))->json('data.*.has_mentions')))->toContain(false);

    sendMention($this, $this->tonyToken, $this->room->id, 'check this @somchai');

    expect(collect($this->getJson('/api/v1/me/workspaces', wsHeaders($this->somchaiToken, 'acme'))->json('data.*.has_mentions')))->toContain(true);
});

test('has_mentions clears after reading past the mention', function () {
    sendMention($this, $this->tonyToken, $this->room->id, 'read me @somchai');

    // somchai reads to the latest seq
    $room = $this->room->refresh();
    $this->postJson("/api/v1/rooms/{$this->room->id}/read", ['seq' => $room->last_seq], wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk();

    expect(collect($this->getJson('/api/v1/me/workspaces', wsHeaders($this->somchaiToken, 'acme'))->json('data.*.has_mentions')))->toContain(false);
});
