<?php

namespace App\Models\Scopes;

use App\Support\WorkspaceContext;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Scope;

/**
 * Global scope isolating workspace-bound rows (NFR-SEC-004).
 * Applied by WorkspaceContext-aware models; no-ops when no workspace is active
 * (console commands, queue jobs, admin panel cross-ws queries).
 */
class WorkspaceScope implements Scope
{
    public function apply(Builder $builder, Model $model): void
    {
        $workspaceId = app(WorkspaceContext::class)->id();

        if ($workspaceId !== null) {
            $builder->where($model->qualifyColumn('workspace_id'), $workspaceId);
        }
    }
}
