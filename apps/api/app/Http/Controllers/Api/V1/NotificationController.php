<?php

namespace App\Http\Controllers\Api\V1;

use App\Http\Controllers\Controller;
use App\Models\Device;
use App\Models\InAppNotification;
use App\Models\Room;
use App\Models\RoomNotificationSetting;
use App\Models\User;
use App\Models\UserNotificationSetting;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;

/**
 * API-070/071/072 — push device registration, per-room notification mode,
 * user notification settings (FR-NOTI-001/005).
 */
class NotificationController extends Controller
{
    /**
     * API-070 — upsert device push token. A token already owned by another
     * user on any device moves to this user (devices follow people).
     */
    public function updateDevice(Request $request, string $deviceId): JsonResponse
    {
        $data = $request->validate([
            'push_token' => ['sometimes', 'nullable', 'string', 'max:512'],
            'push_provider' => ['sometimes', 'nullable', 'string', 'in:fcm,apns'],
            'platform' => ['required', 'string', 'in:ios,android,web'], // TC-NOTI-004
            'app_version' => ['sometimes', 'nullable', 'string', 'max:20'],
            'device_name' => ['sometimes', 'nullable', 'string', 'max:100'],
            'locale' => ['sometimes', 'nullable', 'string', 'max:5'],
        ]);

        /** @var User $user */
        $user = $request->user();

        $token = $data['push_token'] ?? null;

        if ($token !== null) {
            // token drift: same token on someone else's device → reassign here
            Device::query()->where('push_token', $token)->where('user_id', '!=', $user->id)
                ->update(['push_token' => null, 'push_provider' => null]); // TC-NOTI-002
        }

        $device = Device::query()->find($deviceId);

        if ($device !== null && $device->user_id !== $user->id) {
            return response()->json([
                'error' => ['code' => 'DEVICE_FORBIDDEN', 'message' => 'อุปกรณ์นี้ไม่ได้ลงทะเบียนกับบัญชีของคุณ'],
            ], 403);
        }

        if ($device === null) {
            $device = new Device;
            $device->id = $deviceId;
            $device->user_id = $user->id;
        }

        $device->fill($data);
        $device->user_id = $user->id;
        $device->push_failed_count = 0;
        $device->push_disabled_at = null;
        if ($token === null && array_key_exists('push_token', $data)) {
            $device->push_token = null; // explicit token clear
        }
        $device->last_active_at = now();
        $device->save();

        return response()->json(['data' => ['device' => $device]]);
    }

    /**
     * API-071 — per-room mode + mute window (FR-NOTI-005). Member-only and
     * indistinguishable from a missing room for non-members (TC-NOTI-021).
     */
    public function roomSettings(Request $request, string $roomId): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        $room = Room::query()
            ->whereNull('deleted_at')
            ->whereKey($roomId)
            ->whereHas('members', fn ($q) => $q->where('room_members.user_id', $user->id)->whereNull('room_members.left_at'))
            ->first();

        if ($room === null) {
            return response()->json([
                'error' => ['code' => 'NOT_FOUND', 'message' => 'ไม่พบข้อมูลที่ต้องการ'],
            ], 404);
        }

        $data = $request->validate([
            'mode' => ['required', 'string', 'in:all,mentions,none'],
            'muted_until' => [
                'nullable',
                function (string $attribute, mixed $value, \Closure $fail): void {
                    if ($value === 'infinity') {
                        return;
                    }
                    try {
                        if (Carbon::parse($value)->isPast()) {
                            $fail('muted_until ต้องเป็นเวลาในอนาคต'); // TC-NOTI-020
                        }
                    } catch (\Exception) {
                        $fail('muted_until รูปแบบไม่ถูกต้อง');
                    }
                },
            ],
        ]);

        /** @var User $user */
        $user = $request->user();

        $settings = RoomNotificationSetting::query()->updateOrCreate(
            ['user_id' => $user->id, 'room_id' => $room->id],
            [
                'mode' => $data['mode'],
                'muted_until' => ($data['muted_until'] ?? null) === 'infinity'
                    ? Carbon::create(2999, 12, 31)
                    : (isset($data['muted_until']) && $data['muted_until'] !== null ? Carbon::parse($data['muted_until']) : null),
            ],
        );

        return response()->json(['data' => ['settings' => $settings]]);
    }

    /**
     * API-072 — user-level notification settings (DND window, sound, preview).
     */
    public function updateSettings(Request $request): JsonResponse
    {
        $data = $request->validate([
            'dnd_start' => ['sometimes', 'nullable', 'date_format:H:i'],
            'dnd_end' => ['sometimes', 'nullable', 'date_format:H:i'],
            'dnd_days' => ['sometimes', 'nullable', 'array', 'max:7'],
            'dnd_days.*' => ['integer', 'min:1', 'max:7'],
            'sound' => ['sometimes', 'boolean'],
            'preview_in_push' => ['sometimes', 'boolean'],
        ]);

        if ((isset($data['dnd_start']) !== isset($data['dnd_end']))
            && ($data['dnd_start'] ?? null) !== ($data['dnd_end'] ?? null)) {
            return response()->json([
                'error' => ['code' => 'VALIDATION_FAILED', 'message' => 'ต้องระบุ dnd_start และ dnd_end พร้อมกัน'],
            ], 422);
        }

        /** @var User $user */
        $user = $request->user();

        $settings = UserNotificationSetting::query()->updateOrCreate(
            ['user_id' => $user->id],
            $data,
        );

        return response()->json(['data' => ['settings' => $settings]]);
    }

    /**
     * Focus reporting (FR-NOTI-002): the client pings every ~20s with the
     * room it is looking at; NotifyMessage suppresses pushes for it.
     */
    public function focus(Request $request): JsonResponse
    {
        $data = $request->validate([
            'device_id' => ['required', 'ulid'],
            'room_id' => ['nullable', 'ulid'],
        ]);

        /** @var User $user */
        $user = $request->user();

        Device::query()
            ->whereKey($data['device_id'])
            ->where('user_id', $user->id)
            ->update([
                'focused_room_id' => $data['room_id'] ?? null,
                'focused_at' => now(),
            ]);

        return response()->json(['data' => ['ok' => true]]);
    }

    /**
     * API-073 — in-app notification center feed (FR-NOTI-006): mention,
     * added to room, session revoked. Cursor paginated, newest first.
     */
    public function index(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        $limit = 30;

        $query = InAppNotification::query()
            ->where('user_id', $user->id)
            ->with('actor:id,username,display_name')
            ->orderByDesc('created_at')
            ->orderByDesc('id');

        $cursor = $request->query('cursor');
        if (is_string($cursor) && $cursor !== '') {
            [$at, $id] = explode('|', $cursor, 2) + [null, null];
            if ($at !== null) {
                $query->where(function ($sub) use ($at, $id) {
                    $sub->where('created_at', '<', $at)
                        ->orWhere(fn ($s2) => $s2->where('created_at', $at)->where('id', '<', $id ?? ''));
                });
            }
        }

        $rows = $query->take($limit + 1)->get();

        $next = null;
        if ($rows->count() > $limit) {
            $last = $rows[$limit - 1];
            $next = $last->created_at->toIso8601String().'|'.$last->id;
            $rows = $rows->take($limit);
        }

        return response()->json([
            'data' => [
                'notifications' => $rows->map(fn (InAppNotification $n) => $n->toApiArray())->values()->all(),
                'next_cursor' => $next,
            ],
        ]);
    }

    /**
     * API-073 — mark read: {ids: [...]} marks those rows, {} marks all.
     */
    public function markRead(Request $request): JsonResponse
    {
        $data = $request->validate([
            'ids' => ['sometimes', 'array', 'max:100'],
            'ids.*' => ['ulid'],
        ]);

        /** @var User $user */
        $user = $request->user();

        $query = InAppNotification::query()
            ->where('user_id', $user->id)
            ->whereNull('read_at');
        if (isset($data['ids'])) {
            $query->whereIn('id', $data['ids']);
        }
        $query->update(['read_at' => now()]);

        return response()->json(['data' => ['ok' => true]]);
    }
}
