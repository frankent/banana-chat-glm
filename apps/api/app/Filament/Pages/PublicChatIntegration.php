<?php

namespace App\Filament\Pages;

use Filament\Actions\Action;
use Filament\Pages\Page;
use Illuminate\Support\Facades\File;

/**
 * FR-ADM-016 — a concise, human- and AI-agent-readable integration guide for
 * Public Chat (FR-PCHAT), reachable from /admin. This page is a curated
 * SUMMARY, not a second copy of the truth: the exhaustive, code-verified
 * reference lives in resources/docs/public-chat/README.md (moved here from
 * the repo-root docs/ tree specifically so it ships inside the api image —
 * the prod build context is apps/api, and docs/ at the repo root is outside
 * it) and in openapi.yaml. Both are offered as direct downloads below rather
 * than re-typed on-page, so there is exactly one place each fact can drift.
 */
class PublicChatIntegration extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-book-open';

    protected static ?string $navigationGroup = 'System';

    protected static ?string $navigationLabel = 'Public Chat guide';

    protected static ?string $title = 'Public Chat integration';

    protected static string $view = 'filament.pages.public-chat-integration';

    /** The example on this page is illustrative for whichever env renders it. */
    public function baseUrl(): string
    {
        return rtrim((string) config('app.url'), '/');
    }

    /** Host including a non-default port (e.g. dev's :8000) — a bare PHP_URL_HOST would drop it. */
    public function baseHost(): string
    {
        $url = $this->baseUrl();
        $host = (string) parse_url($url, PHP_URL_HOST);
        $port = parse_url($url, PHP_URL_PORT);

        return $port !== null ? "{$host}:{$port}" : $host;
    }

    /** @return array{path: string, exists: bool, updated_at: ?string} */
    public function guideMeta(): array
    {
        $path = base_path('resources/docs/public-chat/README.md');

        return [
            'path' => $path,
            'exists' => File::exists($path),
            'updated_at' => File::exists($path) ? date('Y-m-d', File::lastModified($path)) : null,
        ];
    }

    /**
     * The six rows a partner hits first. The full table lives in the
     * downloadable guide's §6 — this is deliberately the short list.
     *
     * @return list<array{code: string, http: string, meaning: string, action: string}>
     */
    public function commonErrors(): array
    {
        return [
            ['code' => 'API_KEY_INVALID', 'http' => '401', 'meaning' => 'A header is missing, or the key/timestamp/nonce is malformed, unknown, revoked, or its workspace is inactive. (A malformed signature specifically returns API_SIGNATURE_INVALID instead — see below.)', 'action' => 'Check all 4 X-PChat-* headers are present and correctly spelled; confirm the key was issued and not revoked.'],
            ['code' => 'API_SIGNATURE_INVALID', 'http' => '401', 'meaning' => 'The recomputed HMAC did not match — including a malformed signature header.', 'action' => 'Almost always the body hash or the path line — see "Signing your requests" below.'],
            ['code' => 'API_TIMESTAMP_SKEW', 'http' => '401', 'meaning' => '|now − timestamp| > 300s.', 'action' => 'Fix your clock (NTP); never hardcode a timestamp.'],
            ['code' => 'PCHAT_DISABLED', 'http' => '503', 'meaning' => 'The feature is switched off in Settings. Write paths only — reads still answer.', 'action' => 'This is positive proof your signature verified. Retry per Retry-After; ask an admin to enable it.'],
            ['code' => 'PCHAT_ROOM_NOT_FOUND', 'http' => '404', 'meaning' => 'No such room for this key\'s workspace (also returned for another workspace\'s room, on purpose).', 'action' => 'Confirm you sent room.id (a ULID), never the visitor code.'],
            ['code' => 'RATE_LIMITED', 'http' => '429', 'meaning' => 'A named limiter tripped.', 'action' => 'Back off per details.retry_after_seconds / Retry-After.'],
        ];
    }

    protected function getHeaderActions(): array
    {
        return [
            Action::make('downloadGuide')
                ->label('Download full guide (.md)')
                ->icon('heroicon-o-arrow-down-tray')
                ->color('gray')
                ->action(fn () => response()->download(
                    base_path('resources/docs/public-chat/README.md'),
                    'public-chat-integration-guide.md',
                    ['Content-Type' => 'text/markdown; charset=UTF-8'],
                )),
            Action::make('downloadOpenApi')
                ->label('Download OpenAPI (.yaml)')
                ->icon('heroicon-o-arrow-down-tray')
                ->color('gray')
                ->action(fn () => response()->download(
                    base_path('openapi.yaml'),
                    'public-chat-openapi.yaml',
                    ['Content-Type' => 'application/yaml; charset=UTF-8'],
                )),
        ];
    }
}
