<?php

namespace App\Jobs;

use App\Domain\Ai\AiCircuitBreaker;
use App\Domain\Ai\AiGate;
use App\Domain\Ai\OpenAiCompatibleProvider;
use App\Domain\Ai\TokenEstimator;
use App\Domain\Message\MessageWriter;
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
use Illuminate\Support\Str;
use Ramsey\Uuid\Uuid;

/** FR-AI-021: explicit @ai only, no room history, attachments, or private memory. */
class GenerateRoomBotReply implements ShouldBeUnique, ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public int $tries = 1;

    public int $timeout = 660;

    public int $uniqueFor = 900;

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
        return $room->deleted_at === null && $source->deleted_at === null && ! $room->isDm()
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
            'AI_CONSENT_REQUIRED' => 'Please open AI Assistant and accept AI consent before mentioning @ai. Only your mention text is sent; the reply will be visible to this room.',
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
                    $prompt = preg_replace('/(?:^|\s)@ai(?=\s|[,:!?]|$)/iu', ' ', $source->body);
                    $reply = OpenAiCompatibleProvider::make($provider)->chat([
                        ['role' => 'system', 'content' => 'You are the AI assistant in a workspace group chat. Answer the explicitly addressed message. You have no room history or attachments. Do not pretend to have read them. '.($provider->system_prompt ?? '')],
                        ['role' => 'user', 'content' => trim($prompt)],
                    ]);
                    AiCircuitBreaker::make()->recordSuccess();
                    $estimator = new TokenEstimator;
                    AiUsageDaily::bump($user->id, $room->workspace_id, tokensIn: $estimator->estimate($prompt), tokensOut: $estimator->estimate($reply));
                    if (trim($reply) === '') {
                        $reply = 'AI returned an empty answer. Please try again.';
                    }
                }
            } catch (\Throwable $e) {
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
        $bot = User::firstOrCreate(['username' => '__banana_ai_bot__'], ['display_name' => 'AI Assistant', 'password_hash' => Hash::make(Str::random(64)), 'status' => 'deactivated', 'must_change_password' => false]);
        $max = $settings->int('message.max_length');
        if (mb_strlen($reply) > $max) {
            $reply = mb_substr($reply, 0, $max - 40)."\n\n[Answer truncated to message limit]";
        }
        $writer->write($room, $bot, $reply, $replyKey, $source->id);
    }
}
