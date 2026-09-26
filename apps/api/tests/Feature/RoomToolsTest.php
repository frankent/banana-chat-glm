<?php

use App\Domain\Ai\TokenEstimator;
use App\Events\MessageStreamed;
use App\Events\MessageUpdated;
use App\Events\RoomActivity;
use App\Jobs\CompactRoomContext;
use App\Jobs\GenerateRoomBotReply;
use App\Jobs\NotifyMessage;
use App\Models\AiProvider;
use App\Models\AiRoomSummary;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomNote;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SettingsService;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Str;

beforeEach(function () {
    $this->author = User::factory()->create();
    $this->peer = User::factory()->create();
    $this->outsider = User::factory()->create();
    $this->ws = Workspace::factory()->create(['slug' => 'tools']);
    foreach ([$this->author, $this->peer, $this->outsider] as $user) {
        $this->ws->members()->attach($user->id, ['role' => 'member']);
    }
    [, $this->token] = loginAs($this->author);
    [, $this->peerToken] = loginAs($this->peer);
    [, $this->outsiderToken] = loginAs($this->outsider);
    $this->headers = ['Authorization' => 'Bearer '.$this->token, 'X-Workspace-Id' => 'tools'];
    $this->roomId = $this->postJson('/api/v1/rooms', ['type' => 'group', 'name' => 'Tools', 'member_ids' => [$this->peer->id]], $this->headers)->assertCreated()->json('data.room.id');
});

it('TC-NOTE-001 persists notes and enforces author and room membership', function () {
    $url = '/api/v1/rooms/'.$this->roomId.'/notes';
    $note = $this->postJson($url, ['body' => '# Plan', 'attachment_ids' => []], $this->headers)->assertCreated()->json('data');
    $this->getJson($url, $this->headers)->assertOk()->assertJsonPath('data.notes.0.body', '# Plan');
    $peer = [...$this->headers, 'Authorization' => 'Bearer '.$this->peerToken];
    $this->patchJson($url.'/'.$note['id'], ['body' => 'hijack'], $peer)->assertForbidden();
    $this->patchJson($url.'/'.$note['id'], ['body' => 'Updated'], $this->headers)->assertOk();
    $this->getJson($url, [...$this->headers, 'Authorization' => 'Bearer '.$this->outsiderToken])->assertForbidden();
    $this->deleteJson($url.'/'.$note['id'], [], $this->headers)->assertNoContent();
    $this->getJson($url, $this->headers)->assertJsonCount(0, 'data.notes');
});

it('TC-PIN-001 pins idempotently and resolves an exact message sequence', function () {
    $message = $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => 'Pin me', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated()->json('data.message');
    $url = '/api/v1/rooms/'.$this->roomId.'/pins';
    $this->putJson($url.'/'.$message['id'], [], $this->headers)->assertOk();
    $this->putJson($url.'/'.$message['id'], [], $this->headers)->assertOk();
    $this->getJson($url, $this->headers)->assertJsonCount(1, 'data')->assertJsonPath('data.0.seq', $message['seq']);
    $this->deleteJson($url.'/'.$message['id'], [], $this->headers)->assertNoContent();
    $this->getJson($url, $this->headers)->assertJsonCount(0, 'data');
});

it('TC-RT-020 accepts authenticated typing and rejects nonmembers', function () {
    $url = '/api/v1/rooms/'.$this->roomId.'/typing';
    $this->postJson($url, ['typing' => true], $this->headers)->assertNoContent();
    $this->postJson($url, ['typing' => true], [...$this->headers, 'Authorization' => 'Bearer '.$this->outsiderToken])->assertForbidden();
});

/** the room bot streams, so its provider fake has to speak SSE */
function botSse(array $deltas): string
{
    $lines = [];
    foreach ($deltas as $delta) {
        $lines[] = 'data: '.json_encode(['choices' => [['delta' => ['content' => $delta]]]], JSON_UNESCAPED_UNICODE);
    }
    $lines[] = 'data: '.json_encode(['choices' => [['delta' => new stdClass, 'finish_reason' => 'stop']]]);
    $lines[] = 'data: [DONE]';

    return implode("\n\n", $lines)."\n\n";
}

it('TC-AI-100 invokes group bot only for explicit mentions and produces one attributed reply', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['**Hello** ', 'from AI']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now()])->save();
    AiProvider::create(['name' => 'Test', 'provider_type' => 'openai_compatible', 'base_url' => 'https://ai.test/v1', 'api_key_encrypted' => Crypt::encryptString('test-key'), 'model' => 'test', 'window_size' => 10000, 'max_output_tokens' => 1000, 'is_enabled' => true, 'is_default' => true]);
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';
    $this->postJson($url, ['body' => 'normal conversation', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    Http::assertNothingSent();
    $id = (string) Str::uuid();
    $source = $this->postJson($url, ['body' => '@ai hello', 'client_message_id' => $id], $this->headers)->assertCreated()->json('data.message');
    $this->postJson($url, ['body' => '@ai hello', 'client_message_id' => $id], $this->headers)->assertOk();
    Http::assertSentCount(1);
    Http::assertSent(function ($r) {
        $turns = $r['messages'];

        return $r['stream'] === true && str_ends_with(end($turns)['content'], 'hello');
    });
    $reply = Message::where('reply_to_message_id', $source['id'])->firstOrFail();
    expect($reply->body)->toBe('**Hello** from AI')->and($reply->sender->display_name)->toBe('AI Assistant');
    app()->call([new GenerateRoomBotReply($source['id']), 'handle']);
    Http::assertSentCount(1);
});

it('TC-AI-101 blocks bot requests without consent or room membership', function () {
    Http::fake();
    AiProvider::create(['name' => 'Test', 'provider_type' => 'openai_compatible', 'base_url' => 'https://ai.test/v1', 'api_key_encrypted' => Crypt::encryptString('test-key'), 'model' => 'test', 'window_size' => 10000, 'max_output_tokens' => 1000, 'is_enabled' => true, 'is_default' => true]);
    $source = $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai help', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated()->json('data.message');
    Http::assertNothingSent();
    expect(Message::where('reply_to_message_id', $source['id'])->firstOrFail()->body)->toContain('consent');
});

it('TC-NOTE-002 supports media notes in DMs and prevents claiming another users upload', function () {
    $room = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->peer->id], $this->headers)->assertCreated()->json('data.room.id');
    $attachment = Attachment::create(['original_name' => 'test.png', 'mime_type' => 'image/png', 'size_bytes' => 20, 'storage_key' => 'ws/'.$this->ws->id.'/att/'.Str::ulid().'/original', 'workspace_id' => $this->ws->id, 'uploader_id' => $this->author->id, 'kind' => 'image', 'status' => 'ready']);
    $url = '/api/v1/rooms/'.$room.'/notes';
    $this->postJson($url, ['body' => 'https://example.com', 'attachment_ids' => [$attachment->id]], $this->headers)->assertCreated()->assertJsonPath('data.attachments.0.id', $attachment->id);
    $this->postJson($url, ['attachment_ids' => [$attachment->id]], $this->headers)->assertUnprocessable();
    $other = Attachment::create(['original_name' => 'test.png', 'mime_type' => 'image/png', 'size_bytes' => 20, 'storage_key' => 'ws/'.$this->ws->id.'/att/'.Str::ulid().'/original', 'workspace_id' => $this->ws->id, 'uploader_id' => $this->peer->id, 'kind' => 'video', 'status' => 'ready']);
    $this->postJson($url, ['attachment_ids' => [$other->id]], $this->headers)->assertUnprocessable();
});

it('TC-PIN-002 rejects foreign room messages and hides deleted pins', function () {
    $message = $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => 'Keep', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated()->json('data.message');
    $other = $this->postJson('/api/v1/rooms', ['type' => 'group', 'name' => 'Other', 'member_ids' => []], $this->headers)->assertCreated()->json('data.room.id');
    $this->putJson('/api/v1/rooms/'.$other.'/pins/'.$message['id'], [], $this->headers)->assertNotFound();
    $this->putJson('/api/v1/rooms/'.$this->roomId.'/pins/'.$message['id'], [], $this->headers)->assertOk();
    $this->deleteJson('/api/v1/messages/'.$message['id'], [], $this->headers)->assertNoContent();
    $this->getJson('/api/v1/rooms/'.$this->roomId.'/pins', $this->headers)->assertJsonCount(0, 'data');
});

it('TC-WS-005 paginates every member including duplicate display names', function () {
    $people = User::factory()->count(53)->create(['display_name' => 'Same name']);
    foreach ($people as $person) {
        $this->ws->members()->attach($person->id, ['role' => 'member']);
    }
    $one = $this->getJson('/api/v1/directory?limit=30', $this->headers)->assertOk()->json('data');
    expect($one['next_cursor'])->not->toBeNull();
    $two = $this->getJson('/api/v1/directory?limit=30&cursor='.urlencode($one['next_cursor']), $this->headers)->assertOk()->json('data');
    expect(array_unique(array_column([...$one['members'], ...$two['members']], 'id')))->toHaveCount(56);
});

it('TC-NOTE-003 paginates notes without capping total number', function () {
    for ($i = 0; $i < 35; $i++) {
        RoomNote::create(['workspace_id' => $this->ws->id, 'room_id' => $this->roomId, 'author_id' => $this->author->id, 'body' => 'Note '.$i]);
    }
    $url = '/api/v1/rooms/'.$this->roomId.'/notes';
    $one = $this->getJson($url, $this->headers)->assertOk()->json('data');
    expect($one['has_more'])->toBeTrue()->and($one['notes'])->toHaveCount(30);
    $two = $this->getJson($url.'?before='.end($one['notes'])['id'], $this->headers)->assertOk()->json('data');
    expect($two['has_more'])->toBeFalse()->and($two['notes'])->toHaveCount(5);
});

it('TC-AI-102 ignores DM mentions and partial mention tokens', function () {
    Queue::fake([GenerateRoomBotReply::class]);
    $dm = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->peer->id], $this->headers)->assertCreated()->json('data.room.id');
    $this->postJson('/api/v1/rooms/'.$dm.'/messages', ['body' => '@ai hello', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => 'mail@ai.com @aiden', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    Queue::assertNotPushed(GenerateRoomBotReply::class);
});

// ---- FR-AI-021 room bot streaming ----

function botProvider(): AiProvider
{
    return AiProvider::create(['name' => 'Test', 'provider_type' => 'openai_compatible', 'base_url' => 'https://ai.test/v1', 'api_key_encrypted' => Crypt::encryptString('test-key'), 'model' => 'test', 'window_size' => 10000, 'max_output_tokens' => 1000, 'is_enabled' => true, 'is_default' => true]);
}

it('the room bot grows its answer in place and only pushes when it is finished', function () {
    Event::fake([MessageStreamed::class, MessageUpdated::class, RoomActivity::class]);
    Queue::fake([NotifyMessage::class]);
    // deltas longer than the 80-char flush threshold, so frames land mid-answer
    $part = str_repeat('ก', 100);
    Http::fake(['*/chat/completions' => Http::response(botSse([$part, $part]), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now()])->save();
    botProvider();

    $source = $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai นับหนึ่งถึงสาม', 'client_message_id' => (string) Str::uuid()], $this->headers)
        ->assertCreated()->json('data.message');

    $reply = Message::where('reply_to_message_id', $source['id'])->firstOrFail();

    // the room saw the answer before it was finished...
    Event::assertDispatched(MessageStreamed::class);

    // ...and it ends up whole, attributed to the bot, with no "edited" marker
    expect($reply->body)->toBe($part.$part)
        ->and($reply->sender->display_name)->toBe('AI Assistant')
        ->and($reply->edited_at)->toBeNull();

    // the room list's preview catches up with the finished answer, not the first frame
    Event::assertDispatched(RoomActivity::class, fn (RoomActivity $e) => $e->lastMessagePreview === $part.$part);

    // push waits for the final body — one notification, never one per frame
    // (the other push is for the human's own @ai message)
    expect(collect(Queue::pushed(NotifyMessage::class))->filter(fn ($job) => $job->messageId === $reply->id))
        ->toHaveCount(1);
});

it('a provider that dies mid-answer keeps the words it already said', function () {
    Http::fake(['*/chat/completions' => Http::response('data: '.json_encode(['choices' => [['delta' => ['content' => 'เริ่มตอบแล้ว']]]])."\n\n", 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now()])->save();
    botProvider();

    $source = $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai ทดสอบ', 'client_message_id' => (string) Str::uuid()], $this->headers)
        ->assertCreated()->json('data.message');

    $reply = Message::where('reply_to_message_id', $source['id'])->firstOrFail();
    expect($reply->body)->toContain('เริ่มตอบแล้ว');
});

it('a model that says nothing at all still gets a reply, not silence', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse([]), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now()])->save();
    botProvider();

    $source = $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai ว่าง', 'client_message_id' => (string) Str::uuid()], $this->headers)
        ->assertCreated()->json('data.message');

    expect(Message::where('reply_to_message_id', $source['id'])->firstOrFail()->body)
        ->toBe('AI returned an empty answer. Please try again.');
});

// ---- FR-AI-021 room context ----

it('the bot reads the room back to itself, in order and with names', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['ครับ']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    $this->peer->forceFill(['display_name' => 'Somchai'])->save();
    botProvider();
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';
    $peerHeaders = ['Authorization' => 'Bearer '.$this->peerToken, 'X-Workspace-Id' => 'tools'];

    $this->postJson($url, ['body' => 'งวดนี้ยอดตกเยอะ', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    $this->postJson($url, ['body' => 'site B ปิดไป 2 วัน', 'client_message_id' => (string) Str::uuid()], $peerHeaders)->assertCreated();
    $this->postJson($url, ['body' => '@ai สรุปให้หน่อย', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $system = $request['messages'][0]['content'];
        $turns = collect($request['messages'])->where('role', '!=', 'system')->values();

        // DEC-084: the room is background in the system prompt; only the mention is a turn
        return str_contains($system, "Tony: งวดนี้ยอดตกเยอะ\nSomchai: site B ปิดไป 2 วัน")
            && $turns->count() === 1
            && $turns[0] === ['role' => 'user', 'content' => 'Tony: สรุปให้หน่อย'];
    });
});

it('a busy room reaches the model as background, so only the mention is asked of it (DEC-084)', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['ok']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    botProvider();
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';

    foreach (range(1, 12) as $i) {
        $this->postJson($url, ['body' => 'เรื่องอื่น '.$i, 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    }
    $this->postJson($url, ['body' => '@ai check credit', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $roles = array_column($request['messages'], 'role');
        $system = $request['messages'][0]['content'];

        return $roles === ['system', 'user']
            && $request['messages'][1]['content'] === 'Tony: check credit'
            && str_contains($system, 'Do NOT reply to them')
            && str_contains($system, "Tony: เรื่องอื่น 3\n") && str_contains($system, 'Tony: เรื่องอื่น 12')
            && ! str_contains($system, "Tony: เรื่องอื่น 2\n") // default cap is 10 (DEC-084)
            && ! str_contains($system, 'check credit');
    });
});

it('a bot notice is not fed back to the bot as something it said (DEC-084)', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['ok']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    botProvider();
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';
    $peerHeaders = ['Authorization' => 'Bearer '.$this->peerToken, 'X-Workspace-Id' => 'tools'];

    // the peer never consented, so the bot posts the consent notice — tagged
    $this->postJson($url, ['body' => '@ai สวัสดี', 'client_message_id' => (string) Str::uuid()], $peerHeaders)->assertCreated();
    $notice = Message::where('body', GenerateRoomBotReply::NOTICE_CONSENT)->firstOrFail();
    expect($notice->metadata['bot_notice'] ?? null)->toBeTrue();
    // …and one posted before tagging existed is caught by its text alone
    $legacy = $this->postJson($url, ['body' => '@ai อีกที', 'client_message_id' => (string) Str::uuid()], $peerHeaders)->assertCreated()->json('data.message.id');
    Message::where('reply_to_message_id', $legacy)->update(['metadata' => null]);
    expect(Message::where('body', GenerateRoomBotReply::NOTICE_CONSENT)->whereNull('metadata')->count())->toBe(1);

    $this->postJson($url, ['body' => '@ai ยอดวันนี้', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $sent = json_encode($request['messages'], JSON_UNESCAPED_UNICODE);

        return str_contains($sent, 'ยอดวันนี้') && ! str_contains($sent, 'consent');
    });
});

it('an answer that was cut short keeps its words but not the bracketed note (DEC-084)', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['ok']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    botProvider();
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';

    $first = $this->postJson($url, ['body' => '@ai ขอยอด', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated()->json('data.message.id');
    Message::where('reply_to_message_id', $first)->update([
        'body' => "ยอดรวม 500\n\n[".GenerateRoomBotReply::NOTICE_FAILED.']',
    ]);
    $this->postJson($url, ['body' => '@ai ต่อเลย', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $system = $request['messages'][0]['content'];

        return str_ends_with($system, 'You (AI): ยอดรวม 500') && ! str_contains($system, 'could not complete');
    });
});

it('stripNotes removes only trailing bot notes', function () {
    expect(GenerateRoomBotReply::stripNotes("a\n\n".GenerateRoomBotReply::TRUNCATED))->toBe('a')
        ->and(GenerateRoomBotReply::stripNotes("a\n\n".GenerateRoomBotReply::TRUNCATED."\n\n[".GenerateRoomBotReply::NOTICE_FAILED.']'))->toBe('a')
        ->and(GenerateRoomBotReply::stripNotes('[Answer truncated to message limit] is what it says'))->toBe('[Answer truncated to message limit] is what it says')
        ->and(GenerateRoomBotReply::isNotice(sprintf(GenerateRoomBotReply::NOTICE_UNAVAILABLE, 'AI_DISABLED')))->toBeTrue()
        ->and(GenerateRoomBotReply::isNotice('AI is unavailable, sorry'))->toBeFalse();
});

it('the bot sees its own earlier answer as its own, not as somebody speaking', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['ส่งเต็มได้ค่ะ']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    botProvider();
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';

    $this->postJson($url, ['body' => '@ai ขอยอดหน่อย', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    $this->postJson($url, ['body' => '@ai ขอ data ดิบไม่ต้องย่อ', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $system = $request['messages'][0]['content'];
        $turns = collect($request['messages'])->where('role', '!=', 'system')->values();

        // …user asks, bot answers, user follows up — the follow-up now has something to follow
        return str_contains($system, "Tony: ขอยอดหน่อย\nYou (AI): ส่งเต็มได้ค่ะ")
            && $turns->count() === 1
            && $turns[0]['content'] === 'Tony: ขอ data ดิบไม่ต้องย่อ';
    });
});

it('history stays inside the configured message cap', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['ok']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    botProvider();
    app(SettingsService::class)->set('ai.room_bot.history_messages', 2);
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';

    foreach (range(1, 6) as $i) {
        $this->postJson($url, ['body' => 'บรรทัดที่ '.$i, 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    }
    $this->postJson($url, ['body' => '@ai เอาอันล่าสุด', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $system = $request['messages'][0]['content'];

        return str_contains($system, "Tony: บรรทัดที่ 5\nTony: บรรทัดที่ 6")
            && ! str_contains($system, 'บรรทัดที่ 4')
            && $request['messages'][1]['content'] === 'Tony: เอาอันล่าสุด';
    });
});

it('a deleted message is not quietly resurrected into the AI context', function () {
    Http::fake(['*/chat/completions' => Http::response(botSse(['ok']), 200, ['Content-Type' => 'text/event-stream'])]);
    $this->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    botProvider();
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';

    // the real delete path redacts the body, so it could never leak anyway;
    // this row keeps its text and is only tombstoned, which is the state an
    // admin restore or a refactor of MessageEditor could leave behind
    $tombstoned = $this->postJson($url, ['body' => 'รหัสผ่านคือ hunter2', 'client_message_id' => (string) Str::uuid()], $this->headers)
        ->assertCreated()->json('data.message.id');
    Message::withoutGlobalScopes()->whereKey($tombstoned)->update(['deleted_at' => now()]);

    $redacted = $this->postJson($url, ['body' => 'โอนเข้า 4455', 'client_message_id' => (string) Str::uuid()], $this->headers)
        ->assertCreated()->json('data.message.id');
    $this->deleteJson('/api/v1/messages/'.$redacted, [], $this->headers)->assertNoContent();

    $this->postJson($url, ['body' => '@ai ว่าไง', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $sent = json_encode($request['messages'], JSON_UNESCAPED_UNICODE);

        return ! str_contains($sent, 'hunter2') && ! str_contains($sent, '4455');
    });
});

// ---- DEC-085 room summary ----

/** streamed answers speak SSE; the summary call is a plain chat completion */
function botFakeWithSummary(string $summary = 'สรุปเก่า: Tony ถามยอด'): void
{
    Http::fake(['*/chat/completions' => function ($request) use ($summary) {
        if (($request['stream'] ?? false) === true) {
            return Http::response(botSse(['ok']), 200, ['Content-Type' => 'text/event-stream']);
        }

        return Http::response(['choices' => [['message' => ['content' => $summary]]]], 200);
    }]);
}

/** four lines, then a mention: the window (cap 4) is full, so its oldest half rolls up */
function fillWindowAndMention($test): array
{
    $test->author->forceFill(['ai_consented_at' => now(), 'display_name' => 'Tony'])->save();
    botProvider();
    app(SettingsService::class)->set('ai.room_bot.history_messages', 4);
    $url = '/api/v1/rooms/'.$test->roomId.'/messages';
    $ids = [];
    foreach (['line-a', 'line-b', 'line-c', 'line-d', 'line-e', 'line-f'] as $body) {
        $ids[$body] = $test->postJson($url, ['body' => $body, 'client_message_id' => (string) Str::uuid()], $test->headers)->assertCreated()->json('data.message.id');
    }
    $test->postJson($url, ['body' => '@ai first', 'client_message_id' => (string) Str::uuid()], $test->headers)->assertCreated();

    return $ids;
}

it('a full window rolls only lines the bot was already sent into the room summary (DEC-085)', function () {
    botFakeWithSummary();
    fillWindowAndMention($this);

    $summary = AiRoomSummary::query()->findOrFail($this->roomId);
    expect($summary->summary)->toBe('สรุปเก่า: Tony ถามยอด');

    // the summariser saw the oldest half of that mention's window — c, d — and nothing older
    Http::assertSent(function ($request) {
        if (($request['stream'] ?? false) === true) {
            return false;
        }
        $sent = $request['messages'][1]['content'];

        return str_contains($sent, 'Tony: line-c') && str_contains($sent, 'Tony: line-d')
            && ! str_contains($sent, 'line-a') && ! str_contains($sent, 'line-b') && ! str_contains($sent, 'line-e');
    });

    $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai second', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        if (($request['stream'] ?? false) !== true || $request['messages'][1]['content'] !== 'Tony: second') {
            return false;
        }
        $system = $request['messages'][0]['content'];

        // summary rides above the raw lines, and what it covers is not repeated raw
        return str_contains($system, "summary, background only\nA summary")
            && str_contains($system, 'สรุปเก่า: Tony ถามยอด')
            && strpos($system, 'สรุปเก่า') < strpos($system, '## Recent room messages')
            && str_contains($system, 'Tony: line-e') && ! str_contains($system, 'Tony: line-d');
    });
});

it('a secret room never gets a summary (DEC-085)', function () {
    botFakeWithSummary();
    Room::withoutGlobalScopes()->whereKey($this->roomId)->update(['is_secret' => true, 'secret_expires_at' => now()->addDay()]);
    fillWindowAndMention($this);

    expect(AiRoomSummary::query()->count())->toBe(0);
    Http::assertNotSent(fn ($request) => ($request['stream'] ?? false) !== true);
});

it('deleting or editing a covered message drops the summary (DEC-085)', function (string $action) {
    botFakeWithSummary();
    $ids = fillWindowAndMention($this);
    expect(AiRoomSummary::query()->count())->toBe(1);

    $url = '/api/v1/messages/'.$ids['line-c'];
    $action === 'delete'
        ? $this->deleteJson($url, [], $this->headers)->assertNoContent()
        : $this->patchJson($url, ['body' => 'line-c edited'], $this->headers)->assertOk();

    expect(AiRoomSummary::query()->count())->toBe(0);
})->with(['delete', 'edit']);

it('a change that skipped the model hook still keeps the summary out of the prompt (DEC-085)', function () {
    botFakeWithSummary();
    $ids = fillWindowAndMention($this);
    // a mass update fires no model events — the builder must catch it itself
    Message::withoutGlobalScopes()->whereKey($ids['line-d'])->update(['deleted_at' => now()->addSecond()]);

    $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai second', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(fn ($request) => ($request['stream'] ?? false) === true
        && $request['messages'][1]['content'] === 'Tony: second'
        && ! str_contains($request['messages'][0]['content'], 'สรุปเก่า'));
    // …and the stale row is gone, not just skipped (a new window may already have rolled a fresh one)
    expect(AiRoomSummary::query()->where('from_seq', '<=', Message::withoutGlobalScopes()->find($ids['line-d'])->seq)->count())->toBe(0);
});

it('a moderated room keeps no summary (DEC-085)', function () {
    botFakeWithSummary();
    fillWindowAndMention($this);
    Room::withoutGlobalScopes()->findOrFail($this->roomId)->forceFill(['deleted_at' => now()])->save();

    expect(AiRoomSummary::query()->count())->toBe(0);
});

it('lines the summary covers are not sent again raw (DEC-085)', function () {
    botFakeWithSummary();
    $ids = fillWindowAndMention($this);
    $seq = fn (string $body) => Message::withoutGlobalScopes()->find($ids[$body])->seq;
    AiRoomSummary::query()->updateOrCreate(['room_id' => $this->roomId], [
        'summary' => 'ครอบถึง f', 'from_seq' => $seq('line-a'), 'up_to_seq' => $seq('line-f'),
        'summary_tokens' => 5, 'source_read_at' => now(),
    ]);
    app(SettingsService::class)->set('ai.room_bot.history_messages', 10);

    $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai second', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(function ($request) {
        $system = $request['messages'][0]['content'];

        return ($request['stream'] ?? false) === true && $request['messages'][1]['content'] === 'Tony: second'
            && str_contains($system, 'ครอบถึง f') && str_contains($system, 'Tony: first')
            && ! str_contains($system, 'line-');
    });
});

it('a line edited after the bot was sent it is left out of the summary (DEC-085)', function () {
    botFakeWithSummary();
    $ids = fillWindowAndMention($this);
    AiRoomSummary::query()->delete();
    $seq = fn (string $body) => Message::withoutGlobalScopes()->find($ids[$body])->seq;
    $sentAt = now()->subMinutes(5)->toIso8601String();
    $this->patchJson('/api/v1/messages/'.$ids['line-d'], ['body' => 'ความลับใหม่'], $this->headers)->assertOk();

    CompactRoomContext::dispatchSync($this->roomId, $this->author->id, $seq('line-c'), $seq('line-d'), $sentAt);

    Http::assertSent(fn ($request) => ($request['stream'] ?? false) !== true
        && str_contains($request['messages'][1]['content'], 'Tony: line-c'));
    Http::assertNotSent(fn ($request) => str_contains(json_encode($request->data(), JSON_UNESCAPED_UNICODE), 'ความลับใหม่'));
});

it('the summariser passes the same AI gate as the mention (DEC-085)', function () {
    botFakeWithSummary();
    $ids = fillWindowAndMention($this);
    AiRoomSummary::query()->delete();
    $seq = fn (string $body) => Message::withoutGlobalScopes()->find($ids[$body])->seq;
    app(SettingsService::class)->set('ai.enabled', false);
    $before = count(Http::recorded());

    CompactRoomContext::dispatchSync($this->roomId, $this->author->id, $seq('line-c'), $seq('line-d'), now()->toIso8601String());

    expect(count(Http::recorded()))->toBe($before)
        ->and(AiRoomSummary::query()->count())->toBe(0);
});

it('history 0 still sends the mention alone, summary or not (DEC-085)', function () {
    botFakeWithSummary();
    fillWindowAndMention($this);
    expect(AiRoomSummary::query()->count())->toBe(1);
    app(SettingsService::class)->set('ai.room_bot.history_messages', 0);

    $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => '@ai second', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();

    Http::assertSent(fn ($request) => ($request['stream'] ?? false) === true
        && $request['messages'][1]['content'] === 'Tony: second'
        && ! str_contains($request['messages'][0]['content'], 'สรุปเก่า'));
});

it('the summary clip holds for Thai text (DEC-085)', function () {
    $estimator = new TokenEstimator;
    $clipped = CompactRoomContext::clip(str_repeat('สรุปยอดเครดิต ', 800), 300, $estimator);

    expect($estimator->estimate($clipped))->toBeLessThanOrEqual(300)
        ->and(mb_strlen($clipped))->toBeGreaterThan(50);
});
