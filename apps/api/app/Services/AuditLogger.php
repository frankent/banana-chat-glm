<?php

namespace App\Services;

use App\Enums\ActorType;
use App\Models\AuditLog;
use App\Models\User;
use Illuminate\Http\Request;

/**
 * Append-only audit trail (spec §4.2 audit_logs, FR-AUD). Actions are dotted
 * strings like `auth.login`, `auth.password_changed`, `room.deleted`.
 */
class AuditLogger
{
    public function log(
        string $action,
        ?User $actor = null,
        ?string $targetType = null,
        ?string $targetId = null,
        array $context = [],
        ?string $workspaceId = null,
        ?Request $request = null,
        ActorType $actorType = ActorType::User,
    ): AuditLog {
        return AuditLog::create([
            'workspace_id' => $workspaceId,
            'actor_id' => $actor?->id,
            'actor_type' => $actor !== null ? ($actor->is_system_admin ? ActorType::Admin : ActorType::User) : $actorType,
            'action' => $action,
            'target_type' => $targetType,
            'target_id' => $targetId,
            'context' => $context ?: null,
            'ip' => $request?->ip(),
            'created_at' => now(),
        ]);
    }

    /**
     * System-originated audit row (no user actor).
     */
    public function system(
        string $action,
        ?string $workspaceId = null,
        ?string $targetType = null,
        ?string $targetId = null,
        array $context = [],
    ): AuditLog {
        return AuditLog::create([
            'workspace_id' => $workspaceId,
            'actor_id' => null,
            'actor_type' => ActorType::System,
            'action' => $action,
            'target_type' => $targetType,
            'target_id' => $targetId,
            'context' => $context ?: null,
            'created_at' => now(),
        ]);
    }
}
