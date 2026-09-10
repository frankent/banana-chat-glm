<?php

namespace App\Providers;

use App\Enums\UserStatus;
use App\Models\User;
use Illuminate\Support\Facades\Gate;
use Laravel\Horizon\Horizon;
use Laravel\Horizon\HorizonApplicationServiceProvider;

class HorizonServiceProvider extends HorizonApplicationServiceProvider
{
    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        parent::boot();

        // FR-ADM-013: use the same guard as /admin in every environment.
        Horizon::auth(function ($request) {
            $user = auth('admin')->user();

            return $user instanceof User && $user->is_system_admin && $user->status === UserStatus::Active;
        });

        // NFR-OPS-011 / TASK-INF-014 — queue lag alerts flow through the
        // ops channel once configured; log-based alerting covers the rest.
        // Horizon::routeSlackNotificationsTo(env('OPS_SLACK_WEBHOOK'), '#alerts');
    }

    /**
     * FR-ADM-001 — Horizon dashboard is system-admin only (same rule as the
     * Filament panel; never local-env open access).
     */
    protected function gate(): void
    {
        Gate::define('viewHorizon', function ($user = null) {
            return $user instanceof User
                && $user->is_system_admin
                && $user->status === UserStatus::Active;
        });
    }
}
