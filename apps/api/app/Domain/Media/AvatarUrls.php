<?php

namespace App\Domain\Media;

use App\Enums\AttachmentStatus;
use App\Models\Attachment;
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
     * @return array{sm: string, md: string, animated: string|null}|null
     */
    public static function for(?Attachment $attachment): ?array
    {
        if ($attachment === null || $attachment->status !== AttachmentStatus::Ready) {
            return null;
        }

        $mediaUrls = app(MediaUrls::class);

        /** @var FilesystemAdapter $disk */
        $disk = Storage::disk(config('filesystems.default'));

        $expiresAt = self::expiresAt();
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
}
