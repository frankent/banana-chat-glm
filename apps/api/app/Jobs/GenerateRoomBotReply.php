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
            'AI_CONSENT_REQUIRED' => 'Please open AI Assistant and accept AI consent before mentioning @ai. Recent messages of this room are sent as context, and the reply is visible to everyone here.',
            null => '',
            default => 'AI is unavailable ('.$error.'). Please ask your workspace administrator.',
        };
        $lock = Cache::lock('room-bot-user:'.$user->id, 700);
        if (! $error && ! $lock->get()) {
            $reply = 'AI is already answering your earlier request. Please try again shortly.';
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
                    $reply = 'Your daily AI message limit has been reached.';
                } elseif (AiCircuitBreaker::make()->isOpen()) {
                    $reply = 'AI is temporarily unavailable. Please try again later.';
                } else {
                    // stream() writes the answer itself, growing it as the model speaks
                    $this->stream($writer, $settings, $source, $room, $user, $provider, $replyKey);

                    return;
                }
            } catch (Throwable $e) {
                AiCircuitBreaker::make()->recordFailure('AI_PROVIDER_ERROR');
                AiUsageDaily::bump($user->id, $room->workspace_id, failed: 1);
                $reply = 'AI could not complete this request. Please try again later.';
            } finally {
                $lock->release();
            }
        }
        if (! $this->active($source->refresh(), $room->refresh())) {
            return;
        }
        $this->publish($writer, $room, $reply, $replyKey, $source, final: true, max: $settings->int('message.max_length'));
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
        $prompt = trim((string) preg_replace('/(?:^|\s)@ai(?=\s|[,:!?]|$)/iu', ' ', (string) $source->body));
        $system = 'You are the AI assistant in a workspace group chat. The recent messages of this room are given as context, each one prefixed with the name of who said it; your own replies appear without a prefix. Attachments are not included, so do not pretend to have seen them. Answer the last message, which addressed you. '.($provider->system_prompt ?? '');
        $history = app(RoomContextBuilder::class)->build($room, $source, $provider, $this->bot()->id, $system);
        if ($history === []) {
            // a mention with nothing but "@ai" in it still deserves an answer
            $history = [['role' => 'user', 'content' => $prompt !== '' ? $prompt : (string) $source->body]];
        }

        $content = '';
        $truncated = false;
        $failure = null;
        $lastFlush = microtime(true);
        $flushedLen = 0;
        $this->typing($room, true);

        try {
            foreach (OpenAiCompatibleProvider::make($provider)->chatStream([
                ['role' => 'system', 'content' => $system],
                ...$history,
            ]) as $chunk) {
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
            $failure = 'AI could not complete this request. Please try again later.';
        }

        $body = trim($content);
        if ($truncated) {
            $body .= "\n\n[Answer truncated to message limit]";
        }
        if ($body === '') {
            $body = $failure ?? 'AI returned an empty answer. Please try again.';
        } elseif ($failure !== null) {
            $body .= "\n\n[".$failure.']'; // keep what the model did say
        }
        if ($failure === null) {
            $estimator = new TokenEstimator;
            $sent = $system.implode("\n", array_column($history, 'content'));
            AiUsageDaily::bump($user->id, $room->workspace_id, tokensIn: $estimator->estimate($sent), tokensOut: $estimator->estimate($body));
        }

        $this->typing($room, false);
        if (! $this->active($source->refresh(), $room->refresh())) {
            return; // room or mention went away mid-answer; leave whatever was posted
        }
        $this->publish($writer, $room, $body, $replyKey, $source, final: true, max: $max);
    }

    /**
     * First call posts the message; later calls grow it in place. Push is held
     * back until the body is final so nobody gets a notification for half a
     * sentence.
     */
    private function publish(MessageWriter $writer, Room $room, string $body, string $replyKey, Message $source, bool $final, int $max): void
    {
        if (mb_strlen($body) > $max) {
            $body = mb_substr($body, 0, $max - 40)."\n\n[Answer truncated to message limit]";
        }

        if ($this->posted === null) {
            [$this->posted] = $writer->write($room, $this->bot(), $body, $replyKey, $source->id, notify: false);
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
