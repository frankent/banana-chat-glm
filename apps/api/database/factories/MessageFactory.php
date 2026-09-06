<?php

namespace Database\Factories;

use App\Enums\MessageType;
use App\Models\Message;
use App\Models\Room;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/** @extends Factory<Message> */
class MessageFactory extends Factory
{
    public function definition(): array
    {
        return [
            'room_id' => null, // required via ->for()
            'workspace_id' => null, // required — set by configure from room
            'sender_id' => User::factory(),
            'seq' => 1,
            'type' => MessageType::Text,
            'body' => fake()->sentence(),
            'client_message_id' => (string) Str::uuid(),
        ];
    }

    public function configure(): static
    {
        return $this->afterMaking(function (Message $message) {
            if ($message->workspace_id === null && $message->room_id !== null) {
                $message->workspace_id = Room::query()
                    ->whereKey($message->room_id)
                    ->value('workspace_id');
            }
        });
    }

    public function system(array $event = []): static
    {
        return $this->state(fn () => [
            'type' => MessageType::System,
            'sender_id' => null,
            'client_message_id' => null,
            'system_event' => $event ?: ['type' => 'generic'],
        ]);
    }
}
