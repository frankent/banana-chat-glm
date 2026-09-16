<?php

namespace App\Models;

use App\Concerns\HasUlid;
use App\Models\Scopes\WorkspaceScope;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Str;

/**
 * FR-PCHAT-030/031/032 — a partner integration credential for the Tier-1
 * HMAC surface (`/api/v1/partner/public-chat/*`).
 *
 * DEC-062 — THE SECRET IS ENCRYPTED, NOT HASHED, and that is not an oversight.
 * HMAC verification must recompute hash_hmac('sha256', $canonical, $secret),
 * which requires the plaintext key material; a sha256/bcrypt digest cannot
 * supply one, so "HMAC-signed" and "stored hashed" cannot both hold. The
 * property the decision actually wanted — never retrievable through any UI or
 * API after issuance — is preserved unchanged: no endpoint and no Filament
 * field ever reads secret_ciphertext back out, the model $hidden's it, and the
 * admin sees only '****'.$secret_last4. The at-rest boundary moves from "DB
 * dump" to "DB dump AND APP_KEY", which is the boundary
 * AiProvider::$api_key_encrypted already accepts in this codebase.
 * RUNBOOK CONSEQUENCE: rotating APP_KEY invalidates EVERY partner secret,
 * because Crypt::decryptString will fail for all of them. Every key must be
 * reissued as part of an APP_KEY rotation. Do not "fix" this back to a hash.
 *
 * DEC-070 — WorkspaceScope is kept. It is protective on Tier 3, where
 * workspace.context has set WorkspaceContext, and INERT on Tier 1, where the
 * key is looked up by key_id before any workspace context exists (the lookup
 * is the thing that establishes it). Tier-1 code must therefore keep filtering
 * workspace_id explicitly on everything it reads afterwards.
 *
 * @property string $id
 * @property string $workspace_id
 * @property string $name
 * @property string $key_id
 * @property string $secret_ciphertext
 * @property string $secret_last4
 * @property ?string $created_by_admin_id
 * @property ?Carbon $last_used_at
 * @property ?Carbon $revoked_at
 */
class PublicChatApiKey extends Model
{
    use HasUlid;

    /** 'pck_' + 28 lowercase hex = 32 chars, matching char(32). */
    public const KEY_ID_PREFIX = 'pck_';

    /** 'pcs_' + 64 lowercase hex = 68 chars. */
    public const SECRET_PREFIX = 'pcs_';

    protected static function booted(): void
    {
        static::addGlobalScope(WorkspaceScope::class);
    }

    protected $fillable = [
        'workspace_id',
        'name',
        'key_id',
        'secret_ciphertext',
        'secret_last4',
        'created_by_admin_id',
        'last_used_at',
        'revoked_at',
    ];

    /**
     * The ciphertext must never reach a response, a log, an export, a Filament
     * field or an audit payload. Issuance is the only moment the plaintext
     * exists, and it exists only in the one-time admin notification.
     */
    protected $hidden = ['secret_ciphertext'];

    protected function casts(): array
    {
        return [
            'last_used_at' => 'datetime',
            'revoked_at' => 'datetime',
        ];
    }

    /**
     * MANDATORY graft 9 — the 'pck_' shape is deliberately pattern-matchable so
     * a credential committed to a partner's public repo is caught by
     * gitleaks/GitHub secret scanning.
     */
    public static function generateKeyId(): string
    {
        return self::KEY_ID_PREFIX.bin2hex(random_bytes(14)); // 28 hex chars
    }

    /** Shown EXACTLY once, at issuance. 'pcs_' + 64 hex. */
    public static function generateSecret(): string
    {
        return self::SECRET_PREFIX.bin2hex(random_bytes(32));
    }

    /**
     * Decrypts the secret for HMAC verification. Callers MUST wrap this in a
     * try/catch for Illuminate\Contracts\Encryption\DecryptException: after an
     * APP_KEY rotation this throws for every row, and an uncaught throw turns
     * every partner request into a 500 with a stack trace instead of a 401
     * (MANDATORY graft 8). VerifyPublicChatSignature does exactly that.
     */
    public function plainSecret(): string
    {
        return (string) Crypt::decryptString($this->secret_ciphertext);
    }

    public function isRevoked(): bool
    {
        return $this->revoked_at !== null;
    }

    /**
     * MANDATORY graft 7 — at most one last_used_at UPDATE per key per minute.
     * The naive "write on every request" costs one UPDATE per partner API call
     * for no extra operator value.
     */
    public function touchLastUsedThrottled(): void
    {
        if ($this->last_used_at !== null && $this->last_used_at->greaterThan(now()->subMinute())) {
            return;
        }

        $this->forceFill(['last_used_at' => now()])->saveQuietly();
    }

    /** Masked display form for the admin panel. Never the real secret. */
    public function maskedSecret(): string
    {
        return '****'.$this->secret_last4;
    }

    public function workspace(): BelongsTo
    {
        return $this->belongsTo(Workspace::class);
    }

    public function createdByAdmin(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by_admin_id');
    }

    /**
     * Provenance only. FR-PCHAT-032: revoking a key does NOT close the rooms it
     * created and does NOT break their visitor links — a key is an integration
     * credential, not the owner of customer conversations.
     */
    public function rooms(): HasMany
    {
        return $this->hasMany(PublicChatRoom::class, 'api_key_id');
    }

    /**
     * Tier-1 lookup helper. Deliberately withoutGlobalScopes(): the key IS what
     * establishes the workspace on the HMAC tier, so no context exists yet and
     * WorkspaceScope would be inert anyway — saying so explicitly stops a future
     * reader from assuming a scope is protecting this line.
     */
    public static function findActiveByKeyId(string $keyId): ?self
    {
        if (! Str::startsWith($keyId, self::KEY_ID_PREFIX) || strlen($keyId) !== 32) {
            return null;
        }

        return static::query()
            ->withoutGlobalScopes()
            ->where('key_id', $keyId)
            ->whereNull('revoked_at')
            ->first();
    }
}
