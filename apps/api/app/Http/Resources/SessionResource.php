<?php

namespace App\Http\Resources;

use App\Models\ChatSession;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin ChatSession */
class SessionResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->id,
            'device_name' => $this->device?->device_name,
            'platform' => $this->device?->platform?->value,
            'ip' => $this->ip,
            'last_used_at' => $this->last_used_at?->toIso8601String(),
            'created_at' => $this->created_at?->toIso8601String(),
            'expires_at' => $this->expires_at->toIso8601String(),
            'is_current' => (bool) $this->is_current,
        ];
    }
}
