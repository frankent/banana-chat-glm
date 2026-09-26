<?php

namespace App\Domain\Ai;

use App\Jobs\CompactRoomContext;
use App\Jobs\GenerateRoomBotReply;
use App\Models\AiProvider;
use App\Models\AiRoomSummary;
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
 * DEC-085: once a room's window fills, its oldest half is rolled into a
 * summary (CompactRoomContext) that rides above the raw lines, so a follow-up
 * can reach further back than ten lines without the model reading them all.
 *
 * Every line carries its sender's name because a group chat has more than two
 * voices, and the bot is expected to answer one of them. Attachments and
 * private AI memories stay out — the room sees text, so the bot sees text.
 */
class RoomContextBuilder
{
    /** @var list<int> seq of each raw line sent, oldest first — the only lines a summary may later cover */
    private array $seen = [];

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
        $this->seen = [];
        $question = $this->text($mention, false);
        if ($question === '') {
            // a mention with nothing but "@ai" in it still deserves an answer
            $question = trim((string) $mention->body);
        }

        $limit = $this->settings->int('ai.room_bot.history_messages');
        $summary = $limit < 1 ? null : $this->summary($room, $mention); // 0 still means "the mention alone"
        if ($summary !== null) {
            // a smaller provider than the one it was written for gets a shorter cut
            $cap = (int) floor($this->context->budgetIn($provider) * 0.2);
            $system .= "\n\n".self::SUMMARY_HEADER."\n".CompactRoomContext::clip($summary->summary, $cap, $this->estimator);
        }
        $budget = $this->context->budgetIn($provider) - $this->estimator->estimate($system)
            - $this->estimator->estimate($question) - 64 - $this->estimator->estimate(self::HEADER);

        $rows = $limit < 1 ? collect() : Message::withoutGlobalScopes()
            ->with('sender:id,display_name')
            ->where('room_id', $room->id)
            ->where('seq', '<', $mention->seq)
            ->where('seq', '>', $summary?->up_to_seq ?? 0) // what the summary covers is not repeated
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
            $this->seen[] = (int) $row->seq;
        }
        $this->seen = array_reverse($this->seen);

        if ($lines !== []) {
            $system .= "\n\n".self::HEADER."\n".implode("\n", array_reverse($lines));
        }

        return [
            ['role' => 'system', 'content' => $system],
            ['role' => 'user', 'content' => $question],
        ];
    }

    /** @return list<int> seq of the raw lines the last build() sent, oldest first */
    public function seen(): array
    {
        return $this->seen;
    }

    /** One transcript line, as the bot sees it; '' when the row carries nothing to say. */
    public function line(Message $message, string $botId): string
    {
        return $this->text($message, $message->sender_id === $botId);
    }

    /**
     * DEC-085 — the room's summary, unless the room is secret (its messages
     * expire and a summary would outlive them) or a covered message has been
     * edited or deleted since the summary read it. The model hooks drop the
     * row on either change already; this is the backstop for a write that
     * slips past them.
     */
    private function summary(Room $room, Message $mention): ?AiRoomSummary
    {
        if ($room->isSecret() || ! $this->settings->bool('ai.room_bot.summary_enabled')) {
            return null;
        }
        $summary = AiRoomSummary::query()->find($room->id);
        if ($summary === null || $summary->up_to_seq >= $mention->seq || $room->deleted_at !== null) {
            return null;
        }
        $changed = Message::withoutGlobalScopes()
            ->where('room_id', $room->id)
            ->whereBetween('seq', [$summary->from_seq, $summary->up_to_seq])
            ->where(fn ($q) => $q->where('deleted_at', '>=', $summary->source_read_at)->orWhere('edited_at', '>=', $summary->source_read_at))
            ->exists();
        if ($changed) {
            $summary->delete();

            return null;
        }

        return $summary;
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

    private const SUMMARY_HEADER = "## Earlier in this room — summary, background only\n"
        .'A summary of older messages. Same rule: do not reply to it; use it only when the question needs it.';

    private const HEADER = "## Recent room messages — background only\n"
        .'These were said before you were called and are already handled. Do NOT reply to them, summarise them or comment on them. '
        .'Use a line only when the question you are answering refers to it. Lines marked "'.self::SELF.'" are your own earlier replies.';
}
