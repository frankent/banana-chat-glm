<?php

namespace App\Domain\Ai;

use App\Jobs\GenerateRoomBotReply;
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
 * DEC-084: that history is a transcript inside the system prompt, not a run of
 * chat turns. Sent as turns, a busy room reached the model as ~20 unanswered
 * `user` messages with at most a couple of bot answers between them, and the
 * model answered every one of them — the actual question got buried in replies
 * to small talk. The mention is the only `user` turn, so it is the only thing
 * the model is asked to answer.
 *
 * Every line carries its sender's name because a group chat has more than two
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
     * @return list<array{role: string, content: string}> [system (+ transcript), user (the mention)]
     */
    public function build(Room $room, Message $mention, AiProvider $provider, string $botId, string $system): array
    {
        $question = $this->text($mention, false);
        if ($question === '') {
            // a mention with nothing but "@ai" in it still deserves an answer
            $question = trim((string) $mention->body);
        }

        $limit = $this->settings->int('ai.room_bot.history_messages');
        $budget = $this->context->budgetIn($provider) - $this->estimator->estimate($system)
            - $this->estimator->estimate($question) - 64 - $this->estimator->estimate(self::HEADER);

        $rows = $limit < 1 ? collect() : Message::withoutGlobalScopes()
            ->with('sender:id,display_name')
            ->where('room_id', $room->id)
            ->where('seq', '<', $mention->seq)
            ->whereNull('deleted_at')
            ->where('type', '!=', 'system')
            ->whereNotNull('body')
            ->whereNull('metadata->bot_notice')
            ->orderByDesc('seq')
            ->limit($limit)
            ->get();

        $used = 0;
        $lines = [];
        foreach ($rows as $row) {
            $text = $this->text($row, $row->sender_id === $botId);
            if ($text === '') {
                continue;
            }
            $cost = $this->estimator->estimate($text) + 1;
            if ($used + $cost > $budget) {
                break;
            }
            $used += $cost;
            $lines[] = $text;
        }

        if ($lines !== []) {
            $system .= "\n\n".self::HEADER."\n".implode("\n", array_reverse($lines));
        }

        return [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user', 'content' => $question],
        ];
    }

    /** The bot speaks as itself; everyone else is introduced by name. */
    private function text(Message $message, bool $isBot): string
    {
        if ($isBot) {
            // a notice ("accept consent", "limit reached") is not something the bot said about the topic
            $body = (string) $message->body;
            $body = GenerateRoomBotReply::isNotice($body) ? '' : GenerateRoomBotReply::stripNotes($body);

            return $body === '' ? '' : self::SELF.': '.$body;
        }
        $body = trim((string) preg_replace('/(?:^|\s)@ai(?=\s|[,:!?]|$)/iu', ' ', (string) $message->body));
        if ($body === '') {
            return '';
        }

        return trim(($message->sender?->display_name ?? 'Someone').': '.$body);
    }

    public const SELF = 'You (AI)';

    private const HEADER = "## Recent room messages — background only\n"
        .'These were said before you were called and are already handled. Do NOT reply to them, summarise them or comment on them. '
        .'Use a line only when the question you are answering refers to it. Lines marked "'.self::SELF.'" are your own earlier replies.';
}
