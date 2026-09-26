<?php

namespace App\Jobs;

use App\Domain\Ai\AiCircuitBreaker;
use App\Domain\Ai\AiGate;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Domain\Ai\RoomContextBuilder;
use App\Domain\Ai\TokenEstimator;
use App\Domain\Message\MessageSerializer;
use App\Domain\Message\MessageWriter;
use App\Events\MessageStreamed;
use App\Events\RoomToolEvent;
use App\Models\AiProvider;
use App\Models\AiUsageDaily;
use App\Models\Message;
use App\Models\Room;
use App\Models\RoomMember;
use App\Models\User;
use App\Models\WorkspaceMember;
use App\Services\SettingsService;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Ramsey\Uuid\Uuid;
use Throwable;

/** FR-AI-021: explicit @ai only, no room history, attachments, or private memory. */
class GenerateRoomBotReply implements ShouldBeUnique, ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 1;

    public int $timeout = 660;

    public int $uniqueFor = 900;

    /** The bot's own message, once the first words of the answer have been posted. */
    private ?Message $posted = null;

    private float $typingSentAt = 0.0;

    public function __construct(public readonly string $messageId) {}

    public function uniqueId(): string
    {
        return $this->messageId;
    }

    public const NOTICE_CONSENT = 'Please open AI Assistant and accept AI consent before mentioning @ai. Recent messages of this room are sent as context, and the reply is visible to everyone here.';

    public const NOTICE_UNAVAILABLE = 'AI is unavailable (%s). Please ask your workspace administrator.';

    public const NOTICE_BUSY = 'AI is already answering your earlier request. Please try again shortly.';

    public const NOTICE_QUOTA = 'Your daily AI message limit has been reached.';

    public const NOTICE_CIRCUIT = 'AI is temporarily unavailable. Please try again later.';

    public const NOTICE_FAILED = 'AI could not complete this request. Please try again later.';

    public const NOTICE_EMPTY = 'AI returned an empty answer. Please try again.';

    public const TRUNCATED = '[Answer truncated to message limit]';

    /** Bot rows posted before notices were tagged in metadata (DEC-084). */
    public static function isNotice(string $body): bool
    {
        $body = trim($body);

        return in_array($body, [self::NOTICE_CONSENT, self::NOTICE_BUSY, self::NOTICE_QUOTA, self::NOTICE_CIRCUIT, self::NOTICE_FAILED, self::NOTICE_EMPTY], true)
            || (bool) preg_match('/^AI is unavailable \([A-Z_]+\)\. Please ask your workspace administrator\.$/', $body);
    }

    /** An answer that stopped early keeps its words, not the bracketed note the room was shown. */
    public static function stripNotes(string $body): string
    {
        return trim((string) preg_replace('/(\s*\[(?:'.preg_quote(trim(self::TRUNCATED, '[]'), '/').'|'.preg_quote(self::NOTICE_FAILED, '/').')\])+\s*$/u', '', $body));
    }

    public static function mentioned(?string $body): bool
    {
        return (bool) preg_match('/(?:^|\s)@ai(?=\s|[,:!?]|$)/iu', $body ?? '');
    }

    private function active(Message $source, Room $room): bool
    {
        return $room->deleted_at === null && ! $room->isExpired() && $source->deleted_at === null && ! $room->isDm() // FR-ROOM-012
            && RoomMember::where('room_id', $room->id)->where('user_id', $source->sender_id)->whereNull('left_at')->exists()
            && WorkspaceMember::where('workspace_id', $room->workspace_id)->where('user_id', $source->sender_id)->where('status', 'active')->exists();
    }

    public function handle(MessageWriter $writer, SettingsService $settings): void
    {
        $source = Message::withoutGlobalScopes()->find($this->messageId);
        if (! $source || ! self::mentioned($source->body)) {
            return;
        }
        $room = Room::withoutGlobalScopes()->find($source->room_id);
        $user = User::find($source->sender_id);
        if (! $room || ! $user || $user->status->value !== 'active' || ! $this->active($source, $room)) {
            return;
        }
        $replyKey = (string) Uuid::uuid5(Uuid::NAMESPACE_URL, 'banana-room-bot:'.$source->id);
        if (Message::withoutGlobalScopes()->where('room_id', $room->id)->where('client_message_id', $replyKey)->exists()) {
            return;
        }
        [$provider, $error] = app(AiGate::class)->resolve($user->id, $room->workspace_id);
        $reply = match ($error) {
            'AI_CONSENT_REQUIRED' => self::NOTICE_CONSENT,
            null => '',
            default => sprintf(self::NOTICE_UNAVAILABLE, $error),
        };
        $lock = Cache::lock('room-bot-user:'.$user->id, 700);
        if (! $error && ! $lock->get()) {
            $reply = self::NOTICE_BUSY;
        } elseif (! $error) {
            try {
                $allowed = DB::transaction(function () use ($user, $provider, $settings, $room) {
                    User::whereKey($user->id)->lockForUpdate()->firstOrFail();
                    if (AiUsageDaily::messagesToday($user->id, $user->timezone ?? 'UTC') >= ($provider->daily_message_limit_per_user ?? $settings->int('ai.daily_message_limit_per_user'))) {
                        return false;
                    }
                    AiUsageDaily::bump($user->id, $room->workspace_id, messages: 1);

                    return true;
                });
                if (! $allowed) {
                    $reply = self::NOTICE_QUOTA;
                } elseif (AiCircuitBreaker::make()->isOpen()) {
                    $reply = self::NOTICE_CIRCUIT;
                } else {
                    // stream() writes the answer itself, growing it as the model speaks
                    $this->stream($writer, $settings, $source, $room, $user, $provider, $replyKey);

                    return;
                }
            } catch (Throwable $e) {
                AiCircuitBreaker::make()->recordFailure('AI_PROVIDER_ERROR');
                AiUsageDaily::bump($user->id, $room->workspace_id, failed: 1);
                $reply = self::NOTICE_FAILED;
            } finally {
                $lock->release();
            }
        }
        if (! $this->active($source->refresh(), $room->refresh())) {
            return;
        }
        $this->publish($writer, $room, $reply, $replyKey, $source, final: true, max: $settings->int('message.max_length'), notice: true);
    }

    /**
     * The room bot used to wait for a whole answer over one non-streaming call,
     * which the HTTP client gives 60 seconds — so a model that thinks for longer
     * produced "AI could not complete this request", never an answer. Streaming
     * gets 600 seconds and, as a bonus, lets the room watch the reply being
     * written instead of staring at nothing for a minute.
     */
    private function stream(
        MessageWriter $writer,
        SettingsService $settings,
        Message $source,
        Room $room,
        User $user,
        AiProvider $provider,
        string $replyKey,
    ): void {
        $max = $settings->int('message.max_length');
        $budget = $max - 40; // room for the truncation note
        $flushMs = $settings->int('ai.stream.flush_interval_ms');
        $flushChars = 80; // a long burst should land without waiting out the timer
        $system = 'You are the AI assistant in a workspace group chat. Several people talk here about many unrelated things at once. '
            .'Reply ONLY to the one message in the user turn — it is the message that just addressed you, prefixed with who sent it. '
            .'Answer that person and that question alone; do not respond to anything else that was said in the room. '
            .'Recent room messages are given below as background; attachments are not included, so do not pretend to have seen them. '
            .($provider->system_prompt ?? '');
        $messages = app(RoomContextBuilder::class)->build($room, $source, $provider, $this->bot()->id, $system);

        $content = '';
        $truncated = false;
        $failure = null;
        $lastFlush = microtime(true);
        $flushedLen = 0;
        $this->typing($room, true);

        try {
            foreach (OpenAiCompatibleProvider::make($provider)->chatStream($messages) as $chunk) {
                if (($chunk['type'] ?? '') !== 'delta') {
                    continue;
                }
                $content .= $chunk['text'];
                if (mb_strlen($content) > $budget) {
                    $content = mb_substr($content, 0, $budget);
                    $truncated = true;
                }

                $due = (microtime(true) - $lastFlush) * 1000 >= $flushMs
                    || mb_strlen($content) - $flushedLen >= $flushChars;
                if ($due && trim($content) !== '') {
                    $this->typing($room, true);
                    $this->publish($writer, $room, $content, $replyKey, $source, final: false, max: $max);
                    $lastFlush = microtime(true);
                    $flushedLen = mb_strlen($content);
                }
                if ($truncated) {
                    break;
                }
            }
            AiCircuitBreaker::make()->recordSuccess();
        } catch (Throwable $e) {
            AiCircuitBreaker::make()->recordFailure('AI_PROVIDER_ERROR');
            AiUsageDaily::bump($user->id, $room->workspace_id, failed: 1);
            $failure = self::NOTICE_FAILED;
        }

        $body = trim($content);
        $notice = false;
        if ($truncated) {
            $body .= "\n\n".self::TRUNCATED;
        }
        if ($body === '') {
            $body = $failure ?? self::NOTICE_EMPTY;
            $notice = true;
        } elseif ($failure !== null) {
            $body .= "\n\n[".$failure.']'; // keep what the model did say
        }
        if ($failure === null) {
            $estimator = new TokenEstimator;
            $sent = implode("\n", array_column($messages, 'content'));
            AiUsageDaily::bump($user->id, $room->workspace_id, tokensIn: $estimator->estimate($sent), tokensOut: $estimator->estimate($body));
        }

        $this->typing($room, false);
        if (! $this->active($source->refresh(), $room->refresh())) {
            return; // room or mention went away mid-answer; leave whatever was posted
        }
        $this->publish($writer, $room, $body, $replyKey, $source, final: true, max: $max, notice: $notice);
    }

    /**
     * First call posts the message; later calls grow it in place. Push is held
     * back until the body is final so nobody gets a notification for half a
     * sentence.
     */
    private function publish(MessageWriter $writer, Room $room, string $body, string $replyKey, Message $source, bool $final, int $max, bool $notice = false): void
    {
        if (mb_strlen($body) > $max) {
            $body = mb_substr($body, 0, $max - 40)."\n\n".self::TRUNCATED;
        }

        if ($this->posted === null) {
            // DEC-084: a notice is not an answer, so the next mention's context leaves it out
            [$this->posted] = $writer->write($room, $this->bot(), $body, $replyKey, $source->id, notify: false, metadata: $notice ? ['bot_notice' => true] : null);
        } else {
            $this->posted->forceFill(['body' => $body])->save();
            try {
                broadcast(new MessageStreamed($room, MessageSerializer::forEvent($this->posted)));
            } catch (Throwable $e) {
                Log::warning('room-bot.broadcast.failed', ['message_id' => $this->posted->id, 'error' => $e->getMessage()]);
            }
        }

        if ($final) {
            $writer->refreshActivity($this->posted);
            NotifyMessage::dispatch($this->posted->id);
        }
    }

    /** Reuses the ephemeral indicator people already see for each other. */
    private function typing(Room $room, bool $typing): void
    {
        if ($typing && (microtime(true) - $this->typingSentAt) < 4) {
            return; // clients hold it for 6s
        }
        $this->typingSentAt = $typing ? microtime(true) : 0.0;
        try {
            $bot = $this->bot();
            broadcast(new RoomToolEvent($room, 'room.typing', ['user_id' => $bot->id, 'display_name' => $bot->display_name, 'typing' => $typing]));
        } catch (Throwable $e) {
            Log::warning('room-bot.typing.failed', ['room_id' => $room->id, 'error' => $e->getMessage()]);
        }
    }

    private function bot(): User
    {
        return User::firstOrCreate(
            ['username' => '__banana_ai_bot__'],
            ['display_name' => 'AI Assistant', 'password_hash' => Hash::make(Str::random(64)), 'status' => 'deactivated', 'must_change_password' => false],
        );
    }
}
