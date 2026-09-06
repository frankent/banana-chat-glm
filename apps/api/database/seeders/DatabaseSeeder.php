<?php

namespace Database\Seeders;

use App\Domain\Message\MessageWriter;
use App\Domain\Room\Actions\CreateRoomAction;
use App\Domain\Room\SystemMessageWriter;
use App\Enums\RoomRole;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Support\WorkspaceContext;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * Demo seed (plan Phase 8): admin + acme/globex workspaces + Engineering room
 * with messages, so the E2E walkthrough works out of the box.
 *
 * Credentials: admin/Admin12345!, tony/Tony12345!, anna/Anna12345!,
 * somchai/Somchai12345!, duangjai/Duangjai12345!
 */
class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        $createUser = function (string $username, string $displayName, string $password, bool $systemAdmin = false): User {
            return User::query()->create([
                'username' => $username,
                'password_hash' => Hash::make($password),
                'display_name' => $displayName,
                'status' => 'active',
                'must_change_password' => false,
                'password_changed_at' => now(),
                'is_system_admin' => $systemAdmin,
                'locale' => 'th',
            ]);
        };

        $admin = $createUser('admin', 'System Admin', 'Admin12345!', systemAdmin: true);
        $tony = $createUser('tony', 'Tony Starr', 'Tony12345!');
        $anna = $createUser('anna', 'Anna Garcia', 'Anna12345!');
        $somchai = $createUser('somchai', 'สมชาย ใจดี', 'Somchai12345!');
        $duangjai = $createUser('duangjai', 'ดวงใจ มีสุข', 'Duangjai12345!');

        $acme = Workspace::query()->create(['slug' => 'acme', 'name' => 'Acme Corp', 'status' => 'active']);
        $globex = Workspace::query()->create(['slug' => 'globex', 'name' => 'Globex Industries', 'status' => 'active']);

        $attach = function (Workspace $ws, User $user, string $role) use ($admin): void {
            $ws->members()->attach($user->id, ['role' => $role, 'status' => 'active', 'invited_by' => $admin->id]);
        };
        $attach($acme, $tony, 'owner');
        $attach($acme, $anna, 'admin');
        $attach($acme, $somchai, 'member');
        $attach($acme, $duangjai, 'member');
        $attach($globex, $admin, 'owner');
        $attach($globex, $tony, 'member'); // shared user — isolation demo

        // Actions read the workspace from the request-scoped singleton —
        // in a seeder there is no request, so set it explicitly per workspace.
        $context = app(WorkspaceContext::class);
        $context->set($acme);

        // Engineering group with system message + conversation
        $engineering = Room::query()->create([
            'workspace_id' => $acme->id,
            'type' => 'group',
            'name' => 'Engineering',
            'description' => 'ทีมวิศวกรรม',
            'created_by' => $tony->id,
            'owner_id' => $tony->id,
            'member_count' => 4,
            'last_message_at' => now(),
        ]);
        foreach ([
            [$tony, RoomRole::Owner],
            [$anna, RoomRole::Admin],
            [$somchai, RoomRole::Member],
            [$duangjai, RoomRole::Member],
        ] as [$user, $role]) {
            RoomMember::query()->create([
                'room_id' => $engineering->id,
                'user_id' => $user->id,
                'workspace_id' => $acme->id,
                'role' => $role,
                'added_by' => $tony->id,
            ]);
        }
        app(SystemMessageWriter::class)->write(
            $engineering, $tony, 'member_added',
            ['user_ids' => [$anna->id, $somchai->id, $duangjai->id]],
        );

        $conversation = [
            [$tony, 'ทุกคนเตรียม standup 9:00 นะครับ'],
            [$anna, 'ได้ค่ะ วันนี้จะ review PR ที่ค้างอยู่ด้วย'],
            [$somchai, 'รับทราบครับ ผม deploy staging เสร็จแล้ว'],
            [$duangjai, 'เดี๋ยวส่ง design ใหม่ในช่วงบ่ายค่ะ'],
            [$tony, 'เยี่ยม 👍'],
        ];
        foreach ($conversation as [$sender, $body]) {
            app(MessageWriter::class)->write($engineering, $sender, $body, (string) Str::uuid());
        }

        // General group + a DM
        [$general] = app(CreateRoomAction::class)->createGroup($tony, 'General', null, [$anna->id, $somchai->id, $duangjai->id]);
        app(MessageWriter::class)->write($general, $anna, 'ยินดีต้อนรับเข้าสู่ General ค่ะ', (string) Str::uuid());

        [$dm] = app(CreateRoomAction::class)->createDm($tony, $somchai->id);
        app(MessageWriter::class)->write($dm, $somchai, 'สวัสดีครับพี่ Tony', (string) Str::uuid());
        app(MessageWriter::class)->write($dm, $tony, 'สวัสดีครับสมชาย มีอะไรให้ช่วยไหม', (string) Str::uuid());

        $this->command?->info('Seeded: admin, tony, anna, somchai, duangjai | acme, globex | Engineering, General, DM');
    }
}
