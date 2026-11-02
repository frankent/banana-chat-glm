/** FR-PCHAT-043 — pure helpers behind the group-room create/rotate-password UI. */

export const GROUP_PASSWORD_MIN = 6;
export const GROUP_PASSWORD_MAX = 72;
export const GROUP_TITLE_MAX = 120;
export const GROUP_EXPIRY_MIN_DAYS = 1;
export const GROUP_EXPIRY_MAX_DAYS = 365;

export type GroupPasswordStrength = 'empty' | 'invalid' | 'weak' | 'good' | 'strong';

/** No look-alike characters (0/O, 1/l/I). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_';

type RandomBytes = (bytes: Uint8Array) => Uint8Array;

/** Uniform password from `crypto` randomness using rejection sampling (no modulo bias). */
export function generateGroupPassword(
  length = 20,
  random: RandomBytes = (bytes) => {
    globalThis.crypto.getRandomValues(bytes as never);
    return bytes;
  },
): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    const bytes = random(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Length-based guidance only; a run of one repeated character is always weak. */
export function groupPasswordStrength(password: string): GroupPasswordStrength {
  if (password === '') return 'empty';
  if (password.length < GROUP_PASSWORD_MIN || password.length > GROUP_PASSWORD_MAX) return 'invalid';
  if (new Set(password).size === 1) return 'weak';
  if (password.length >= 16) return 'strong';
  if (password.length >= 12) return 'good';
  return 'weak';
}

export function isValidGroupPassword(password: string): boolean {
  return password.length >= GROUP_PASSWORD_MIN && password.length <= GROUP_PASSWORD_MAX;
}

export function isValidGroupTitle(title: string): boolean {
  const n = title.trim().length;
  return n >= 1 && n <= GROUP_TITLE_MAX;
}

/** Whole days 1..365 from a text field; null for empty, decimal or out-of-range input. */
export function parseGroupExpiryDays(raw: string): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= GROUP_EXPIRY_MIN_DAYS && n <= GROUP_EXPIRY_MAX_DAYS ? n : null;
}
