<?php

namespace App\Http\Controllers;

use App\Domain\Room\SystemMessageWriter;
use App\Enums\RoomRole;
use App\Models\AuditLog;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\Workspace;
use App\Services\SetupState;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;
use PDO;

/**
 * FR-SETUP — WordPress-style first-run installer (DEC-043). Reachable only
 * while the instance is unconfigured; every endpoint hard-locks (403/302)
 * once SetupState reports completed.
 */
class SetupController extends Controller
{
    public function __construct(private readonly SetupState $state) {}

    /** WordPress "5-minute install" page — plain blade, no build step. */
    public function index()
    {
        if ($this->state->isCompleted()) {
            return redirect('/');
        }

        return view('setup.wizard', [
            'completed' => false,
            'requirements' => self::requirements($this->state),
        ]);
    }

    /** API-120 — environment report + prefilled defaults for the forms. */
    public function status(): JsonResponse
    {
        $completed = $this->state->isCompleted();

        return response()->json([
            'data' => [
                'completed' => $completed,
                'requirements' => $completed ? null : self::requirements($this->state),
                'defaults' => [
                    'database' => [
                        'host' => '127.0.0.1',
                        'port' => 5432,
                        'database' => 'orgchat',
                        'username' => 'orgchat',
                    ],
                    'redis' => [
                        'host' => '127.0.0.1',
                        'port' => 6379,
                    ],
                    'mail' => [
                        'host' => '127.0.0.1',
                        'port' => 1025,
                        'from_address' => 'no-reply@'.Str::of(request()->getHost())->slug()->limit(30, '').'.'.config('app.domain', 'local'),
                    ],
                ],
            ],
        ]);
    }

    /** API-121 — raw PDO probe; never touches the app's connection config. */
    public function testDatabase(Request $request): JsonResponse
    {
        if ($this->state->isCompleted()) {
            return $this->locked();
        }

        $data = $request->validate([
            'host' => ['required', 'string', 'max:255'],
            'port' => ['required', 'integer', 'between:1,65535'],
            'database' => ['required', 'string', 'max:64'],
            'username' => ['required', 'string', 'max:64'],
            'password' => ['nullable', 'string', 'max:255'],
        ]);

        return response()->json(['data' => self::probeDatabase(
            $data['host'],
            (int) $data['port'],
            $data['database'],
            $data['username'],
            (string) ($data['password'] ?? ''),
        )]);
    }

    /** API-122 — RESP PING over a raw socket (works with or without ext-redis). */
    public function testRedis(Request $request): JsonResponse
    {
        if ($this->state->isCompleted()) {
            return $this->locked();
        }

        $data = $request->validate([
            'host' => ['required', 'string', 'max:255'],
            'port' => ['required', 'integer', 'between:1,65535'],
            'password' => ['nullable', 'string', 'max:255'],
        ]);

        return response()->json(['data' => self::probeRedis(
            $data['host'],
            (int) $data['port'],
            (string) ($data['password'] ?? ''),
        )]);
    }

    /**
     * API-123 — gather everything, write .env, migrate, create the first
     * system admin + workspace + room, drop the completion marker.
     */
    public function install(Request $request): JsonResponse
    {
        if ($this->state->isCompleted()) {
            return $this->locked();
        }

        $data = $request->validate([
            'database.host' => ['required', 'string', 'max:255'],
            'database.port' => ['required', 'integer', 'between:1,65535'],
            'database.database' => ['required', 'string', 'max:64'],
            'database.username' => ['required', 'string', 'max:64'],
            'database.password' => ['nullable', 'string', 'max:255'],
            'redis.host' => ['required', 'string', 'max:255'],
            'redis.port' => ['required', 'integer', 'between:1,65535'],
            'redis.password' => ['nullable', 'string', 'max:255'],
            'mail.host' => ['required', 'string', 'max:255'],
            'mail.port' => ['required', 'integer', 'between:1,65535'],
            'mail.from_address' => ['required', 'email:rfc', 'max:255'],
            'admin.username' => ['required', 'string', 'min:3', 'max:30', 'regex:/^[a-zA-Z0-9_.]+$/'],
            'admin.display_name' => ['required', 'string', 'min:1', 'max:80'],
            'admin.password' => ['required', 'string', 'min:8', 'max:128'],
            'workspace.name' => ['required', 'string', 'min:1', 'max:80'],
            'workspace.slug' => ['required', 'string', 'min:2', 'max:30', 'regex:/^[a-z0-9-]+$/'],
            'room_name' => ['required', 'string', 'min:1', 'max:60'],
        ]);

        // Probe both dependencies first — a doomed install must not write .env.
        $db = self::probeDatabase($data['database']['host'], (int) $data['database']['port'], $data['database']['database'], $data['database']['username'], (string) ($data['database']['password'] ?? ''));
        if (! $db['ok']) {
            return response()->json(['error' => ['code' => 'SETUP_DB_UNREACHABLE', 'message' => $db['error'] ?? 'เชื่อมต่อฐานข้อมูลไม่ได้']], 422);
        }

        $redis = self::probeRedis($data['redis']['host'], (int) $data['redis']['port'], (string) ($data['redis']['password'] ?? ''));
        if (! $redis['ok']) {
            return response()->json(['error' => ['code' => 'SETUP_REDIS_UNREACHABLE', 'message' => $redis['error'] ?? 'เชื่อมต่อ Redis ไม่ได้']], 422);
        }

        // 1) write the environment (merge — existing keys/keys of other
        //    services in the file stay untouched)
        $this->state->writeEnv([
            'APP_ENV' => config('app.env') === 'testing' ? 'testing' : 'production',
            'APP_DEBUG' => 'false',
            'APP_URL' => $request->getSchemeAndHttpHost(),
            'APP_KEY' => 'base64:'.base64_encode(random_bytes(32)),
            'APP_LOCALE' => 'th',

            'DB_CONNECTION' => 'pgsql',
            'DB_HOST' => $data['database']['host'],
            'DB_PORT' => (string) $data['database']['port'],
            'DB_DATABASE' => $data['database']['database'],
            'DB_USERNAME' => $data['database']['username'],
            'DB_PASSWORD' => ($data['database']['password'] ?? '') !== '' ? $data['database']['password'] : null,

            'REDIS_HOST' => $data['redis']['host'],
            'REDIS_PORT' => (string) $data['redis']['port'],
            'REDIS_PASSWORD' => ($data['redis']['password'] ?? '') !== '' ? $data['redis']['password'] : null,

            'SESSION_DRIVER' => 'redis',
            'QUEUE_CONNECTION' => 'redis',
            'CACHE_STORE' => 'redis',
            'CACHE_PREFIX' => 'banana_chat',
            'BROADCAST_CONNECTION' => 'reverb',
            'REVERB_APP_KEY' => bin2hex(random_bytes(16)),

            'MAIL_MAILER' => 'smtp',
            'MAIL_HOST' => $data['mail']['host'],
            'MAIL_PORT' => (string) $data['mail']['port'],
            'MAIL_FROM_ADDRESS' => $data['mail']['from_address'],
            'MAIL_FROM_NAME' => '${APP_NAME}',

            'SETUP_COMPLETED' => 'true',
        ]);

        // 2) reload this process's config from the fresh env values and run
        //    migrations + the first entities against them (php artisan
        //    config is NOT cached, but this request booted before the write)
        config([
            // an empty .env boots with the stock default (sqlite) — the
            // wizard is postgres-only, so switch the default connection too
            'database.default' => 'pgsql',
            'database.connections.pgsql.host' => $data['database']['host'],
            'database.connections.pgsql.port' => (int) $data['database']['port'],
            'database.connections.pgsql.database' => $data['database']['database'],
            'database.connections.pgsql.username' => $data['database']['username'],
            'database.connections.pgsql.password' => (string) ($data['database']['password'] ?? ''),
        ]);
        DB::purge('pgsql');

        Artisan::call('migrate', ['--force' => true]);

        $admin = User::query()->firstOrNew(['username' => $data['admin']['username']]);
        if (! $admin->exists) {
            $admin->fill([
                'password_hash' => Hash::make($data['admin']['password']),
                'display_name' => $data['admin']['display_name'],
                'status' => 'active',
                'must_change_password' => false,
                'password_changed_at' => now(),
                'is_system_admin' => true,
                'locale' => 'th',
            ])->save();
        }

        $workspace = Workspace::query()->firstOrNew(['slug' => $data['workspace']['slug']]);
        if (! $workspace->exists) {
            $workspace->fill(['name' => $data['workspace']['name'], 'status' => 'active'])->save();
        }
        if (! $workspace->members()->wherePivot('user_id', $admin->id)->exists()) {
            $workspace->members()->attach($admin->id, ['role' => 'owner', 'status' => 'active']);
        }

        app(WorkspaceContext::class)->set($workspace);

        $room = Room::query()
            ->where('workspace_id', $workspace->id)
            ->where('name', $data['room_name'])
            ->first();
        if ($room === null) {
            $room = Room::query()->create([
                'workspace_id' => $workspace->id,
                'type' => 'group',
                'name' => $data['room_name'],
                'description' => null,
                'created_by' => $admin->id,
                'owner_id' => $admin->id,
                'member_count' => 1,
                'last_message_at' => now(),
            ]);
            RoomMember::query()->create([
                'room_id' => $room->id,
                'user_id' => $admin->id,
                'workspace_id' => $workspace->id,
                'role' => RoomRole::Owner,
                'added_by' => $admin->id,
            ]);
            app(SystemMessageWriter::class)->write($room, $admin, 'room_created', []);
        }

        AuditLog::query()->create([
            'workspace_id' => null,
            'actor_type' => 'user',
            'actor_id' => $admin->id,
            'action' => 'setup.completed',
            'target_type' => 'workspace',
            'target_id' => $workspace->id,
            'context' => [
                'admin' => $admin->username,
                'workspace' => $workspace->slug,
                'room' => $room->name,
                'db_server_version' => $db['server_version'] ?? null,
            ],
            'ip' => $request->ip(),
            'created_at' => now(),
        ]);

        $this->state->complete();

        return response()->json([
            'data' => [
                'ok' => true,
                'admin_username' => $admin->username,
                'workspace_slug' => $workspace->slug,
                'redirect' => '/admin/login',
            ],
        ], 201);
    }

    /** @return array{ok: bool, server_version?: string, error?: string} */
    private static function probeDatabase(string $host, int $port, string $database, string $username, string $password): array
    {
        $timeout = (int) config('setup.probe_timeout', 5);

        try {
            $pdo = new PDO(
                sprintf('pgsql:host=%s;port=%d;dbname=%s;connect_timeout=%d', $host, $port, $database, $timeout),
                $username,
                $password,
                [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => $timeout],
            );
            $version = (string) $pdo->query('SELECT version()')->fetchColumn();

            return ['ok' => true, 'server_version' => Str::before($version, ',')];
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => self::safeError($e)];
        }
    }

    /** @return array{ok: bool, server_version?: string, error?: string} */
    private static function probeRedis(string $host, int $port, string $password): array
    {
        $timeout = (int) config('setup.probe_timeout', 5);

        try {
            $socket = @fsockopen($host, $port, $errno, $errstr, $timeout);
            if ($socket === false) {
                return ['ok' => false, 'error' => "connect: {$errstr} ({$errno})"];
            }
            stream_set_timeout($socket, $timeout);

            if ($password !== '') {
                fwrite($socket, '$'.strlen($password)."\r\n{$password}\r\n");
                $auth = trim((string) fgets($socket));
                if (! str_starts_with($auth, '+') && ! str_starts_with($auth, ':')) {
                    fclose($socket);

                    return ['ok' => false, 'error' => 'auth rejected'];
                }
            }

            fwrite($socket, "*1\r\n\$4\r\nPING\r\n");
            $pong = trim((string) fread($socket, 64));
            fclose($socket);

            if ($pong === '+PONG' || str_starts_with($pong, '-ERR') === false && $pong !== '') {
                return ['ok' => true];
            }

            return ['ok' => false, 'error' => "unexpected reply: {$pong}"];
        } catch (\Throwable $e) {
            return ['ok' => false, 'error' => self::safeError($e)];
        }
    }

    /**
     * Never echo credentials back — PDO/redis errors can embed DSN fragments.
     */
    private static function safeError(\Throwable $e): string
    {
        $message = $e->getMessage();

        return Str::limit(preg_replace('/password=[^\s;]*/i', 'password=***', $message) ?? $message, 200);
    }

    private function locked(): JsonResponse
    {
        return response()->json([
            'error' => ['code' => 'SETUP_ALREADY_COMPLETED', 'message' => 'ระบบติดตั้งไปแล้ว — ลบ marker หรือ SETUP_COMPLETED ใน .env เพื่อเรียกใช้อีกครั้ง'],
        ], 403);
    }

    /** @return array<string, mixed> — environment check shown on step 0 */
    private static function requirements(SetupState $state): array
    {
        $extensions = ['pdo_pgsql', 'openssl', 'mbstring', 'fileinfo', 'gd', 'redis', 'curl', 'xml', 'zip'];
        $checks = [];
        foreach ($extensions as $ext) {
            $checks[] = ['name' => "ext:{$ext}", 'ok' => extension_loaded($ext)];
        }

        return [
            'php_version' => ['required' => '8.2+', 'current' => PHP_VERSION, 'ok' => PHP_VERSION_ID >= 80200],
            'extensions' => $checks,
            'storage_writable' => is_writable(storage_path()),
            'env_writable' => $state->envWritable(),
        ];
    }
}
