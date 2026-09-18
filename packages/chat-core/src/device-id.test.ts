import { describe, expect, it } from 'vitest';
import { DEVICE_ID_PATTERN, generateDeviceId, isValidDeviceId } from './device-id.js';
import { WEB_DEVICE_ID_KEY, resolveWebDeviceId } from './web-push.js';

describe('device ids the server will actually accept', () => {
  it('never emits one the ULID route constraint rejects', () => {
    // The old web generator failed this 50.1% of the time and the old mobile one
    // 100% of the time; both went unnoticed because nothing asserted the shape.
    for (let i = 0; i < 5000; i += 1) {
      expect(generateDeviceId()).toMatch(DEVICE_ID_PATTERN);
    }
  });

  it('keeps the leading 0-7 across the whole plausible clock range', () => {
    for (const ms of [0, Date.now(), Date.UTC(2100, 0, 1), Date.UTC(9999, 11, 31)]) {
      expect(generateDeviceId(ms)).toMatch(/^[0-7]/);
    }
  });

  it('emits no Crockford-excluded letter even from a hostile rng', () => {
    // Exercises the Math.random fallback across every bucket, including the ones
    // that would map to I, L, O or U in a naive base36 encoding.
    for (let bucket = 0; bucket < 32; bucket += 1) {
      const id = generateDeviceId(Date.now(), () => bucket / 32);
      expect(id).not.toMatch(/[ILOU]/);
      expect(id).toMatch(DEVICE_ID_PATTERN);
    }
  });

  it('rejects the shapes the old generators produced', () => {
    expect(isValidDeviceId('A4FE874857C34DB2B13E110E44')).toBe(false); // web: leading hex 8-F
    expect(isValidDeviceId('00MU6O04T5JZ1HO8SV36N00000')).toBe(false); // mobile: U and O
    expect(isValidDeviceId('04FE874857C34DB2B13E110E44')).toBe(true);
    expect(isValidDeviceId('')).toBe(false);
    expect(isValidDeviceId(null)).toBe(false);
  });
});

describe('resolveWebDeviceId', () => {
  const storage = (initial: string | null) => {
    let value = initial;
    return {
      getItem: () => value,
      setItem: (_k: string, v: string) => {
        value = v;
      },
      read: () => value,
    };
  };

  it('discards a stored id the server would reject and persists a usable one', () => {
    const store = storage('A4FE874857C34DB2B13E110E44');
    const id = resolveWebDeviceId(store, generateDeviceId);
    expect(id).not.toBe('A4FE874857C34DB2B13E110E44');
    expect(id).toMatch(DEVICE_ID_PATTERN);
    expect(store.read()).toBe(id);
  });

  it('keeps a valid stored id so the device row stays stable', () => {
    const store = storage('04FE874857C34DB2B13E110E44');
    expect(resolveWebDeviceId(store, generateDeviceId)).toBe('04FE874857C34DB2B13E110E44');
  });

  it('still works when storage throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
    };
    expect(resolveWebDeviceId(hostile, generateDeviceId)).toMatch(DEVICE_ID_PATTERN);
    expect(WEB_DEVICE_ID_KEY).toBe('banana-chat:web-device-id');
  });
});
