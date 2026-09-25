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
        'message.forward_max_messages' => 20,
        'message.forward_max_rooms' => 10,
        'upload.image.max_bytes' => 20971520,
        'upload.video.max_bytes' => 209715200,
        'upload.file.max_bytes' => 104857600,
        'upload.image.allowed_mimes' => ['jpeg', 'png', 'gif', 'webp', 'heic'],
        'upload.video.allowed_mimes' => ['mp4', 'quicktime', 'webm'],
        // LAYER 1 of the FR-MEDIA-004 inline-XSS defence (DEC-072).
        //
        // The original list only stopped things that execute on the VICTIM'S
        // MACHINE. It said nothing about things that execute IN THE BROWSER, in
        // OUR OWN ORIGIN — and production serves MinIO under the app's own host
        // (the bucket rides the URL path), so an object replayed with
        // Content-Type: text/html or image/svg+xml is same-origin stored XSS
        // against every reader of that transcript, including an agent with a
        // live session. FR-PCHAT-020 made that reachable by an UNAUTHENTICATED
        // visitor holding nothing but a /support/<code> link.
        //
        // Extensions are NOT the real defence — a renamed .txt sails past any
        // list — they are the cheapest of three layers. The other two are
        // UploadService::assertMimeMatchesKind (the SNIFFED type, which a rename
        // cannot lie about) and the forced response disposition in
        // MediaUrls/UploadController (which protects objects ALREADY stored,
        // the only layer that helps retroactively).
        //
        // DEC-072 — THIS LIST IS THE FLOOR, ENFORCED ON EVERY SURFACE. It is
        // NOT the whole story: the unauthenticated Public Chat surface refuses
        // the markup family (html + svg/svgz/xml/xsl/xslt/xhtml/xht/mhtml) on
        // top of it, from the hard-coded
        // InlineSafety::PUBLIC_CHAT_BLOCKED_EXTENSIONS — hard-coded precisely
        // because this setting is admin-editable and narrowing it must not be
        // able to reopen that surface.
        //
        // svg/xml are deliberately ABSENT here: FR-MEDIA-004/005 spec "accept
        // SVG, serve it as an attachment, never inline" for internal uploads,
        // and blocking them at upload time would both break that and protect
        // nothing already in the bucket. The read-time disposition does that
        // job for every stored object.
        //
        // Three groups, all kept in one list because SettingsService::array()
        // returns one flat value an admin can override wholesale:
        //  - html, which a browser renders as a DOCUMENT in our origin, and the
        //    archive containers that carry one
        //  - script sources a browser or Windows shell will run
        //  - the original native-execution set, unchanged
        'upload.file.blocked_extensions' => [
            // browser-executable documents — the inline-XSS vector
            'html', 'htm', 'shtml', 'shtm', 'hta', 'htc', 'mhtml', 'mht',
            // script sources a browser or Windows shell will run
            'js', 'mjs', 'cjs', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1',
            // native execution (the original list — DO NOT REMOVE)
            'exe', 'bat', 'cmd', 'sh', 'msi', 'scr', 'jar', 'com',
            // Windows shell payloads that execute on preview/click
            'lnk', 'scf', 'url', 'reg', 'cpl',
        ],
        'upload.multipart_threshold_bytes' => 52428800, // TASK-BE-024: >50MB on s3 ⇒ multipart
        'upload.multipart_part_bytes' => 8388608, // 8MB parts (S3 min 5MB, max 10k parts)
        'room.group.max_members' => 500,
        'room.deleted_purge_days' => 30,
        'call.max_participants' => 8, // FR-CALL-006 / DEC-057: group calls + public meetings (dm stays 2)
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
        'app.min_supported_version' => '', // TASK-BE-025: '' = gate off
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
        'ai.room_bot.history_messages' => 20, // FR-AI-021 — 0 sends the mention alone
        'ai.deleted_purge_days' => 30,
        'ai.admin_review_enabled' => false,
        'ai.push_suppress_if_focused_seconds' => 30,
        // FR-PCHAT-033/034 / DEC-071 — the Public Chat kill switch. SHIPS OFF:
        // this is a new externally-reachable, unauthenticated customer surface,
        // so enabling it must be a deliberate admin act rather than something a
        // migration deploy turns on. DEC-067 defines "off": writes stop, reads
        // and data survive — Tier 1 create/close 503, Tier 2 visitor GET still
        // 200 with feature_enabled:false, Tier 3 agent writes 503, agent reads
        // and the Filament transcript unaffected, nothing closed or deleted.
        //
        // NOTE FOR WHOEVER ADDS publicchat.link_ttl_days / max_message_length:
        // Settings::form() does [$min,$max] = self::ranges()[$key] with NO isset
        // guard, so a NUMERIC key added here without a matching
        // App\Filament\Pages\Settings::ranges() entry throws on the settings
        // page for every admin — taking down the very page that turns this
        // feature off. Add both halves in the same change, never one.
        'publicchat.enabled' => false,
        // FR-ADM-015/DEC-082 — the admin-uploaded system logo's storage path
        // (local disk, `branding/` dir), or null when unset. Deliberately NOT
        // rendered by Settings::form()'s generic type-inference loop — a file
        // path needs a FileUpload widget, not a text/numeric field, so
        // Settings.php special-cases and skips this key explicitly in both
        // form() and save(). See that file before assuming this key behaves
        // like every other DEFAULTS entry.
        'branding.logo_path' => null,
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
