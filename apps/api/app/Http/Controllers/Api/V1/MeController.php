<?php

namespace App\Http\Controllers\Api\V1;

use App\Domain\Message\MessageSerializer;
use App\Domain\Workspace\WorkspaceSummaryBuilder;
use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Events\UserSettingsUpdated;
use App\Events\UserUpdated;
use App\Exceptions\ApiException;
use App\Http\Controllers\Controller;
use App\Http\Resources\UserResource;
use App\Models\Attachment;
use App\Models\Message;
use App\Models\User;
use App\Support\WorkspaceContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Hash;

/**
 * API-008/009/010/044 — /me, /me/workspaces, /me/mentions.
 */
class MeController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();

        return response()->json([
            'data' => [
                'user' => new UserResource($user),
                'settings' => [
                    'locale' => $user->locale,
                    'timezone' => $user->timezone,
                    'notification' => $user->notificationSetting?->only(['dnd_start', 'dnd_end', 'dnd_days', 'sound', 'preview_in_push', 'privacy_mode']),
                ],
            ],
        ]);
    }

    public function update(Request $request): JsonResponse
    {
        $data = $request->validate([
            'display_name' => ['sometimes', 'string', 'min:1', 'max:80'],
            'locale' => ['sometimes', 'string', 'in:th,en'],
            'timezone' => ['sometimes', 'string', 'timezone', 'max:64'],
            'avatar_attachment_id' => ['sometimes', 'nullable', 'ulid'],
        ]);

        /** @var User $user */
        $user = $request->user();

        // FR-PROF-006 — a non-null id is accepted only when it is the user's
        // OWN READY kind=avatar upload. Without this the field was a bare
        // `nullable|ulid`: anything shaped like a ULID went straight onto the
        // row, so a member could point their avatar at another user's PRIVATE
        // attachment and get it serialized (and signed) to everyone. Unknown
        // id, not-mine, wrong kind and not-ready are all the SAME opaque
        // AVATAR_INVALID — no enumeration. null clears the photo.
        if (($data['avatar_attachment_id'] ?? null) !== null) {
            $avatar = Attachment::withoutGlobalScopes()->find($data['avatar_attachment_id']);

            if ($avatar === null
                || $avatar->uploader_id !== $user->id
                || $avatar->kind !== AttachmentKind::Avatar
                || $avatar->status !== AttachmentStatus::Ready) {
                throw ApiException::avatarInvalid();
            }
        }

        $user->fill($data);

        // EVT-086 + EVT-087 fire only on a REAL change of a field other
        // members (EVT-087, per active workspace) or the user's other tabs
        // (EVT-086, private-user) can observe. A PATCH that writes the same
        // value back — or touches only locale/timezone — broadcasts nothing.
        $profileChanged = $user->isDirty('avatar_attachment_id') || $user->isDirty('display_name');

        $user->save();

        if ($profileChanged) {
            $workspaceIds = $user->workspaces()->pluck('workspaces.id')->all(); // active memberships only (relation filters pivot)

            broadcast(new UserUpdated($user->id, $workspaceIds));
            broadcast(new UserSettingsUpdated($user->id));
        }

        return response()->json(['data' => ['user' => new UserResource($user->refresh())]]);
    }

    /**
     * API-236 / FR-NOTI-009 (app lock) / DEC-087 — re-check the account
     * password for an already-authenticated session. It ONLY compares the
     * hash: no token is issued, refreshed, rotated or revoked, no LoginAction
     * (login bulk-revokes the user's other sessions), no audit row naming the
     * password, and the password value is never logged. This is what the
     * client calls when privacy mode re-locks the app on open/visible; the
     * dedicated `verify-password` limiter (8/min per user+IP) bounds guessing.
     */
    public function verifyPassword(Request $request): Response
    {
        $data = $request->validate([
            'password' => ['required', 'string', 'max:256'],
        ]);

        /** @var User $user */
        $user = $request->user();

        if (! Hash::check($data['password'], $user->password_hash)) {
            throw new ApiException('INVALID_PASSWORD', 'รหัสผ่านไม่ถูกต้อง', 422);
        }

        return response()->noContent();
    }

    public function workspaces(Request $request, WorkspaceSummaryBuilder $builder): JsonResponse
    {
        return response()->json([
            'data' => $builder->forUser($request->user()),
        ]);
    }

    /**
     * API-044 — messages mentioning me in the current workspace, newest
     * first, keyset cursor = last message id (FR-MSG-008).
     */
    public function mentions(Request $request, MessageSerializer $serializer, WorkspaceContext $context): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        $workspaceId = (string) $context->id();

        $data = $request->validate([
            'cursor' => ['nullable', 'ulid'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:50'],
        ]);
        $limit = (int) ($data['limit'] ?? 20);

        $query = Message::query()
            ->join('message_mentions', 'message_mentions.message_id', '=', 'messages.id')
            ->join('rooms', 'rooms.id', '=', 'messages.room_id')
            ->where('message_mentions.user_id', $user->id)
            ->where('message_mentions.workspace_id', $workspaceId)
            ->whereNull('messages.deleted_at')
            ->whereNull('rooms.deleted_at')
            ->where(fn ($q) => $q->where('rooms.is_secret', false)->orWhere('rooms.secret_expires_at', '>', now())) // FR-ROOM-012
            ->with([
                'sender:id,username,display_name,avatar_attachment_id',
                'sender.avatarAttachment',
                'replyTo:id,room_id,seq,sender_id,body,deleted_at',
                'attachments',
                'mentions:id',
            ])
            ->select('messages.*')
            ->orderByDesc('messages.created_at')
            ->orderByDesc('messages.id');

        if (isset($data['cursor'])) {
            // keyset: strictly before the (created_at, id) of the cursor row
            $cursorRow = Message::query()->find($data['cursor']);
            if ($cursorRow !== null) {
                $query->where(function ($q) use ($cursorRow): void {
                    $q->where('messages.created_at', '<', $cursorRow->created_at->toDateTimeString())
                        ->orWhere(fn ($w) => $w->where('messages.created_at', $cursorRow->created_at->toDateTimeString())
                            ->where('messages.id', '<', $cursorRow->id));
                });
            }
        }

        $rows = $query->limit($limit + 1)->get();

        $hasMore = $rows->count() > $limit;
        $page = $rows->take($limit);

        return response()->json([
            'data' => [
                'messages' => $page->map(fn (Message $m) => $serializer->toArray($m))->values(),
                'next_cursor' => $hasMore && $page->isNotEmpty() ? $page->last()->id : null,
            ],
        ]);
    }
}
