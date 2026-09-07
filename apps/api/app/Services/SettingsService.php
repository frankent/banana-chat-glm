<?php

namespace App\Services;

use App\Models\AppSetting;
use Illuminate\Support\Facades\Cache;

/**
 * Configurable limits per spec §4.4 — DB-backed (admin editable), 60s cached.
 */
class SettingsService
{
    public const CACHE_KEY = 'app_settings:all';

    public const CACHE_TTL = 60;

    /** §4.4 defaults */
    public const DEFAULTS = [
        'message.max_length' => 4000,
        'message.edit_window_minutes' => 1440,
        'message.max_attachments' => 10,
        'upload.image.max_bytes' => 20971520,
        'upload.video.max_bytes' => 209715200,
        'upload.file.max_bytes' => 104857600,
        'upload.image.allowed_mimes' => ['jpeg', 'png', 'gif', 'webp', 'heic'],
        'upload.video.allowed_mimes' => ['mp4', 'quicktime', 'webm'],
        'upload.file.blocked_extensions' => ['exe', 'bat', 'cmd', 'sh', 'ps1', 'msi', 'scr', 'js', 'jar', 'com', 'vbs'],
        'room.group.max_members' => 500,
        'room.deleted_purge_days' => 30,
        'auth.password.min_length' => 10,
        'auth.lockout.threshold' => 10,
        'auth.lockout.minutes' => 15,
        'auth.access_token_ttl_minutes' => 60,
        'auth.refresh_token_ttl_days' => 30,
        'auth.max_sessions_per_user' => 10,
        'presence.offline_after_seconds' => 60,
        'typing.ttl_seconds' => 5,
        'push.suppress_if_focused_seconds' => 30,
        'storage.quota_per_workspace_gb' => null,
        'ai.enabled' => true,
        'ai.memory.enabled' => true,
        'ai.memory.max_per_user' => 200,
        'ai.memory.inject_max' => 30,
        'ai.memory.inject_max_tokens' => 1500,
        'ai.daily_message_limit_per_user' => 200,
        'ai.max_message_chars' => 32000,
        'ai.max_concurrent_per_user' => 2,
        'ai.compaction.trigger_ratio' => 0.6,
        'ai.stream.flush_interval_ms' => 100,
        'ai.deleted_purge_days' => 30,
        'ai.admin_review_enabled' => false,
        'ai.push_suppress_if_focused_seconds' => 30,
    ];

    /**
     * @return array<string, mixed> defaults overlaid with DB overrides
     */
    public function all(): array
    {
        return Cache::remember(self::CACHE_KEY, self::CACHE_TTL, function () {
            $overrides = AppSetting::query()->pluck('value', 'key');

            return collect(self::DEFAULTS)
                ->map(fn ($default, $key) => $overrides->has($key) ? $overrides->get($key) : $default)
                ->all();
        });
    }

    public function get(string $key, mixed $fallback = null): mixed
    {
        return $this->all()[$key] ?? $fallback;
    }

    public function int(string $key): int
    {
        return (int) $this->get($key, 0);
    }

    public function bool(string $key): bool
    {
        return (bool) $this->get($key, false);
    }

    public function float(string $key): float
    {
        return (float) $this->get($key, 0.0);
    }

    /**
     * @return list<mixed>
     */
    public function array(string $key): array
    {
        $value = $this->get($key, []);

        return is_array($value) ? array_values($value) : [];
    }

    public function set(string $key, mixed $value, ?string $updatedBy = null): void
    {
        AppSetting::query()->updateOrInsert(
            ['key' => $key],
            ['value' => json_encode($value), 'updated_by' => $updatedBy, 'updated_at' => now()],
        );

        $this->flush();
    }

    public function flush(): void
    {
        Cache::forget(self::CACHE_KEY);
    }
}
