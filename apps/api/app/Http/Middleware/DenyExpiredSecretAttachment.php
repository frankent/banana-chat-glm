<?php

namespace App\Http\Middleware;

use App\Domain\Media\SecretAttachmentExpiry;
use App\Models\Attachment;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * FR-ROOM-012 — a direct (signed) attachment URL dies with the secret room it
 * is bound to and must answer `404`, never `403`: "no leak" (spec §FR-ROOM-012,
 * DEC-056).
 *
 * This runs BEFORE `signed` on the `attachments.file` route. A presigned GET is
 * capped at the room deadline but is normally much shorter (≤60 min,
 * AttachmentSerializer::URL_TTL_MINUTES), so by the time the room expires the
 * signature itself is usually stale and Laravel's ValidateSignature would emit
 * `403 InvalidSignature` before any controller code could answer `404`.
 * Checking the room deadline first keeps the documented status code without
 * touching signature validation itself — an ordinary room's expired or tampered
 * URL still falls through to `signed` and still gets `403`.
 */
class DenyExpiredSecretAttachment
{
    public function handle(Request $request, Closure $next): Response
    {
        $attachmentId = $request->route('attachment');

        if (is_string($attachmentId) && $attachmentId !== '') {
            $attachment = Attachment::withoutGlobalScopes()->find($attachmentId);

            if ($attachment !== null && SecretAttachmentExpiry::boundToExpiredRoom($attachment)) {
                abort(404);
            }
        }

        return $next($request);
    }
}
