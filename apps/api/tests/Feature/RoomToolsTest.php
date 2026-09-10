<?php

use App\Jobs\GenerateRoomBotReply;
use App\Models\AiProvider;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\RoomNote;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
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

it('TC-AI-100 invokes group bot only for explicit mentions and produces one attributed reply', function () {
    Http::fake(['*/chat/completions' => Http::response(['choices' => [['message' => ['content' => '**Hello** from AI']]]])]);
    $this->author->forceFill(['ai_consented_at' => now()])->save();
    AiProvider::create(['name' => 'Test', 'provider_type' => 'openai_compatible', 'base_url' => 'https://ai.test/v1', 'api_key_encrypted' => Crypt::encryptString('test-key'), 'model' => 'test', 'window_size' => 10000, 'max_output_tokens' => 1000, 'is_enabled' => true, 'is_default' => true]);
    $url = '/api/v1/rooms/'.$this->roomId.'/messages';
    $this->postJson($url, ['body' => 'normal conversation', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    Http::assertNothingSent();
    $id = (string) Str::uuid();
    $source = $this->postJson($url, ['body' => '@ai hello', 'client_message_id' => $id], $this->headers)->assertCreated()->json('data.message');
    $this->postJson($url, ['body' => '@ai hello', 'client_message_id' => $id], $this->headers)->assertOk();
    Http::assertSentCount(1);
    Http::assertSent(fn ($r) => count($r['messages']) === 2 && $r['messages'][1]['content'] === 'hello');
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
    Illuminate\Support\Facades\Queue::fake([App\Jobs\GenerateRoomBotReply::class]);
    $dm = $this->postJson('/api/v1/rooms', ['type' => 'dm', 'user_id' => $this->peer->id], $this->headers)->assertCreated()->json('data.room.id');
    $this->postJson('/api/v1/rooms/'.$dm.'/messages', ['body' => '@ai hello', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    $this->postJson('/api/v1/rooms/'.$this->roomId.'/messages', ['body' => 'mail@ai.com @aiden', 'client_message_id' => (string) Str::uuid()], $this->headers)->assertCreated();
    Illuminate\Support\Facades\Queue::assertNotPushed(App\Jobs\GenerateRoomBotReply::class);
});
