<?php

namespace App\Auth;

use App\Models\User;
use Illuminate\Auth\EloquentUserProvider;
use Illuminate\Contracts\Auth\Authenticatable as UserContract;

/**
 * FR-ADM-001 — user provider for the `admin` guard: same users table,
 * but only `is_system_admin` accounts can authenticate into /admin.
 */
class SystemAdminUserProvider extends EloquentUserProvider
{
    protected function newModelQuery($model = null)
    {
        return parent::newModelQuery($model)->where('is_system_admin', true);
    }

    public function retrieveById($identifier): ?UserContract
    {
        return $this->newModelQuery()->find($identifier);
    }

    public function retrieveByToken($identifier, $token): ?UserContract
    {
        // Admin guard sessions must not piggyback on the web guard's remember tokens.
        return null;
    }
}
