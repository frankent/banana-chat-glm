<?php

use App\Enums\RoomRole;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * FR-SRCH-001/002 — message + file search (TC-SRCH-001..012).
 */
beforeEach(function () {
    $this->tony = User::factory()->create(['username' => 'tony']);
    $this->somchai = User::factory()->create(['username' => 'somchai']);
    $this->outsider = User::factory()->create(['username' => 'outsider']);

    $this->ws = Workspace::factory()->create(['slug' => 'acme']);
    $this->ws->members()->attach($this->tony->id, ['role' => 'owner']);
    $this->ws->members()->attach($this->somchai->id, ['role' => 'member']);
    $this->ws->members()->attach($this->outsider->id, ['role' => 'member']);

    $this->room = srchRoom($this, 'Engineering', [$this->tony, $this->somchai]);

    [, $this->tonyToken] = loginAs($this->tony);
    [, $this->somchaiToken] = loginAs($this->somchai);
    [, $this->outsiderToken] = loginAs($this->outsider);
});

function srchRoom($test, string $name, array $members, ?Workspace $ws = null): Room
{
    $ws ??= $test->ws;

    $room = Room::query()->create([
        'workspace_id' => $ws->id,
        'type' => 'group',
        'name' => $name,
        'created_by' => $test->tony->id,
        'owner_id' => $test->tony->id,
        'member_count' => count($members),
        'last_message_at' => now(),
    ]);

    foreach ($members as $member) {
        RoomMember::query()->create([
            'room_id' => $room->id,
            'user_id' => $member->id,
            'workspace_id' => $ws->id,
            'role' => RoomRole::Member,
            'added_by' => $test->tony->id,
        ]);
    }

    return $room;
}

function srchMessage($test, Room $room, User $sender, string $body, array $extra = []): Message
{
    static $seq = 0;
    $seq++;

    $message = Message::query()->create([
        'room_id' => $room->id,
        'workspace_id' => $room->workspace_id,
        'sender_id' => $sender->id,
        'seq' => $seq,
        'type' => 'text',
        'body' => $body,
        'client_message_id' => (string) Str::uuid(),
        ...array_diff_key($extra, ['created_at' => null]),
    ]);

    if (isset($extra['created_at'])) { // not mass-assignable → force
        $message->forceFill(['created_at' => $extra['created_at']])->save();
    }

    return $message->refresh();
}

function srchAttach($test, Message $message, string $name, string $kind = 'file', ?string $status = 'ready'): Attachment
{
    $attachment = Attachment::query()->create([
        'workspace_id' => $message->workspace_id,
        'uploader_id' => $message->sender_id,
        'kind' => $kind,
        'status' => $status,
        'original_name' => $name,
        'mime_type' => 'application/pdf',
        'size_bytes' => 1024,
        'storage_key' => 'att/'.Str::uuid(),
    ]);
    DB::table('message_attachments')->insert([
        'message_id' => $message->id,
        'attachment_id' => $attachment->id,
        'position' => 0,
    ]);

    return $attachment;
}

// ---- message search ----

test('TC-SRCH-001 English FTS finds the message, returns room + highlight', function () {
    srchMessage($this, $this->room, $this->tony, 'the deployment pipeline is broken');
    srchMessage($this, $this->room, $this->somchai, 'unrelated chatter');

    $res = $this->getJson('/api/v1/search/messages?q=deployment', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.results');

    expect($res)->toHaveCount(1)
        ->and($res[0]['message']['body'])->toBe('the deployment pipeline is broken')
        ->and($res[0]['room']['id'])->toBe($this->room->id)
        ->and($res[0]['highlight'])->toContain('<mark>deployment</mark>');
});

test('TC-SRCH-002 Thai substring via trgm: "ประชุม" matches "นัดประชุมพรุ่งนี้"', function () {
    srchMessage($this, $this->room, $this->tony, 'นัดประชุมพรุ่งนี้');
    srchMessage($this, $this->room, $this->tony, 'ไปกินข้าวกันไหม');

    $res = $this->getJson('/api/v1/search/messages?'.http_build_query(['q' => 'ประชุม']), wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.results');

    expect($res)->toHaveCount(1)
        ->and($res[0]['message']['body'])->toBe('นัดประชุมพรุ่งนี้')
        ->and($res[0]['highlight'])->toContain('<mark>ประชุม</mark>');
});

test('TC-SRCH-003 non-member room, deleted room, deleted message never match', function () {
    $secret = srchRoom($this, 'Secret', [$this->tony]); // somchai NOT a member
    srchMessage($this, $secret, $this->tony, 'secret roadmap hidden');

    $deletedRoom = srchRoom($this, 'Doomed', [$this->tony, $this->somchai]);
    $deletedRoom->forceFill(['deleted_at' => now()])->save();
    srchMessage($this, $deletedRoom, $this->tony, 'roadmap in deleted room');

    $deletedMessage = srchMessage($this, $this->room, $this->tony, 'roadmap but deleted');
    $deletedMessage->forceFill(['deleted_at' => now()])->save();

    srchMessage($this, $this->room, $this->tony, 'visible roadmap here');

    $res = $this->getJson('/api/v1/search/messages?q=roadmap', wsHeaders($this->somchaiToken, 'acme'))
        ->assertOk()
        ->json('data.results');

    // somchai sees only the message in the room they belong to
    expect($res)->toHaveCount(1)
        ->and($res[0]['message']['body'])->toBe('visible roadmap here');
});

test('TC-SRCH-004 room_id/sender_id/from/to/type filters compose', function () {
    $other = srchRoom($this, 'Random', [$this->tony, $this->somchai]);

    $old = srchMessage($this, $this->room, $this->tony, 'kickoff deployment notes', ['created_at' => now()->subDays(3)]);
    srchMessage($this, $this->room, $this->somchai, 'somchai deployment notes');
    srchMessage($this, $other, $this->tony, 'deployment in the other room');
    srchMessage($this, $this->room, $this->tony, 'image deployment', ['type' => 'image']);

    $query = fn (array $params) => $this->getJson('/api/v1/search/messages?'.http_build_query(['q' => 'deployment', ...$params]), wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data.results');

    expect($query(['room_id' => $this->room->id]))->toHaveCount(3)
        ->and($query(['sender_id' => $this->somchai->id]))->toHaveCount(1)
        ->and($query(['from' => now()->subDay()->toIso8601String(), 'to' => now()->addDay()->toIso8601String()]))->toHaveCount(3)
        ->and($query(['type' => 'image']))->toHaveCount(1);

    expect($old->fresh()->created_at->isSameDay(now()->subDays(3)))->toBeTrue();
});

test('TC-SRCH-005 highlight escapes HTML instead of injecting it', function () {
    srchMessage($this, $this->room, $this->tony, 'urgent <script>alert(1)</script> & "quotes"');

    $res = $this->getJson('/api/v1/search/messages?q=urgent', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()
        ->json('data.results.0.highlight');

    expect($res)->toContain('&lt;script&gt;')
        ->and($res)->toContain('&amp;')
        ->and($res)->not->toContain('<script>');
});

test('TC-SRCH-006 q shorter than 2 chars → 422', function () {
    $this->getJson('/api/v1/search/messages?q=a', wsHeaders($this->tonyToken, 'acme'))
        ->assertStatus(422);
});

test('TC-SRCH-007 cursor pagination is stable and non-overlapping', function () {
    for ($i = 1; $i <= 30; $i++) {
        srchMessage($this, $this->room, $this->tony, "deployment note {$i}");
    }

    $page1 = $this->getJson('/api/v1/search/messages?q=deployment', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data');

    expect(count($page1['results']))->toBe(25)
        ->and($page1['next_cursor'])->not->toBeNull();

    $page2 = $this->getJson('/api/v1/search/messages?q=deployment&cursor='.urlencode($page1['next_cursor']), wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data');

    expect(count($page2['results']))->toBe(5)
        ->and($page2['next_cursor'])->toBeNull();

    $ids1 = array_column($page1['results'], 'message');
    $ids1 = array_column($ids1, 'id');
    $ids2 = array_column($page2['results'], 'message');
    $ids2 = array_column($ids2, 'id');
    expect(array_intersect($ids1, $ids2))->toBe([]);
});

test('TC-SRCH-008 search stays inside the workspace boundary', function () {
    $otherWs = Workspace::factory()->create(['slug' => 'beta']);
    $otherWs->members()->attach($this->outsider->id, ['role' => 'owner']);
    $otherWs->members()->attach($this->tony->id, ['role' => 'member']);

    $otherRoom = srchRoom($this, 'Beta Room', [$this->outsider, $this->tony], $otherWs);
    srchMessage($this, $otherRoom, $this->outsider, 'cross workspace secrets');

    srchMessage($this, $this->room, $this->tony, 'in acme workspace');

    $res = $this->getJson('/api/v1/search/messages?q=workspace', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data.results');

    expect($res)->toHaveCount(1)
        ->and($res[0]['room']['workspace_id'])->toBe($this->ws->id);
});

// ---- file search ----

test('TC-SRCH-009 files match original_name in Thai and English', function () {
    srchAttach($this, srchMessage($this, $this->room, $this->tony, 'doc 1'), 'แผนการประชุม.pdf');
    srchAttach($this, srchMessage($this, $this->room, $this->tony, 'doc 2'), 'quarterly-report.pdf');
    srchAttach($this, srchMessage($this, $this->room, $this->tony, 'doc 3'), 'photo.png', 'image');

    $thai = $this->getJson('/api/v1/search/files?'.http_build_query(['q' => 'ประชุม']), wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data.results');
    $eng = $this->getJson('/api/v1/search/files?q=report', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data.results');

    expect($thai)->toHaveCount(1)
        ->and($thai[0]['attachment']['original_name'])->toBe('แผนการประชุม.pdf')
        ->and($thai[0]['message']['room_id'])->toBe($this->room->id)
        ->and($thai[0]['room']['name'])->toBe('Engineering')
        ->and($eng)->toHaveCount(1);
});

test('TC-SRCH-010 kind filter narrows to image|video|file', function () {
    srchAttach($this, srchMessage($this, $this->room, $this->tony, 'm1'), 'chart.png', 'image');
    srchAttach($this, srchMessage($this, $this->room, $this->tony, 'm2'), 'intro.mp4', 'video');
    srchAttach($this, srchMessage($this, $this->room, $this->tony, 'm3'), 'contract.pdf', 'file');

    $images = $this->getJson('/api/v1/search/files?q=.&kind=image', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data.results');

    expect(array_column(array_column($images, 'attachment'), 'kind'))->toBe(['image']);
});

test('TC-SRCH-011 attachments of deleted messages (and pending files) never match', function () {
    $deletedMsg = srchMessage($this, $this->room, $this->tony, 'has file');
    srchAttach($this, $deletedMsg, 'deleted-message-file.pdf');
    $deletedMsg->forceFill(['deleted_at' => now()])->save();

    $pendingMsg = srchMessage($this, $this->room, $this->tony, 'pending file');
    srchAttach($this, $pendingMsg, 'still-scanning.pdf', 'file', 'pending');

    $res = $this->getJson('/api/v1/search/files?q=file', wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data.results');

    expect($res)->toBe([]);
});

test('TC-SRCH-012 room media tab: files?room_id= scopes to one room', function () {
    $other = srchRoom($this, 'Other', [$this->tony, $this->somchai]);

    srchAttach($this, srchMessage($this, $this->room, $this->tony, 'a'), 'in-room.pdf');
    srchAttach($this, srchMessage($this, $other, $this->tony, 'b'), 'in-other.pdf');

    $res = $this->getJson('/api/v1/search/files?q=.&room_id='.$this->room->id, wsHeaders($this->tonyToken, 'acme'))
        ->assertOk()->json('data.results');

    expect(array_column(array_column($res, 'attachment'), 'original_name'))->toBe(['in-room.pdf']);
});
