/**
 * TASK-MOB-006 — media capture/upload policy (pure decisions, Jest-mocked).
 * Blocked extensions mirror the server setting upload.file.blocked_extensions.
 */
export const BLOCKED_EXTENSIONS = ['exe', 'bat', 'cmd', 'sh', 'ps1', 'msi', 'scr', 'js', 'jar', 'com', 'vbs'];

export const IMAGE_MAX_DIMENSION = 1920;
export const VIDEO_COMPRESS_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB
export const VIDEO_COMPRESS_TARGET_HEIGHT = 1080;

/** TC-MOB-022 — document picker rejects blocked extensions client-side. */
export function isExtensionAllowed(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) {
    return true; // no extension — server sniffs content type anyway
  }
  return !BLOCKED_EXTENSIONS.includes(filename.slice(dot + 1).toLowerCase());
}

/** TC-MOB-020 — images resize so max(w,h) ≤ 1920 before upload. */
export function imageResizePlan(width: number, height: number): { resize: boolean; width: number; height: number } {
  const max = Math.max(width, height);
  if (max <= IMAGE_MAX_DIMENSION) {
    return { resize: false, width, height };
  }
  const scale = IMAGE_MAX_DIMENSION / max;
  return { resize: true, width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** TC-MOB-021 — videos over 50MB compress to 1080p H.264 before upload. */
export function videoCompressPlan(sizeBytes: number, height: number): { compress: boolean; targetHeight: number } {
  if (sizeBytes <= VIDEO_COMPRESS_THRESHOLD_BYTES || height <= VIDEO_COMPRESS_TARGET_HEIGHT) {
    return { compress: false, targetHeight: height };
  }
  return { compress: true, targetHeight: VIDEO_COMPRESS_TARGET_HEIGHT };
}

/** image vs video vs generic file by mime (uploads API-060 kind). */
export function attachmentKind(mimeType: string, filename: string): 'image' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType === '' && /\.(jpe?g|png|gif|webp|heic)$/i.test(filename)) {
    return 'image';
  }
  if (mimeType === '' && /\.(mp4|mov|webm)$/i.test(filename)) {
    return 'video';
  }
  return 'file';
}
