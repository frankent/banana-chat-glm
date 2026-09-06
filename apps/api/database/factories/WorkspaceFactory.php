<?php

namespace Database\Factories;

use App\Enums\WorkspaceStatus;
use App\Models\Workspace;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/** @extends Factory<Workspace> */
class WorkspaceFactory extends Factory
{
    public function definition(): array
    {
        $slug = 'ws-'.strtolower(Str::random(6));

        return [
            'slug' => $slug,
            'name' => Str::headline($slug).' Co.',
            'status' => WorkspaceStatus::Active,
        ];
    }

    public function archived(): static
    {
        return $this->state(fn () => ['status' => WorkspaceStatus::Archived]);
    }
}
