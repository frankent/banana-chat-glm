/**
 * Device identifiers.
 *
 * The server routes device registration through `->whereUlid('deviceId')` and
 * validates focus reports with the `ulid` rule, so an id that is merely "26 chars,
 * looks random" is rejected: Crockford base32 has no I, L, O or U, and a ULID's
 * first character must be 0-7.
 *
 * Both clients learned this the hard way. Web minted uppercase hex from
 * randomUUID(), so half of all browser profiles produced an id starting 8-F and
 * got a hard 404 from the registration endpoint -- measured at 50.1%, and
 * confirmed against the live API where the same request differing only in its
 * first character returned 404 for 'A' and 200 for '0'. Mobile built one from
 * base36, whose alphabet includes the four excluded letters; the timestamp prefix
 * alone currently contains both U and O, so every mobile device id was invalid.
 * Neither platform could register for push at all, and neither failure was
 * visible: the focus report swallows its own errors.
 */

/** Crockford base32: the digits, minus I, L, O and U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Matches Laravel's whereUlid() constraint and Symfony's Ulid::isValid(). */
export const DEVICE_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isValidDeviceId(id: string | null | undefined): boolean {
  return typeof id === 'string' && DEVICE_ID_PATTERN.test(id);
}

function randomChars(count: number, rng: () => number): string {
  const webCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof webCrypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(count);
    webCrypto.getRandomValues(bytes);
    // 256 is a whole multiple of 32, so the modulo is uniform rather than biased.
    return Array.from(bytes, (byte) => CROCKFORD[byte % 32]).join('');
  }
  let out = '';
  for (let i = 0; i < count; i += 1) {
    out += CROCKFORD[Math.floor(rng() * 32)];
  }
  return out;
}

/**
 * A real ULID: 48-bit millisecond timestamp in 10 characters, then 16 random ones.
 *
 * The timestamp encoding is what guarantees the leading 0-7 the server insists on
 * -- 48 bits do not fill 10 base32 characters, so the top two bits stay clear until
 * the year 10889. Nothing here can emit an excluded letter, because every character
 * is indexed out of the Crockford alphabet rather than produced by toString(36).
 */
export function generateDeviceId(now: number = Date.now(), rng: () => number = Math.random): string {
  let time = Math.floor(now);
  let stamp = '';
  for (let i = 0; i < 10; i += 1) {
    stamp = CROCKFORD[time % 32] + stamp;
    time = Math.floor(time / 32);
  }
  return stamp + randomChars(16, rng);
}
