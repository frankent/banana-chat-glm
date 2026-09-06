<?php

namespace App\Support;

use App\Models\Workspace;
use App\Models\WorkspaceMember;

/**
 * Per-request active workspace (NFR-SEC-004). Set by workspace.context middleware
 * (Phase 4); consumers read it here. Pure state holder — no request coupling,
 * so tests and console commands can set it explicitly.
 */
class WorkspaceContext
{
    protected ?Workspace $workspace = null;

    protected ?WorkspaceMember $membership = null;

    public function set(Workspace $workspace, ?WorkspaceMember $membership = null): void
    {
        $this->workspace = $workspace;
        $this->membership = $membership;
    }

    public function clear(): void
    {
        $this->workspace = null;
        $this->membership = null;
    }

    public function id(): ?string
    {
        return $this->workspace?->getKey();
    }

    public function workspace(): ?Workspace
    {
        return $this->workspace;
    }

    public function membership(): ?WorkspaceMember
    {
        return $this->membership;
    }

    public function isActive(): bool
    {
        return $this->workspace !== null;
    }
}
