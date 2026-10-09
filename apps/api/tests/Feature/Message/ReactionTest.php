<?php

use App\Domain\Message\MessageSerializer;
use App\Enums\RoomRole;
use App\Events\MessageReactionsChanged;
use App\Events\MessageUpdated;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Support\ReactionEmoji;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;

/**
 * TC-MSG-072..083 — message reactions (FR-MSG-012, API-237..239, EVT-089, DEC-098).
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony', 'display_name' => 'Tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai', 'display_name' => 'Somchai']);
    $this->anna = User::factory()->create(['username' => 'anna', 'display_name' => 'Anna']);
    $this->outsider = User::factory()->create(['username' => 'outsider']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    foreach ([$this->tony, $this->somchai, $this->anna, $this->outsider] as $i => $user) {
        $this->ws->members()->attach($user->id, ['role' => $i === 0 ? 'owner' : 'member']);
    }

    $this->room = rxRoom($this->ws, [$this->tony, $this->somchai, $this->anna]);
    $this->other = rxRoom($this->ws, [$this->tony]);

    [, $this->tTok] = loginAs($this->tony);
    [, $this->sTok] = loginAs($this->somchai);
    [, $this->aTok] = loginAs($this->anna);
    [, $this->oTok] = loginAs($this->outsider);

    $this->msg = rxSend($this, $this->tTok, $this->room->id, 'hello');
});

function rxRoom(Workspace $ws, array $members, array $extra = []): Room
{
    $room = Room::query()->create([
        'workspace_id' => $ws->id, 'type' => 'group', 'name' => 'R'.Str::random(4),
        'created_by' => $members[0]->id, 'owner_id' => $members[0]->id,
        'member_count' => count($members), 'last_message_at' => now(),
    ] + $extra);
    foreach ($members as $i => $user) {
        RoomMember::query()->create([
            'room_id' => $room->id, 'user_id' => $user->id, 'workspace_id' => $ws->id,
            'role' => $i === 0 ? RoomRole::Owner : RoomRole::Member, 'added_by' => $members[0]->id,
        ]);
    }

    return $room;
}

function rxSend($t, string $token, string $roomId, string $body): array
{
    return $t->postJson("/api/v1/rooms/{$roomId}/messages", ['client_message_id' => (string) Str::uuid(), 'body' => $body], wsHeaders($token, 'acme'))
        ->assertStatus(201)->json('data.message');
}

function rxPut($t, string $token, string $roomId, string $messageId, mixed $emoji)
{
    return $t->putJson("/api/v1/rooms/{$roomId}/messages/{$messageId}/reactions", ['emoji' => $emoji], wsHeaders($token, 'acme'));
}

function rxDelete($t, string $token, string $roomId, string $messageId)
{
    return $t->deleteJson("/api/v1/rooms/{$roomId}/messages/{$messageId}/reactions", [], wsHeaders($token, 'acme'));
}

function rxList($t, string $token, string $roomId): array
{
    return $t->getJson("/api/v1/rooms/{$roomId}/messages", wsHeaders($token, 'acme'))->assertOk()->json('data.messages');
}

// TC-MSG-072 — set, per-viewer my_reaction, deterministic order
it('TC-MSG-072 sets a reaction and lists it with per-viewer my_reaction', function () {
    rxPut($this, $this->sTok, $this->room->id, $this->msg['id'], '👍')->assertOk()
        ->assertExactJson(['data' => ['message_id' => $this->msg['id'], 'reactions' => [['emoji' => '👍', 'count' => 1]], 'my_reaction' => '👍']]);
    rxPut($this, $this->aTok, $this->room->id, $this->msg['id'], '👍')->assertOk();
    rxPut($this, $this->aTok, $this->room->id, $this->msg['id'], '❤')->assertOk(); // replaces, canonicalised

    $mine = rxList($this, $this->sTok, $this->room->id)[0];
    expect($mine['reactions'])->toBe([['emoji' => "❤\u{FE0F}", 'count' => 1], ['emoji' => '👍', 'count' => 1]]) // equal counts: U+2764 < U+1F44D
        ->and($mine['my_reaction'])->toBe('👍');
    $tony = rxList($this, $this->tTok, $this->room->id)[0];
    expect($tony['my_reaction'])->toBeNull()->and($tony['reactions'])->toHaveCount(2);
});

// TC-MSG-073 — replace + toggle off + idempotency + events only on change
it('TC-MSG-073 replaces, removes and is idempotent; broadcasts only real changes', function () {
    Event::fake([MessageReactionsChanged::class]);
    $r = $this->room->id;
    $m = $this->msg['id'];

    rxPut($this, $this->sTok, $r, $m, '👍')->assertOk();
    rxPut($this, $this->sTok, $r, $m, '👍')->assertOk(); // no-op
    rxPut($this, $this->sTok, $r, $m, '😂')->assertOk()->assertJsonPath('data.reactions', [['emoji' => '😂', 'count' => 1]]);
    rxDelete($this, $this->sTok, $r, $m)->assertOk()->assertJsonPath('data.reactions', [])->assertJsonPath('data.my_reaction', null);
    rxDelete($this, $this->sTok, $r, $m)->assertOk(); // no-op

    Event::assertDispatchedTimes(MessageReactionsChanged::class, 3);
    Event::assertDispatched(MessageReactionsChanged::class, fn ($e) => $e->actorId === $this->somchai->id && $e->actorEmoji === '😂'
        && $e->reactions === [['emoji' => '😂', 'count' => 1]]);
    expect(DB::table('message_reactions')->where('message_id', $m)->count())->toBe(0);
});

// TC-MSG-074 — EVT-089 carries no per-viewer data; other events carry no reaction keys
it('TC-MSG-074 EVT-089 payload is viewer-free and message events omit reaction keys', function () {
    $evt = new MessageReactionsChanged($this->room, $this->msg['id'], [['emoji' => '👍', 'count' => 2]], $this->somchai->id, '👍');
    $payload = $evt->broadcastWith();
    expect($payload['event'])->toBe('message.reactions_changed')
        ->and($payload['data'])->toBe([
            'room_id' => $this->room->id, 'message_id' => $this->msg['id'],
            'reactions' => [['emoji' => '👍', 'count' => 2]], 'actor_id' => $this->somchai->id, 'actor_emoji' => '👍',
        ])
        ->and($evt->broadcastOn()[0]->name)->toBe('private-room.'.$this->room->id);

    rxPut($this, $this->sTok, $this->room->id, $this->msg['id'], '👍')->assertOk();
    $forEvent = MessageSerializer::forEvent(Message::findOrFail($this->msg['id']));
    expect($forEvent)->not->toHaveKey('reactions')->not->toHaveKey('my_reaction');

    // the real edit broadcast (EVT-011) too — nobody may pass the overlay into it later
    Event::fake([MessageUpdated::class]);
    $this->patchJson("/api/v1/messages/{$this->msg['id']}", ['body' => 'edited'], wsHeaders($this->tTok, 'acme'))->assertOk();
    Event::assertDispatched(MessageUpdated::class, fn ($e) => ! array_key_exists('reactions', $e->message) && ! array_key_exists('my_reaction', $e->message));
});

// TC-MSG-075 — validation
it('TC-MSG-075 rejects anything that is not exactly one emoji', function (mixed $bad) {
    rxPut($this, $this->sTok, $this->room->id, $this->msg['id'], $bad)->assertStatus(422)->assertJsonPath('error.code', 'REACTION_INVALID');
    expect(DB::table('message_reactions')->count())->toBe(0);
})->with([[''], [null], ['a'], ['12'], ['👍👍'], ['👍a'], [['👍']], [str_repeat('👍', 40)], ['‍'], ['#'],
    ["👍\u{0301}"], ['👍'.str_repeat("\u{0301}", 30)], ["👍\u{E0068}\u{E0069}"], ["👍\u{FE0F}\u{FE0F}"],
    ["👍\u{20E3}"], ["☝\u{FE0F}🏽"], ['🏽'], ['👍🏽🏽'], ["🏴\u{E0067}\u{E0062}"], ["🏴\u{E0067}\u{E007F}\u{E0062}"]]);

// Laravel's TrimStrings strips an edge ZWJ before the controller sees it, so over HTTP it can only ever land as the plain emoji.
it('TC-MSG-075 an edge ZWJ never becomes a look-alike second chip', function () {
    rxPut($this, $this->sTok, $this->room->id, $this->msg['id'], "👍\u{200D}")->assertOk()->assertJsonPath('data.my_reaction', '👍');
    expect(DB::table('message_reactions')->pluck('emoji')->all())->toBe(['👍']);
});

it('TC-MSG-075 normalises emoji', function () {
    expect(ReactionEmoji::normalize("👍\n"))->toBeNull()
        ->and(ReactionEmoji::normalize("👍\u{200D}"))->toBeNull()
        ->and(ReactionEmoji::normalize("\u{200D}👍"))->toBeNull()
        ->and(ReactionEmoji::normalize("\xC3\x28"))->toBeNull()
        ->and(ReactionEmoji::normalize('❤'))->toBe("❤\u{FE0F}")
        ->and(ReactionEmoji::normalize("❤\u{FE0F}"))->toBe("❤\u{FE0F}")
        ->and(ReactionEmoji::normalize("1\u{20E3}"))->toBe("1\u{FE0F}\u{20E3}")
        ->and(ReactionEmoji::normalize('🇹🇭'))->toBe('🇹🇭')
        ->and(ReactionEmoji::normalize('👍🏽'))->toBe('👍🏽')
        ->and(ReactionEmoji::normalize('👨‍👩‍👧‍👦'))->toBe('👨‍👩‍👧‍👦')
        ->and(ReactionEmoji::normalize('🏴󠁧󠁢󠁥󠁮󠁧󠁿'))->toBe('🏴󠁧󠁢󠁥󠁮󠁧󠁿')
        ->and(ReactionEmoji::normalize('🙏'))->toBe('🙏')
        ->and(ReactionEmoji::normalize('☕'))->toBe("☕\u{FE0F}")
        ->and(ReactionEmoji::normalize("✍\u{FE0F}"))->toBe("✍\u{FE0F}")
        ->and(ReactionEmoji::normalize('☝🏽'))->toBe('☝🏽')
        ->and(ReactionEmoji::normalize("👩\u{200D}❤\u{FE0F}\u{200D}👨"))->toBe("👩\u{200D}❤\u{FE0F}\u{200D}👨")
        ->and(ReactionEmoji::normalize("🏳\u{FE0F}\u{200D}🌈"))->toBe("🏳\u{FE0F}\u{200D}🌈");
});

// TC-MSG-076 — 20 distinct emoji cap
it('TC-MSG-076 caps distinct emoji per message but still lets people join an existing one', function () {
    $m = $this->msg['id'];
    $pool = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙'];
    foreach ($pool as $e) {
        DB::table('message_reactions')->insert(['message_id' => $m, 'user_id' => $this->anna->id, 'emoji' => $e]);
    }
    rxPut($this, $this->sTok, $this->room->id, $m, '🔥')->assertStatus(422)->assertJsonPath('error.code', 'REACTION_LIMIT');
    rxPut($this, $this->sTok, $this->room->id, $m, '😀')->assertOk();
    // a replacement frees the slot of an emoji only the caller used
    DB::table('message_reactions')->where('user_id', $this->anna->id)->where('emoji', '😃')->delete(); // 19 distinct
    rxPut($this, $this->tTok, $this->room->id, $m, '🙌')->assertOk()->assertJsonPath('data.my_reaction', '🙌'); // 20
    rxPut($this, $this->tTok, $this->room->id, $m, '😃')->assertOk()->assertJsonPath('data.my_reaction', '😃'); // swap, still 20
    expect(DB::table('message_reactions')->where('message_id', $m)->distinct()->count('emoji'))->toBe(20);
});

// TC-MSG-077 — guards
it('TC-MSG-077 enforces membership, room scope, deleted and system messages', function () {
    $r = $this->room->id;
    $m = $this->msg['id'];
    rxPut($this, $this->oTok, $r, $m, '👍')->assertStatus(403)->assertJsonPath('error.code', 'ROOM_NOT_MEMBER');
    rxPut($this, $this->tTok, $this->other->id, $m, '👍')->assertNotFound();

    $system = rxSend($this, $this->tTok, $r, 'sys');
    Message::whereKey($system['id'])->update(['type' => 'system']);
    rxPut($this, $this->tTok, $r, $system['id'], '👍')->assertStatus(422)->assertJsonPath('error.code', 'REACTION_INVALID');

    $gone = rxSend($this, $this->tTok, $r, 'gone');
    Message::whereKey($gone['id'])->update(['deleted_at' => now()]);
    rxPut($this, $this->tTok, $r, $gone['id'], '👍')->assertNotFound();
    rxDelete($this, $this->tTok, $r, $gone['id'])->assertNotFound();
    $this->getJson("/api/v1/rooms/{$r}/messages/{$gone['id']}/reactions", wsHeaders($this->tTok, 'acme'))->assertNotFound();
});

it('TC-MSG-077 former members cannot react but their old reactions still count', function () {
    $m = $this->msg['id'];
    rxPut($this, $this->sTok, $this->room->id, $m, '👍')->assertOk();
    RoomMember::where('room_id', $this->room->id)->where('user_id', $this->somchai->id)->update(['left_at' => now()]);
    rxPut($this, $this->sTok, $this->room->id, $m, '😂')->assertStatus(403);
    expect(rxList($this, $this->tTok, $this->room->id)[0]['reactions'])->toBe([['emoji' => '👍', 'count' => 1]]);
});

it('TC-MSG-078 expired secret room answers 410 on all three endpoints', function () {
    $secret = rxRoom($this->ws, [$this->tony], ['is_secret' => true, 'secret_expires_at' => now()->addHour()]);
    $m = rxSend($this, $this->tTok, $secret->id, 'psst');
    rxPut($this, $this->tTok, $secret->id, $m['id'], '🙏')->assertOk(); // active secret room allowed
    $secret->update(['secret_expires_at' => now()->subMinute()]);
    rxPut($this, $this->tTok, $secret->id, $m['id'], '👍')->assertStatus(410)->assertJsonPath('error.code', 'ROOM_EXPIRED');
    rxDelete($this, $this->tTok, $secret->id, $m['id'])->assertStatus(410);
    $this->getJson("/api/v1/rooms/{$secret->id}/messages/{$m['id']}/reactions", wsHeaders($this->tTok, 'acme'))->assertStatus(410);
});

// TC-MSG-079 — who reacted
it('TC-MSG-079 lists reactors per emoji ordered by name, counting everyone', function () {
    $m = $this->msg['id'];
    rxPut($this, $this->sTok, $this->room->id, $m, '👍');
    rxPut($this, $this->aTok, $this->room->id, $m, '👍');
    rxPut($this, $this->tTok, $this->room->id, $m, '🙏');
    $res = $this->getJson("/api/v1/rooms/{$this->room->id}/messages/{$m}/reactions", wsHeaders($this->tTok, 'acme'))->assertOk();
    expect($res->json('data.reactions.0.emoji'))->toBe('👍')
        ->and($res->json('data.reactions.0.count'))->toBe(2)
        ->and(array_column($res->json('data.reactions.0.users'), 'display_name'))->toBe(['Anna', 'Somchai'])
        ->and($res->json('data.reactions.0.users.0'))->toHaveKeys(['id', 'username', 'display_name', 'avatar_attachment_id', 'avatar'])
        ->and($res->json('data.reactions.1.users.0.display_name'))->toBe('Tony');
});

// TC-MSG-080 — ordering ties
it('TC-MSG-080 orders by count DESC then emoji ASC', function () {
    $m = $this->msg['id'];
    rxPut($this, $this->sTok, $this->room->id, $m, '🙏');
    rxPut($this, $this->aTok, $this->room->id, $m, '👍');
    rxPut($this, $this->tTok, $this->room->id, $m, '🙏');
    expect(array_column(rxList($this, $this->tTok, $this->room->id)[0]['reactions'], 'emoji'))->toBe(['🙏', '👍']);
});

// TC-MSG-081 — deleted tombstone, send/edit responses, pins
it('TC-MSG-081 tombstones hide reactions; send, edit and pins responses carry the viewer overlay', function () {
    $m = $this->msg['id'];
    expect($this->msg)->toHaveKey('reactions', [])->toHaveKey('my_reaction', null);
    rxPut($this, $this->tTok, $this->room->id, $m, '🔥')->assertOk();

    $edited = $this->patchJson("/api/v1/messages/{$m}", ['body' => 'edited'], wsHeaders($this->tTok, 'acme'))->assertOk()->json('data.message');
    expect($edited['my_reaction'])->toBe('🔥')->and($edited['reactions'])->toBe([['emoji' => '🔥', 'count' => 1]]);

    $this->putJson("/api/v1/rooms/{$this->room->id}/pins/{$m}", [], wsHeaders($this->tTok, 'acme'))->assertOk();
    $pins = $this->getJson("/api/v1/rooms/{$this->room->id}/pins", wsHeaders($this->sTok, 'acme'))->assertOk()->json('data');
    expect($pins[0]['reactions'])->toBe([['emoji' => '🔥', 'count' => 1]])->and($pins[0]['my_reaction'])->toBeNull();

    $this->deleteJson("/api/v1/messages/{$m}", [], wsHeaders($this->tTok, 'acme'))->assertNoContent();
    $row = rxList($this, $this->tTok, $this->room->id)[0];
    expect($row['reactions'])->toBe([])->and($row['my_reaction'])->toBeNull();
});

// TC-MSG-082 — one grouped query per page
it('TC-MSG-082 loads reactions for a whole page with a fixed number of queries', function () {
    foreach (range(1, 12) as $i) {
        $x = rxSend($this, $this->tTok, $this->room->id, "m{$i}");
        rxPut($this, $this->sTok, $this->room->id, $x['id'], '👍');
    }
    DB::enableQueryLog();
    rxList($this, $this->tTok, $this->room->id);
    $reactionQueries = collect(DB::getQueryLog())->filter(fn ($q) => str_contains($q['query'], 'message_reactions'))->count();
    DB::disableQueryLog();
    expect($reactionQueries)->toBe(2);
});

it('TC-MSG-083 requires authentication and ULID route params', function () {
    $this->putJson("/api/v1/rooms/{$this->room->id}/messages/{$this->msg['id']}/reactions", ['emoji' => '👍'])->assertUnauthorized();
    $this->putJson("/api/v1/rooms/nope/messages/{$this->msg['id']}/reactions", ['emoji' => '👍'], wsHeaders($this->tTok, 'acme'))->assertNotFound();
});
