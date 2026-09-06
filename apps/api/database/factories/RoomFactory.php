<?php

namespace Database\Factories;

use App\Enums\RoomType;
use App\Models\Room;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/** @extends Factory<Room> */
class RoomFactory extends Factory
{
    public function definition(): array
    {
        return [
            'workspace_id' => null, // required via ->for() or state
            'type' => RoomType::Group,
            'name' => 'Room '.fake()->word(),
            'created_by' => User::factory(),
            'owner_id' => null,
        ];
    }

    public function configure(): static
    {
        return $this->afterMaking(function (Room $room) {
            if ($room->owner_id === null) {
                $room->owner_id = $room->created_by;
            }
        });
    }

    public function group(): static
    {
        return $this->state(fn () => ['type' => RoomType::Group, 'name' => 'Group '.fake()->word()]);
    }

    public function dm(): static
    {
        return $this->state(fn () => ['type' => RoomType::Dm, 'name' => null, 'dm_key' => 'dmkey_'.fake()->sha256()]);
    }
}
