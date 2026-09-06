<?php

namespace App\Http\Resources;

use App\Models\User;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin User */
class UserResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'username' => $this->username,
            'display_name' => $this->display_name,
            'avatar_attachment_id' => $this->avatar_attachment_id,
            'status' => $this->status->value,
            'locale' => $this->locale,
            'timezone' => $this->timezone,
            'last_seen_at' => $this->last_seen_at?->toIso8601String(),
            'is_system_admin' => $this->is_system_admin,
            'must_change_password' => $this->must_change_password,
        ];
    }
}
