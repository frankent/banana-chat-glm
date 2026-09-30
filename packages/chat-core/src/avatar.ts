import type { UserAvatar } from '@banana-chat/shared';

/**
 * FR-PROF-006 / DEC-088 — profile photo rules shared by every client.
 *
 * Pure and platform-agnostic on purpose: the web editor and a future mobile
 * picker must refuse the same files and crop the same pixels.
 */

/** Mirror of the server default `upload.avatar.max_bytes` (5 MB). A UX shortcut; the server re-checks. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];
/** Longest edge of a client-cropped still. The server thumbs cap at 400/1280 anyway. */
export const AVATAR_OUTPUT_MAX_PX = 1024;
export const AVATAR_MIN_ZOOM = 1;
export const AVATAR_MAX_ZOOM = 4;

const EXTENSION_MIME: Record<string, AvatarMimeType> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
};

export type AvatarFileCheck =
  | { ok: true; mime: AvatarMimeType; animated: boolean }
  | { ok: false; reason: 'empty' | 'type' | 'size' };

/**
 * Classify a picked/dropped/pasted file. A missing `type` (some OS drag
 * sources) falls back to the extension; a declared type always wins, so a
 * "photo.png" that says `text/html` is refused. Type is checked before size so
 * a 40 MB PDF is reported as the wrong kind of file, which is the fix the
 * person actually needs.
 */
export function checkAvatarFile(file: { type: string; size: number; name?: string }, maxBytes = AVATAR_MAX_BYTES): AvatarFileCheck {
  const declared = file.type.toLowerCase();
  const extension = (file.name ?? '').trim().split('.').pop()?.toLowerCase() ?? '';
  const mime = declared === ''
    ? EXTENSION_MIME[extension]
    : (AVATAR_MIME_TYPES as readonly string[]).includes(declared) ? declared as AvatarMimeType : undefined;
  if (mime === undefined) return { ok: false, reason: 'type' };
  if (file.size <= 0) return { ok: false, reason: 'empty' };
  if (file.size > maxBytes) return { ok: false, reason: 'size' };
  return { ok: true, mime, animated: mime === 'image/gif' };
}

/**
 * Which URL an avatar renders. Animated only when the viewer has not asked
 * for reduced motion; otherwise the static first-frame thumb.
 */
export function avatarSource(avatar: UserAvatar | null | undefined, options: { large?: boolean; reducedMotion?: boolean } = {}): string | null {
  if (!avatar) return null;
  if (avatar.animated && options.reducedMotion !== true) return avatar.animated;
  return options.large ? avatar.md : avatar.sm;
}

/**
 * Crop state for a square viewport of `box` CSS px. `x`/`y` are how far the
 * image centre sits from the viewport centre, in viewport px (positive = the
 * image moved right/down, revealing more of its left/top).
 */
export interface AvatarCrop {
  zoom: number;
  x: number;
  y: number;
}

export interface AvatarImageSize {
  width: number;
  height: number;
}

/** Scale at zoom 1: the SHORT edge exactly fills the viewport (cover). */
export function cropCoverScale(image: AvatarImageSize, box: number): number {
  return box / Math.min(image.width, image.height);
}

/** Zoom within bounds; pan so the image always covers the viewport (no empty corners). */
export function clampCrop(image: AvatarImageSize, box: number, crop: AvatarCrop): AvatarCrop {
  const zoom = Math.min(AVATAR_MAX_ZOOM, Math.max(AVATAR_MIN_ZOOM, Number.isFinite(crop.zoom) ? crop.zoom : 1));
  const scale = cropCoverScale(image, box) * zoom;
  const maxX = Math.max(0, (image.width * scale - box) / 2);
  const maxY = Math.max(0, (image.height * scale - box) / 2);
  const clamp = (value: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(-max, value)) : 0) || 0;
  return { zoom, x: clamp(crop.x, maxX), y: clamp(crop.y, maxY) };
}

export function panCrop(image: AvatarImageSize, box: number, crop: AvatarCrop, dx: number, dy: number): AvatarCrop {
  return clampCrop(image, box, { ...crop, x: crop.x + dx, y: crop.y + dy });
}

/** Zoom about the viewport centre: what is in the middle stays in the middle. */
export function zoomCrop(image: AvatarImageSize, box: number, crop: AvatarCrop, zoom: number): AvatarCrop {
  const next = Math.min(AVATAR_MAX_ZOOM, Math.max(AVATAR_MIN_ZOOM, zoom));
  const ratio = next / crop.zoom;
  return clampCrop(image, box, { zoom: next, x: crop.x * ratio, y: crop.y * ratio });
}

/**
 * The square of SOURCE pixels the viewport shows — exactly what a canvas
 * `drawImage(img, sx, sy, size, size, 0, 0, out, out)` needs. Clamped first,
 * so a stale state can never sample outside the bitmap.
 */
export function cropSourceRect(image: AvatarImageSize, box: number, crop: AvatarCrop): { sx: number; sy: number; size: number } {
  const safe = clampCrop(image, box, crop);
  const scale = cropCoverScale(image, box) * safe.zoom;
  const size = Math.min(box / scale, image.width, image.height);
  const sx = Math.min(image.width - size, Math.max(0, image.width / 2 - safe.x / scale - size / 2));
  const sy = Math.min(image.height - size, Math.max(0, image.height / 2 - safe.y / scale - size / 2));
  return { sx, sy, size };
}

/** Output edge: never upscale a small crop, never exceed the cap. */
export function cropOutputSize(sourceSize: number, max = AVATAR_OUTPUT_MAX_PX): number {
  return Math.max(1, Math.min(max, Math.round(sourceSize)));
}
