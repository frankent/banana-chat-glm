<?php

namespace App\Models;

use App\Concerns\HasUlid;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Crypt;

/**
 * §4.2 `ai_providers` — System Admin configured, OpenAI-compatible.
 * The API key is encrypted at rest and never leaves the row (FR-AI-011).
 */
class AiProvider extends Model
{
    use HasUlid;

    public const TYPE_OPENAI_COMPATIBLE = 'openai_compatible';

    protected $fillable = [
        'name', 'provider_type', 'base_url', 'api_key_encrypted', 'api_key_last4', 'model',
        'model_source', 'window_size', 'max_output_tokens', 'temperature', 'system_prompt',
        'memory_model', 'timeout_seconds', 'extra_headers', 'capabilities', 'is_enabled',
        'is_default', 'allowed_workspace_ids', 'daily_message_limit_per_user',
        'price_per_1k_in', 'price_per_1k_out', 'last_tested_at', 'last_test_status',
        'created_by', 'updated_by',
    ];

    protected $hidden = ['api_key_encrypted'];

    protected function casts(): array
    {
        return [
            'window_size' => 'integer',
            'max_output_tokens' => 'integer',
            'temperature' => 'float',
            'timeout_seconds' => 'integer',
            'extra_headers' => 'array',
            'capabilities' => 'array',
            'is_enabled' => 'boolean',
            'is_default' => 'boolean',
            'allowed_workspace_ids' => 'array',
            'daily_message_limit_per_user' => 'integer',
            'last_tested_at' => 'datetime',
            'last_test_status' => 'array',
        ];
    }

    public function plainApiKey(): string
    {
        return $this->api_key_encrypted !== null && $this->api_key_encrypted !== ''
            ? (string) Crypt::decryptString($this->api_key_encrypted)
            : '';
    }

    /**
     * FR-AI-001 — the default enabled provider conversations run against.
     */
    public static function defaultProvider(): ?self
    {
        return static::query()->where('is_enabled', true)->where('is_default', true)->first();
    }

    /**
     * FR-AI-010/011 — workspace gate + per-provider daily override.
     */
    public function allowsWorkspace(string $workspaceId): bool
    {
        return $this->allowed_workspace_ids === null
            || in_array($workspaceId, $this->allowed_workspace_ids, true);
    }
}
