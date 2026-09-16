<?php

namespace App\Domain\PublicChat;

use App\Models\PublicChatApiKey;
use App\Models\User;
use App\Services\AuditLogger;
use Illuminate\Support\Facades\Crypt;

/**
 * FR-PCHAT-030/032 — partner credential issuance, revocation and rotation.
 *
 * Consumed by the Filament admin resource (PublicChatApiKeyResource). It has no
 * HTTP route of its own on purpose: issuing an integration credential is a
 * system-admin act through the audited admin panel, never a workspace API call.
 *
 * ==== THE SECRET IS RETURNED EXACTLY ONCE =================================
 * issue() and rotate() are the ONLY places the plaintext exists. It goes
 * straight into the caller's one-time notification and is never persisted in
 * plaintext, never logged, never put in the audit context, never round-tripped
 * through any endpoint, and never readable back (PublicChatApiKey $hidden's the
 * ciphertext and the admin sees '****'.$secret_last4). TC-PCHAT-048 asserts the
 * secret is absent from the audit row.
 *
 * DEC-062 — at rest it is Crypt::encryptString under APP_KEY, NOT a hash. HMAC
 * verification must recompute the MAC with the key material and a digest cannot
 * supply one. RUNBOOK: rotating APP_KEY invalidates every partner secret and
 * every key must be reissued.
 */
class PublicChatApiKeyService
{
    public function __construct(
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @return array{key: PublicChatApiKey, key_id: string, secret: string}
     */
    public function issue(string $workspaceId, string $name, ?User $admin = null): array
    {
        $keyId = PublicChatApiKey::generateKeyId();
        $secret = PublicChatApiKey::generateSecret();

        $key = PublicChatApiKey::withoutGlobalScopes()->create([
            'workspace_id' => $workspaceId,
            'name' => mb_substr(trim($name), 0, 80),
            'key_id' => $keyId,
            'secret_ciphertext' => Crypt::encryptString($secret),
            'secret_last4' => substr($secret, -4),
            'created_by_admin_id' => $admin?->id,
        ]);

        // key_id only. It is the PUBLIC identifier named by the signature header
        // and is safe to log; the secret must never appear here.
        $this->audit->log('public_chat.api_key_issued', $admin, 'public_chat_api_key', $key->id, [
            'key_id' => $keyId,
            'name' => $key->name,
        ], $workspaceId);

        return ['key' => $key, 'key_id' => $keyId, 'secret' => $secret];
    }

    /**
     * FR-PCHAT-032 — revocation is a ROW UPDATE, never a delete, so the audit
     * trail survives. Every subsequent HMAC call with this key_id gets 401
     * API_KEY_INVALID at verification step 3.
     *
     * ROOMS THE KEY ALREADY CREATED STAY OPEN AND THEIR LINKS KEEP WORKING.
     * A key is an integration credential, not the owner of customer
     * conversations; killing live customer chats because an ops key rotated
     * would be a worse failure than the one revocation exists to prevent. (It is
     * also why the create-idempotency unique excludes api_key_id: a
     * revoke+issue must not make the partner's retry create a duplicate room.)
     */
    public function revoke(PublicChatApiKey $key, ?User $admin = null): PublicChatApiKey
    {
        if ($key->isRevoked()) {
            return $key;
        }

        $key->forceFill(['revoked_at' => now()])->save();

        $this->audit->log('public_chat.api_key_revoked', $admin, 'public_chat_api_key', $key->id, [
            'key_id' => $key->key_id,
        ], $key->workspace_id);

        return $key;
    }

    /**
     * Revoke + issue, one new secret. Same workspace, same name, new key_id.
     *
     * @return array{key: PublicChatApiKey, key_id: string, secret: string}
     */
    public function rotate(PublicChatApiKey $old, ?User $admin = null): array
    {
        $this->revoke($old, $admin);

        $issued = $this->issue($old->workspace_id, $old->name, $admin);

        $this->audit->log('public_chat.api_key_rotated', $admin, 'public_chat_api_key', $issued['key']->id, [
            'previous_key_id' => $old->key_id,
            'key_id' => $issued['key_id'],
        ], $old->workspace_id);

        return $issued;
    }
}
