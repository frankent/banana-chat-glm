<?php

namespace App\Jobs;

use App\Domain\Ai\AiGate;
use App\Domain\Ai\AiProviderException;
use App\Domain\Ai\ContextBuilder;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Domain\Ai\RoomContextBuilder;
use App\Domain\Ai\TokenEstimator;
use App\Models\AiRoomSummary;
use App\Models\Message;
use App\Models\Room;
use App\Models\User;
use App\Services\SettingsService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Carbon;

/**
 * DEC-085 — the room bot's counterpart of CompactConversation (FR-AI-005):
 * once a mention's window is full, its oldest half is rolled into the room's
 * summary so the next mention can reach further back without reading it all.
 *
 * It only ever summarises lines the bot was already sent ($fromSeq..$toSeq
 * come from that mention's transcript), so nothing reaches the provider that
 * the room's AI consent did not already cover. No backfill of older history.
 */
class CompactRoomContext implements ShouldBeUnique, ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 1;

    public int $timeout = 120;

    public function __construct(
        public readonly string $roomId,
        public readonly string $userId,
        public readonly int $fromSeq,
        public readonly int $toSeq,
        public readonly string $sentAt, // when that mention's transcript was read
    ) {}

    public function uniqueId(): string
    {
        return $this->roomId;
    }

    public function handle(RoomContextBuilder $lines, ContextBuilder $context, TokenEstimator $estimator, SettingsService $settings, AiGate $gate): void
    {
        if (! $this->eligible($settings)) {
            return;
        }
        $room = Room::withoutGlobalScopes()->findOrFail($this->roomId);
        // the same gate the mention passed: AI still on, workspace still allowed, requester still consented
        [$provider, $error] = $gate->resolve($this->userId, $room->workspace_id);
        $bot = User::query()->where('username', '__banana_ai_bot__')->first();
        if ($error !== null || $provider === null || $bot === null) {
            return;
        }

        $readAt = now()->startOfSecond(); // message timestamps are whole seconds; round toward "changed"
        $existing = AiRoomSummary::query()->find($room->id);
        if ($existing !== null && $existing->up_to_seq >= $this->toSeq) {
            return; // a later mention already rolled this far
        }
        if ($existing !== null && $this->changed($existing->from_seq, $existing->up_to_seq, $existing->source_read_at)) {
            $existing->delete(); // it quotes something since edited or deleted — never send it on
            $existing = null;
        }

        $from = max($this->fromSeq, ($existing?->up_to_seq ?? 0) + 1);
        $sentAt = Carbon::parse($this->sentAt)->startOfSecond();
        $transcript = Message::withoutGlobalScopes()
            ->with('sender:id,display_name')
            ->where('room_id', $room->id)
            ->whereBetween('seq', [$from, $this->toSeq])
            ->whereNull('deleted_at')
            ->where('type', '!=', 'system')
            ->whereNotNull('body')
            ->whereNull('metadata->bot_notice')
            // only the version the bot was sent: a line edited since then was never covered by that consent
            ->where(fn ($q) => $q->whereNull('edited_at')->orWhere('edited_at', '<', $sentAt))
            ->orderBy('seq')
            ->get()
            ->map(fn (Message $m) => $lines->line($m, $bot->id))
            ->filter()
            ->implode("\n");
        if ($transcript === '') {
            return;
        }

        try {
            $summary = trim(OpenAiCompatibleProvider::make($provider)->chat([
                ['role' => 'system', 'content' => self::PROMPT],
                ['role' => 'user', 'content' => ($existing !== null ? "Previous summary:\n{$existing->summary}\n\n" : '')."New messages:\n{$transcript}"],
            ], $provider->memory_model));
        } catch (AiProviderException) {
            return; // the next full window tries again
        }
        $summary = self::clip($summary, min(1500, (int) floor($context->budgetIn($provider) * 0.15)), $estimator);
        if ($summary === '') {
            return;
        }

        // the room was moderated, or a covered line changed, while the model was writing
        $coveredFrom = $existing?->from_seq ?? $from;
        if (! $this->eligible($settings) || $this->changed($coveredFrom, $this->toSeq, $readAt)
            || ($existing !== null && ! AiRoomSummary::query()->whereKey($room->id)->exists())) {
            return;
        }

        AiRoomSummary::query()->updateOrCreate(['room_id' => $room->id], [
            'summary' => $summary,
            'from_seq' => $coveredFrom,
            'up_to_seq' => $this->toSeq,
            'summary_tokens' => $estimator->estimate($summary),
            // the old part was checked unchanged up to $readAt and the new part read at it
            'source_read_at' => $readAt,
        ]);
    }

    /** Estimator-true trim: Thai runs ~1 token per char, so a char budget alone overshoots. */
    public static function clip(string $text, int $maxTokens, TokenEstimator $estimator): string
    {
        $text = trim($text);
        while ($text !== '' && $estimator->estimate($text) > $maxTokens) {
            $text = trim(mb_substr($text, 0, (int) floor(mb_strlen($text) * 0.9)));
        }

        return $text;
    }

    private function eligible(SettingsService $settings): bool
    {
        $room = Room::withoutGlobalScopes()->find($this->roomId);

        return $room !== null && $room->deleted_at === null && ! $room->isSecret()
            && $settings->bool('ai.room_bot.summary_enabled') && $settings->int('ai.room_bot.history_messages') > 0;
    }

    private function changed(int $from, int $to, \DateTimeInterface $since): bool
    {
        return Message::withoutGlobalScopes()
            ->where('room_id', $this->roomId)
            ->whereBetween('seq', [$from, $to])
            ->where(fn ($q) => $q->where('deleted_at', '>=', $since)->orWhere('edited_at', '>=', $since))
            ->exists();
    }

    private const PROMPT = 'Summarise this group-chat excerpt for an assistant who will be asked questions in the room later. '
        .'Keep who said what (by name), facts, numbers, decisions, open questions, and what was asked of the AI with the gist of its answer. '
        .'Drop greetings and small talk. Merge with the previous summary if one is given; newer facts win. '
        .'Short bullet points, in the language the chat uses. Output only the summary.';
}
