<?php

namespace App\Domain\Media;

use App\Enums\AttachmentKind;
use App\Enums\AttachmentStatus;
use App\Exceptions\ApiException;
use App\Models\Attachment;
use App\Models\User;
use DateTimeInterface;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Storage;

/**
 * FR-PROF-006 / DEC-088 — the ONE avatar shape every user serialization
 * carries: `{sm, md, animated}` or null.
 *
 * - sm/md are the webp thumbs ProcessAttachment derives for every decodable
 *   avatar (thumb_sm ≤400 / thumb_md ≤1280; for a GIF they are the FIRST
 *   frame — FR-MEDIA-002).
 * - animated is the signed ORIGINAL, present only when the mime is image/gif
 *   (GIF originals are never re-encoded, so the animation survives only
 *   there). null for every still type.
 *
 * Never put these URLs in a push/FCM payload (DEC-087: the privacy-mode proof
 * rests on "no image field in any push").
 */
class AvatarUrls
{
    /**
     * DEC-088 — expiry ROUNDED to a fixed boundary: end of the current hour
     * + 1h, i.e. startOfHour()+2h. Every URL is therefore valid for at least
     * one hour AND byte-identical across all requests inside the same
     * wall-clock hour, so a client refetching a member list or a message page
     * gets the same signed string it already had — no re-download, no flicker.
     * MediaUrls::temporaryGetUrl accepts a DateTimeInterface for exactly this.
     */
    public static function expiresAt(): Carbon
    {
        return now()->startOfHour()->addHours(2);
    }

    /**
     * DEC-089 / FR-PROF-007 — expiry for the avatar URLs embedded in a call
     * or meeting join token: those URLs must OUTLIVE the token itself (whose
     * exp is now + calls.token_ttl), so the same hour rounding as expiresAt()
     * plus the token ttl and a 2h cushion. Still hour-aligned, so DEC-088's
     * byte-stability holds for every token minted inside the same hour.
     */
    public static function expiresAtForCallToken(): Carbon
    {
        return now()->startOfHour()->addSeconds((int) config('calls.token_ttl'))->addHours(2);
    }

    /**
     * DEC-089: join tokens pass expiresAtForCallToken() for $expiresAt so
     * the signed URLs outlive the token; null keeps the standard list
     * expiry (DEC-088).
     *
     * @return array{sm: string, md: string, animated: string|null}|null
     */
    public static function for(?Attachment $attachment, ?DateTimeInterface $expiresAt = null): ?array
    {
        if ($attachment === null || $attachment->status !== AttachmentStatus::Ready) {
            return null;
        }

        $mediaUrls = app(MediaUrls::class);

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        $expiresAt ??= self::expiresAt();
        $derived = $attachment->derived ?? [];

        // A ready avatar normally always has both thumbs; the original key is
        // only a defensive fallback (and then honestly labelled with the row's
        // own mime, never as webp).
        $smKey = $derived['thumb_sm'] ?? null;
        $mdKey = $derived['thumb_md'] ?? null;

        return [
            'sm' => $mediaUrls->temporaryGetUrl($disk, $smKey ?? $attachment->storage_key, $expiresAt, $smKey !== null ? 'image/webp' : $attachment->mime_type),
            'md' => $mediaUrls->temporaryGetUrl($disk, $mdKey ?? $attachment->storage_key, $expiresAt, $mdKey !== null ? 'image/webp' : $attachment->mime_type),
            'animated' => $attachment->mime_type === 'image/gif'
                ? $mediaUrls->temporaryGetUrl($disk, $attachment->storage_key, $expiresAt, $attachment->mime_type)
                : null,
        ];
    }

    /**
     * Batch for join-based lists (workspace/room members, read receipts, DM
     * counterparts): ONE query for the whole page whatever its size — the
     * N+1 guard for serializers that cannot eager-load a relation because the
     * rows come back from a join, not off a model.
     *
     * @param  iterable<string|null>  $ids
     * @return Collection<string, array{sm: string, md: string, animated: string|null}|null> keyed by attachment id
     */
    public static function mapFor(iterable $ids): Collection
    {
        $ids = collect($ids)->filter(fn ($id) => $id !== null && $id !== '')->unique()->values();

        if ($ids->isEmpty()) {
            return collect();
        }

        // withoutGlobalScopes: an avatar is an account-level artefact (API-062
        // lets any member read kind=avatar), and the row's workspace_id is the
        // workspace the photo was UPLOADED in — not necessarily the one whose
        // member list is being serialized.
        $attachments = Attachment::withoutGlobalScopes()
            ->whereIn('id', $ids->all())
            ->get()
            ->keyBy('id');

        return $ids->mapWithKeys(fn (string $id) => [$id => self::for($attachments->get($id))]);
    }

    /**
     * FR-PROF-006 / FR-PROF-008 / DEC-090 — the ONE validity check behind
     * every avatar pointer write (PATCH /me and PATCH /rooms/{id}): a
     * non-null id is accepted only when it is the ACTOR'S OWN READY
     * kind=avatar upload. Unknown id, not-mine, wrong kind and not-ready
     * all collapse into the SAME opaque AVATAR_INVALID — no enumeration of
     * which ids exist or who owns them.
     */
    public static function assertOwnReadyUpload(string $attachmentId, User $actor): void
    {
        $avatar = Attachment::withoutGlobalScopes()->find($attachmentId);

        if ($avatar === null
            || $avatar->uploader_id !== $actor->id
            || $avatar->kind !== AttachmentKind::Avatar
            || $avatar->status !== AttachmentStatus::Ready) {
            throw ApiException::avatarInvalid();
        }
    }
}
