<?php

namespace App\Domain\Media;

use Symfony\Component\HttpFoundation\HeaderUtils;
use Symfony\Component\HttpFoundation\ResponseHeaderBag;

/**
 * DEC-072 / FR-MEDIA-004 — THE ONE DEFINITION OF "may this object be rendered
 * by a browser, in our own origin, without a download prompt?"
 *
 * ==== WHY THIS CLASS EXISTS =================================================
 * Production serves MinIO under the APP'S OWN ORIGIN (the bucket rides the URL
 * path). An object replayed with `Content-Type: text/html` or `image/svg+xml`
 * is therefore a same-origin document: its `<script>` runs with the chat app's
 * cookies, localStorage and session. FR-PCHAT-020 made that reachable by an
 * UNAUTHENTICATED visitor holding nothing but a /support/<code> link, but the
 * hole was never public-chat specific — any workspace member could do it too.
 *
 * Three layers close it, and this class is the third and MOST IMPORTANT one:
 *   1. upload.file.blocked_extensions  — cheapest, and a rename defeats it
 *   2. UploadService::assertMimeMatchesKind on the SNIFFED type — a rename
 *      cannot defeat it, but it only protects objects uploaded FROM NOW ON
 *   3. the forced response disposition below — the ONLY layer that protects
 *      the objects ALREADY SITTING IN THE BUCKET, because it acts at read time
 *
 * ==== THE RULE ==============================================================
 * ALLOWLIST, never deny-list. `inline` is granted to a short, explicit set of
 * raster image and video types and to nothing else; everything else — unknown
 * types, PDFs, archives, office documents, and every type we have not thought
 * about yet — is `attachment` with a neutral `application/octet-stream`. A new
 * browser-renderable format shipping in Chrome next year is therefore safe by
 * default rather than dangerous by default, which is the whole reason the deny
 * lists below are NOT what decides disposition.
 *
 * ==== THE TWO UPLOAD-TIME PREDICATES (DEC-072) ==============================
 * Refusing an upload is a different, narrower question than choosing a
 * disposition — it is destructive, so it needs certainty, and a deny list is
 * the right shape for it. There are TWO of them because the two surfaces have
 * different promises:
 *
 *   isAlwaysBlockedMime()  — the floor, enforced on EVERY surface. HTML, PHP,
 *       script sources, Flash, whole-page archive containers. Nothing here has
 *       a legitimate "share this file with a colleague" story.
 *
 *   isBrowserExecutable()  — the floor PLUS the markup family (svg, xml, xslt,
 *       xhtml and the `+xml` suffix). Enforced ONLY on the Public Chat surface
 *       (UploadService::createForPublicChat / any row carrying a
 *       public_chat_room_id), which is unauthenticated and where no user was
 *       ever promised SVG sharing.
 *
 * Internal authenticated uploads accept svg/xml on purpose: PRODUCT_SPEC
 * FR-MEDIA-004/005 specify "accept SVG, serve it as an attachment, never
 * inline", and the read-time disposition control below is what makes that safe.
 * That control is also the only layer that reaches objects ALREADY stored, so
 * it — not the upload deny list — is the primary protection for internal SVG.
 * Do not merge the two predicates, and do not merge either with the inline
 * allowlist.
 */
final class InlineSafety
{
    /** What we serve as the Content-Type of anything not inline-safe. */
    public const NEUTRAL_TYPE = 'application/octet-stream';

    /**
     * ALLOWLIST — types a browser may render inline, same-origin, safely.
     *
     * Raster images and video containers only. Deliberately EXCLUDED:
     *  - image/svg+xml: an SVG is a script host, not a picture
     *  - application/pdf: the viewer can navigate top-level and run embedded JS
     *  - text/plain, application/json, text/csv: sniffing and charset tricks
     *
     * @var list<string>
     */
    private const INLINE_ALLOWED = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/avif',
        'image/bmp',
        'image/heic',
        'image/heif',
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'audio/mpeg',
        'audio/mp4',
        'audio/aac',
        'audio/ogg',
        'audio/wav',
        'audio/webm',
    ];

    /**
     * DENY LIST — THE FLOOR. Types refused at upload time on EVERY surface,
     * internal and public chat alike. A browser runs these as a document or a
     * program in our own origin and no internal workflow needs to share one.
     *
     * @var list<string>
     */
    private const ALWAYS_BLOCKED_MIMES = [
        'text/html',
        'application/javascript',
        'text/javascript',
        'application/x-javascript',
        'application/ecmascript',
        'text/ecmascript',
        'application/x-httpd-php',
        'text/x-php',
        'multipart/related',   // .mhtml — a whole archived page
        'message/rfc822',      // .mht — same trick, older container
        'text/cache-manifest',
        'application/x-shockwave-flash',
    ];

    /**
     * DENY LIST — the markup family, refused at upload time on the PUBLIC CHAT
     * SURFACE ONLY (DEC-072).
     *
     * These are every bit as script-capable as text/html, which is why the
     * unauthenticated surface refuses them outright. Internally they are
     * accepted because FR-MEDIA-004/005 specify SVG sharing, and the forced
     * read-time disposition is what keeps a stored SVG inert.
     *
     * @var list<string>
     */
    private const PUBLIC_CHAT_BLOCKED_MIMES = [
        'image/svg+xml',
        'application/xml',
        'text/xml',
        'application/xslt+xml',
        'text/xsl',
        'application/xhtml+xml',
        'application/xhtml',
    ];

    /**
     * EXTENSIONS refused at upload time on the PUBLIC CHAT SURFACE ONLY
     * (DEC-072) — the markup family by name.
     *
     * A hard-coded constant, deliberately NOT a settings key: an admin
     * narrowing `upload.file.blocked_extensions` (which the Filament settings
     * form allows, see AdminExpansionTest) must not be able to reopen the
     * unauthenticated surface. The html family also appears in the settings
     * default, so this list overlaps it on purpose — overlap is how the
     * public-chat answer stays a superset of the internal one no matter what
     * the setting says.
     *
     * @var list<string>
     */
    public const PUBLIC_CHAT_BLOCKED_EXTENSIONS = [
        'html', 'htm', 'xhtml', 'xht', 'shtml', 'shtm', 'hta', 'htc',
        'svg', 'svgz', 'xml', 'xsl', 'xslt', 'mhtml', 'mht',
    ];

    /**
     * True when this media type is refused on EVERY upload surface.
     *
     * Parameters are stripped ("text/html; charset=utf-8" is text/html) and the
     * comparison is lowercased — a client that sends `TEXT/HTML` must not slip
     * past a case-sensitive in_array.
     */
    public static function isAlwaysBlockedMime(?string $mime): bool
    {
        $normalized = self::normalize($mime);

        return $normalized !== null && in_array($normalized, self::ALWAYS_BLOCKED_MIMES, true);
    }

    /**
     * True when this media type executes in a browser context — the FLOOR PLUS
     * the markup family. This is the PUBLIC CHAT question; internal uploads ask
     * isAlwaysBlockedMime() instead.
     *
     * Superset by construction: it starts from isAlwaysBlockedMime(), so a type
     * added to the floor is automatically refused here too.
     */
    public static function isBrowserExecutable(?string $mime): bool
    {
        if (self::isAlwaysBlockedMime($mime)) {
            return true;
        }

        $normalized = self::normalize($mime);

        if ($normalized === null) {
            return false;
        }

        if (in_array($normalized, self::PUBLIC_CHAT_BLOCKED_MIMES, true)) {
            return true;
        }

        // +xml structured-syntax suffix: application/rss+xml, application/
        // atom+xml, application/xhtml+xml and every future sibling all render
        // as markup. Catching the suffix means the list above does not have to
        // be exhaustive to be safe.
        return str_ends_with($normalized, '+xml');
    }

    /**
     * True when this extension is refused on the PUBLIC CHAT surface.
     *
     * Takes an ALREADY NORMALISED extension (normalizeExtension() output), so
     * "evil.html " and "evil.HTML" have both collapsed to 'html' before they
     * get here.
     */
    public static function isPublicChatBlockedExtension(string $extension): bool
    {
        return $extension !== '' && in_array($extension, self::PUBLIC_CHAT_BLOCKED_EXTENSIONS, true);
    }

    /** True only for the explicit inline allowlist. */
    public static function isInlineSafe(?string $mime): bool
    {
        $normalized = self::normalize($mime);

        return $normalized !== null && in_array($normalized, self::INLINE_ALLOWED, true);
    }

    /** 'inline' for the allowlist, 'attachment' for everything else. */
    public static function disposition(?string $mime): string
    {
        return self::isInlineSafe($mime)
            ? ResponseHeaderBag::DISPOSITION_INLINE
            : ResponseHeaderBag::DISPOSITION_ATTACHMENT;
    }

    /**
     * The Content-Type we FORCE on the way out.
     *
     * Overridden even for allowlisted images, and that is the point: MinIO
     * stores and replays whatever Content-Type the uploading client put on its
     * presigned PUT, so a genuine PNG uploaded with `Content-Type: text/html`
     * is a polyglot that renders as a document. Overriding only the "unsafe"
     * types would leave exactly that case open. The value we send is the
     * SERVER-SNIFFED mime from the attachments row, not anything the client
     * said.
     */
    public static function responseType(?string $mime): string
    {
        $normalized = self::normalize($mime);

        return ($normalized !== null && self::isInlineSafe($normalized))
            ? $normalized
            : self::NEUTRAL_TYPE;
    }

    /**
     * S3/MinIO presigned-GET response overrides (`response-content-disposition`
     * and `response-content-type` in the signed query string).
     *
     * They are part of the signature, so a holder of the URL cannot strip or
     * edit them without invalidating it — which is what makes this a real
     * control and not a hint.
     *
     * NOTE what is NOT here: `X-Content-Type-Options: nosniff`. S3 response
     * overrides cover only content-type/disposition/language/encoding/cache-
     * control/expires; nosniff on the MinIO origin has to come from nginx. See
     * the ops note in the review report.
     *
     * @return array{ResponseContentDisposition: string, ResponseContentType: string}
     */
    public static function s3ResponseOverrides(?string $mime, ?string $filename = null): array
    {
        return [
            'ResponseContentDisposition' => self::contentDisposition($mime, $filename),
            'ResponseContentType' => self::responseType($mime),
        ];
    }

    /**
     * A fully formed Content-Disposition header value.
     *
     * `original_name` is attacker-controlled and Thai filenames are the norm
     * here, so the header is built by Symfony's HeaderUtils rather than by
     * string concatenation: it emits the RFC 6266 `filename*=UTF-8''…` form and
     * rejects header-unsafe input instead of letting a crafted name inject a
     * second header or a second disposition.
     */
    public static function contentDisposition(?string $mime, ?string $filename = null): string
    {
        $name = self::safeFilename($filename);

        return HeaderUtils::makeDisposition(
            self::disposition($mime),
            $name,
            self::asciiFallback($name),
        );
    }

    /**
     * Lowercased extension with the trailing dots and spaces that Windows and
     * several object stores silently strip removed first — "evil.html " and
     * "evil.html." must both compare equal to 'html'.
     */
    public static function normalizeExtension(string $filename): string
    {
        $trimmed = rtrim(trim($filename), " \t\n\r\0\x0B.");

        return strtolower(pathinfo($trimmed, PATHINFO_EXTENSION));
    }

    /** Media type without parameters, lowercased; null when there is nothing usable. */
    private static function normalize(?string $mime): ?string
    {
        if ($mime === null) {
            return null;
        }

        $base = strtolower(trim(explode(';', $mime, 2)[0]));

        return $base === '' ? null : $base;
    }

    private static function safeFilename(?string $filename): string
    {
        $name = trim((string) $filename);
        // makeDisposition refuses these outright; a name is cosmetic, so
        // degrade to a generic one rather than 500 on a weird upload.
        $name = str_replace(['/', '\\', "\r", "\n", "\0", '"'], '_', $name);

        return $name === '' ? 'download' : $name;
    }

    /**
     * makeDisposition's ASCII fallback must contain no '%', '/' or '\' and no
     * non-ASCII byte. A Thai filename reduces to 'download' rather than to
     * mojibake — the UTF-8 form alongside it is what every modern browser uses.
     */
    private static function asciiFallback(string $name): string
    {
        $ascii = preg_replace('/[^A-Za-z0-9._-]/', '_', $name) ?? '';
        $ascii = trim($ascii, '_');

        return $ascii === '' || $ascii === '.' || $ascii === '..' ? 'download' : $ascii;
    }
}
