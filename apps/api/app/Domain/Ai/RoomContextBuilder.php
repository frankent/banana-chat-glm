<?php

namespace App\Domain\Ai;

use App\Models\AiProvider;
use App\Models\Message;
use App\Models\Room;
use App\Services\SettingsService;

/**
 * FR-AI-021 — the room bot's view of the conversation it was called into.
 *
 * The bot used to receive the mention and nothing else, so it could not follow
 * up on its own previous answer, let alone on what the room was discussing.
 * It now reads back from the mention: newest first until either the message cap
 * or the provider's input budget runs out, then oldest-first for the provider.
 *
 * Every turn carries its sender's name because a group chat has more than two
 * voices, and the bot is expected to answer one of them. Attachments and
 * private AI memories stay out — the room sees text, so the bot sees text.
 */
class RoomContextBuilder
{
    public function __construct(
        private readonly TokenEstimator $estimator,
        private readonly ContextBuilder $context,
        private readonly SettingsService $settings,
    ) {}

    /**
     * @return list<array{role: string, content: string}> oldest → newest, ending on $mention
     */
    public function build(Room $room, Message $mention, AiProvider $provider, string $botId, string $system): array
    {
        $limit = $this->settings->int('ai.room_bot.history_messages');
        $budget = $this->context->budgetIn($provider) - $this->estimator->estimate($system) - 64;

        $rows = Message::withoutGlobalScopes()
            ->with('sender:id,display_name')
            ->where('room_id', $room->id)
            ->where('seq', '<=', $mention->seq)
            ->whereNull('deleted_at')
            ->where('type', '!=', 'system')
            ->whereNotNull('body')
            ->orderByDesc('seq')
            ->limit(max(1, $limit + 1)) // + the mention itself
            ->get();

        $used = 0;
        $turns = [];
        foreach ($rows as $row) {
            $isBot = $row->sender_id === $botId;
            $text = $this->text($row, $isBot);
            if ($text === '') {
                continue;
            }
            $cost = $this->estimator->estimate($text) + 4; // + role overhead
            if ($used + $cost > $budget && $turns !== []) {
                break; // never drop the mention itself — it is the question
            }
            $used += $cost;
            $turns[] = ['role' => $isBot ? 'assistant' : 'user', 'content' => $text];
        }

        return array_reverse($turns);
    }

    /** The bot speaks as itself; everyone else is introduced by name. */
    private function text(Message $message, bool $isBot): string
    {
        $body = trim((string) preg_replace('/(?:^|\s)@ai(?=\s|[,:!?]|$)/iu', ' ', (string) $message->body));
        if ($body === '' || $isBot) {
            return $isBot ? trim((string) $message->body) : '';
        }

        return trim(($message->sender?->display_name ?? 'Someone').': '.$body);
    }
}
