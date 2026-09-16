<?php

namespace App\Domain\PublicChat;

use App\Domain\Notification\FcmPushSender;
use App\Domain\Notification\PushDecisionService;
use App\Enums\PublicChatMessageType;
use App\Enums\PublicChatSenderKind;
use App\Enums\UserStatus;
use App\Events\NotificationAlert;
use App\Models\Device;
use App\Models\PublicChatMessage;
use App\Models\PublicChatRoom;
use App\Models\User;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\Redis;
use Throwable;

/**
 * FR-PCHAT-015 · MANDATORY grafts 3 and 20 · MANDATORY fix 15/26 — agent push
 * for a VISITOR message. This closes the accepted design's own R2 ("no mobile
 * push to agents"), which would otherwise mean an agent with the web app closed
 * is never told a paying customer wrote to them — the feature failing quietly.
 *
 * ==== WHY THIS IS NOT Jobs/NotifyMessage =================================
 * NotifyMessage's FIRST ACT on a null sender is
 *     $senderUser = $message->sender()->first();
 *     if ($senderUser === null) { return; }
 * — no exception, no log. A visitor has no User, so reusing it would drop every
 * customer notification SILENTLY. It also walks room_members (there are none
 * here), writes InAppNotification rows (whose room_id is a NOT-NULL-shaped FK
 * to `rooms`, which a public chat room id does not resolve against) and calls
 * PushDecisionService::payload(Message, Room, User, int) — three `rooms`-shaped
 * couplings. This job is a separate path on purpose. Do not "unify" them.
 *
 * WHAT IT REUSES: only the two PushDecisionService methods that are not
 * Message/Room-typed — isFocusedOnRoom() and inDnd() — so the focus-suppression
 * window and the DND window stay one definition, and FcmPushSender for
 * delivery, so token-failure and UNREGISTERED handling is not forked.
 *
 * ==== WHO GETS WOKEN (graft 3's rule, deliberately narrow) ================
 * The ASSIGNED agent, and NOBODY when the room is unassigned. An unassigned
 * room is the queue's job: the rail badge (API-227 new+problem) and the list's
 * amber needs_reply dot already surface it. Waking every member of the
 * workspace for every unclaimed customer message is how a support integration
 * trains its users to disable notifications.
 *
 * Agent and system rows never notify — only sender_kind = visitor.
 */
class NotifyPublicChatMessage implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;
    use SerializesModels;

    public int $tries = 5;

    public function __construct(
        public readonly string $messageId,
    ) {}

    public function handle(PushDecisionService $decision, FcmPushSender $sender): void
    {
        // withoutGlobalScopes: a queue worker has no WorkspaceContext, so
        // WorkspaceScope would no-op silently anyway (it fails OPEN). Saying so
        // explicitly stops a future reader assuming a scope protects this line;
        // the room_id + workspace_id pairing below is the real filter.
        $message = PublicChatMessage::withoutGlobalScopes()->find($this->messageId);

        if ($message === null || $message->isDeleted()) {
            return;
        }

        if ($message->sender_kind !== PublicChatSenderKind::Visitor) {
            return;
        }

        $room = PublicChatRoom::withoutGlobalScopes()
            ->whereKey($message->room_id)
            ->where('workspace_id', $message->workspace_id)
            ->first();

        if ($room === null || $room->deleted_at !== null || $room->isExpired() || $room->isClosed()) {
            return;
        }

        if ($room->assigned_to === null) {
            return; // graft 3: unassigned rooms wake nobody. The queue badge is the signal.
        }

        $recipient = User::withoutGlobalScopes()->find($room->assigned_to);

        if ($recipient === null || $recipient->status !== UserStatus::Active) {
            return;
        }

        // FR-NOTI-007 — the in-app audible alert. room_id is deliberately NULL:
        // the web client resolves NotificationAlert.room_id against `rooms`, and
        // handing it a public chat ULID would make it try to open a room that
        // does not exist. The kind tells the client which surface to open.
        broadcast(new NotificationAlert(
            $recipient->id,
            $message->id,
            null,
            $room->workspace_id,
            'public_chat',
        ));

        /** @var list<Device> $devices */
        $devices = Device::query()
            ->where('user_id', $recipient->id)
            ->whereNotNull('push_token')
            ->whereNull('push_disabled_at')
            ->get();

        if (count($devices) === 0) {
            return;
        }

        // Reused verbatim from the internal path so the two windows cannot
        // drift: an agent looking at this conversation right now gets no push.
        if ($decision->isFocusedOnRoom($devices, $room->id)) {
            return;
        }

        if ($decision->inDnd($recipient->notificationSetting, $recipient->timezone)) {
            return;
        }

        $payload = $this->payload($message, $room, $recipient);
        $sentKey = "push:sent:pchat:{$message->id}";

        foreach ($devices as $device) {
            // one push per message per device per day, same discipline as
            // NotifyMessage: retries must not re-notify.
            if (! Redis::connection()->sadd($sentKey, $device->id)) {
                continue;
            }
            Redis::connection()->expire($sentKey, 86_400);

            try {
                $sender->send($device, $payload);
            } catch (Throwable $e) {
                // drop this device from the set so the retry re-attempts it
                Redis::connection()->srem($sentKey, $device->id);
                report($e);
            }
        }
    }

    /**
     * MANDATORY graft 3 — customer_name IS the display name. PushDecisionService
     * dereferences $sender->display_name, and there is no User behind a visitor;
     * supplying the room's customer_name is what makes the notification read
     * "Somchai: ..." instead of crashing or saying "null".
     *
     * customer_name is partner-supplied and therefore attacker-influenced. It is
     * length-capped and control-char-stripped AT INGEST (PublicChatService), so
     * the sanitised value is what travels into this payload — the only defence
     * that survives into a push notification, an export or an email template.
     *
     * @return array{title: string, body: string, data: array<string, mixed>, collapse_key: string, badge: int}
     */
    private function payload(PublicChatMessage $message, PublicChatRoom $room, User $recipient): array
    {
        $preview = $recipient->notificationSetting?->preview_in_push ?? true;

        if (! $preview) {
            $body = 'ข้อความใหม่';
        } elseif ($message->body !== null && $message->body !== '') {
            $body = mb_substr($message->body, 0, 120);
        } else {
            $body = match ($message->type) {
                PublicChatMessageType::Image => '📷 รูปภาพ',
                PublicChatMessageType::Video => '🎬 วิดีโอ',
                default => '📎 ไฟล์แนบ',
            };
        }

        return [
            'title' => $room->customer_name,
            'body' => $body,
            'data' => [
                // NOT 'room_id': that key means a `rooms` ULID everywhere else
                // in this app's clients. A distinct key forces the client to
                // route to the public chat surface deliberately.
                'public_chat_room_id' => $room->id,
                'workspace_id' => $room->workspace_id,
                'message_id' => $message->id,
                'seq' => (int) $message->seq,
                'kind' => 'public_chat',
            ],
            'collapse_key' => 'pchat:'.$room->id,
            // No workspace unread aggregate exists for public chat (there are
            // no room_members rows to sum), and inventing one from `rooms`
            // would be wrong. 0 leaves the OS badge to the internal path.
            'badge' => 0,
        ];
    }
}
