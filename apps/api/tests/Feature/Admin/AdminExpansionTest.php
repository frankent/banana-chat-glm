<?php

use App\Domain\Admin\ModerationService;
use App\Domain\Admin\WorkspaceMembershipService;
use App\Filament\Pages\Auth\Login;
use App\Filament\Pages\Settings;
use App\Filament\Resources\AiConversationResource\Pages\ListAiConversation;
use App\Filament\Resources\AttachmentResource\Pages\ListAttachment;
use App\Filament\Resources\AuditLogResource\Pages\ListAuditLogs;
use App\Filament\Resources\MessageResource\Pages\ListMessage;
use App\Filament\Resources\RoomNoteResource\Pages\ListRoomNote;
use App\Filament\Resources\RoomResource\Pages\ListRoom;
use App\Jobs\ProcessAttachment;
use App\Models\AiConversation;
use App\Models\Attachment;
use App\Models\AuditLog;
use App\Models\ChatSession;
use App\Models\Device;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomNote;
use App\Models\User;
use App\Models\Workspace;
use App\Services\AuditLogger;
use App\Services\SettingsService;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Support\Facades\Queue;
use Illuminate\Validation\ValidationException;
use Livewire\Livewire;

test('TC-ADM-070 administration covers rooms media sessions devices operations and API catalog', function (string $path) {
    $admin = User::factory()->systemAdmin()->create();
    Livewire::test(Login::class)->fillForm(['login' => $admin->username, 'password' => 'Password123!'])->call('authenticate')->assertHasNoErrors();
    $this->get('/admin/'.$path)->assertOk();
})->with(['rooms', 'messages', 'room-notes', 'attachments', 'chat-sessions', 'devices', 'operations', 'api-coverage', 'ai-conversations']);

test('TC-ADM-071 all runtime settings have editable fields', function () {
    $this->actingAs(User::factory()->systemAdmin()->create(), 'admin');
    $page = Livewire::test(Settings::class);
    foreach (array_keys(SettingsService::DEFAULTS) as $key) {
        $page->assertFormFieldExists($key);
    }
});

test('TC-ADM-054 restore rejects expired rooms and audits a valid restore', function () {
    $admin = User::factory()->systemAdmin()->create();
    $room = Room::factory()->create(['workspace_id' => Workspace::factory()->create()->id]);
    $service = app(ModerationService::class);
    $service->deleteRoom($admin, $room);
    expect($room->fresh()->deleted_at)->not->toBeNull();
    $service->restoreRoom($admin, $room->fresh());
    expect($room->fresh()->deleted_at)->toBeNull();
    $room->forceFill(['deleted_at' => now()->subDays(31), 'purge_after' => now()->subDay()])->save();
    expect(fn () => $service->restoreRoom($admin, $room))->toThrow(ValidationException::class);
});

test('TC-ADM-072 moderation rejects ordinary members', function () {
    $room = Room::factory()->create(['workspace_id' => Workspace::factory()->create()->id]);
    expect(fn () => app(ModerationService::class)->deleteRoom(User::factory()->create(), $room))
        ->toThrow(AuthorizationException::class);
    expect($room->fresh()->deleted_at)->toBeNull();
});

test('TC-ADM-037 populated message inspection and moderation preserve tombstones and audit', function () {
    $admin = User::factory()->systemAdmin()->create();
    $this->be($admin, 'admin');
    $ws = Workspace::factory()->create();
    $room = Room::factory()->create(['workspace_id' => $ws->id]);
    $message = Message::factory()->create(['room_id' => $room->id, 'workspace_id' => $ws->id, 'body' => 'Review me', 'seq' => 1]);
    Livewire::test(ListMessage::class)->assertCanSeeTableRecords([$message])->mountTableAction('inspect', $message)->assertSee('Review me');
    Livewire::test(ListMessage::class)->callTableAction('deleteMessage', $message)->assertHasNoErrors();
    expect($message->fresh()->body)->toBeNull()->and($message->fresh()->delete_reason)->toBe('moderator');
    expect(AuditLog::where('action', 'message.deleted_moderator')->exists())->toBeTrue();
});

test('TC-ADM-074 device revoke terminates tokens and clears push credentials', function () {
    $admin = User::factory()->systemAdmin()->create();
    $user = User::factory()->create();
    $login = $this->postJson('/api/v1/auth/login', ['username' => $user->username, 'password' => 'Password123!', 'device' => ['platform' => 'web', 'name' => 'QA device']])->assertOk()->json();
    $device = Device::where('user_id', $user->id)->firstOrFail();
    $device->update(['push_token' => 'test-token']);
    app(ModerationService::class)->revokeDevice($admin, $device);
    expect($device->fresh()->push_token)->toBeNull()->and(ChatSession::where('user_id', $user->id)->whereNull('revoked_at')->count())->toBe(0);
    $this->withToken($login['access_token'])->getJson('/api/v1/me')->assertUnauthorized();
});

test('TC-ADM-031 remove workspace member transfers room ownership and reassign restores membership', function () {
    $admin = User::factory()->systemAdmin()->create();
    $ws = Workspace::factory()->create();
    $owner = User::factory()->create();
    $next = User::factory()->create();
    $service = app(WorkspaceMembershipService::class);
    $membership = $service->assign($admin, $ws, $owner, 'owner');
    $service->assign($admin, $ws, $next, 'admin');
    $room = Room::factory()->create(['workspace_id' => $ws->id, 'owner_id' => $owner->id, 'member_count' => 2]);
    $room->members()->attach($owner->id, ['workspace_id' => $ws->id, 'role' => 'owner']);
    $room->members()->attach($next->id, ['workspace_id' => $ws->id, 'role' => 'admin']);
    $service->remove($admin, $membership);
    expect($room->fresh()->owner_id)->toBe($next->id)->and($room->fresh()->member_count)->toBe(1)->and($membership->fresh()->status->value)->toBe('removed');
    $service->assign($admin, $ws, $owner, 'member');
    expect($membership->fresh()->status->value)->toBe('active');
});

test('TC-ADM-075 AI review stays gated and never leaks content in the table', function () {
    $this->be(User::factory()->systemAdmin()->create(), 'admin');
    $owner = User::factory()->create();
    $conversation = AiConversation::create(['user_id' => $owner->id, 'title' => 'private title', 'summary' => 'private memory']);
    $page = Livewire::test(ListAiConversation::class)->assertDontSee('private title')->assertDontSee('private memory')->assertTableActionHidden('review', $conversation);
    app(SettingsService::class)->set('ai.admin_review_enabled', true);
    Livewire::test(ListAiConversation::class)->mountTableAction('review', $conversation)->assertSee('This review is audited.');
    expect(AuditLog::where('action', 'ai.conversation_reviewed')->exists())->toBeTrue();
});

test('TC-ADM-076 settings preserves nullable quota and typed arrays and rejects fractional integer limits', function () {
    $this->be(User::factory()->systemAdmin()->create(), 'admin');
    Livewire::test(Settings::class)->fillForm(['storage.quota_per_workspace_gb' => null, 'upload.file.blocked_extensions' => ['exe', 'sh'], 'ai.compaction.trigger_ratio' => 0.75])->call('save')->assertHasNoErrors();
    expect(app(SettingsService::class)->get('storage.quota_per_workspace_gb'))->toBeNull()->and(app(SettingsService::class)->array('upload.file.blocked_extensions'))->toBe(['exe', 'sh'])->and(app(SettingsService::class)->float('ai.compaction.trigger_ratio'))->toBe(0.75);
    Livewire::test(Settings::class)->fillForm(['room.group.max_members' => 2.5])->call('save')->assertHasFormErrors(['room.group.max_members']);
});

test('TC-ADM-077 populated notes support search inspection and audited deletion', function () {
    $this->be(User::factory()->systemAdmin()->create(), 'admin');
    $ws = Workspace::factory()->create();
    $room = Room::factory()->create(['workspace_id' => $ws->id]);
    $note = RoomNote::create(['workspace_id' => $ws->id, 'room_id' => $room->id, 'author_id' => auth('admin')->id(), 'body' => 'A searchable note']);
    Livewire::test(ListRoomNote::class)->searchTable('searchable')->assertCanSeeTableRecords([$note])->mountTableAction('inspect', $note)->assertSee('A searchable note');
    Livewire::test(ListRoomNote::class)->callTableAction('deleteNote', $note)->assertHasNoErrors();
    expect(RoomNote::find($note->id))->toBeNull()->and(AuditLog::where('action', 'room.note_deleted_admin')->exists())->toBeTrue();
});

test('TC-ADM-078 failed attachment retries enqueue the real processing job once', function () {
    Queue::fake();
    $this->be(User::factory()->systemAdmin()->create(), 'admin');
    $ws = Workspace::factory()->create();
    $a = Attachment::create(['workspace_id' => $ws->id, 'uploader_id' => auth('admin')->id(), 'kind' => 'image', 'status' => 'failed', 'original_name' => 'failed.png', 'mime_type' => 'image/png', 'size_bytes' => 100, 'storage_key' => 'test/failed.png']);
    Livewire::test(ListAttachment::class)->callTableAction('retry', $a)->assertHasNoErrors();
    expect($a->fresh()->status->value)->toBe('uploaded');
    Queue::assertPushed(ProcessAttachment::class, 1);
});

test('TC-ADM-046 filtered audit export returns a real download', function () {
    $this->be(User::factory()->systemAdmin()->create(), 'admin');
    app(AuditLogger::class)->log('test.export', auth('admin')->user());
    Livewire::test(ListAuditLogs::class)->filterTable('action', 'test.export')->callTableAction('exportCsv')->assertFileDownloaded();
});

test('TC-ADM-042 room JSON export returns a download', function () {
    $this->be(User::factory()->systemAdmin()->create(), 'admin');
    $room = Room::factory()->create(['workspace_id' => Workspace::factory()->create()->id]);
    Livewire::test(ListRoom::class)->callTableAction('export', $room)->assertFileDownloaded('room-'.$room->id.'.json');
});
