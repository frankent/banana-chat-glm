import { describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_PATTERN, generateDeviceId, isValidDeviceId } from './device-id.js';
import {
  WEB_DEVICE_ID_KEY,
  isDeviceForbidden,
  mintWebDeviceId,
  resolveWebDeviceId,
  webDeviceIdKey,
  withDeviceIdRecovery,
} from './web-push.js';

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

describe('resolveWebDeviceId (DEC-103: one id per user per browser)', () => {
  const memory = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  };

  it('TC-CORE-077 discards a stored id the server would reject and persists a usable one', () => {
    const store = memory({ [webDeviceIdKey('u1')]: 'A4FE874857C34DB2B13E110E44' });
    const id = resolveWebDeviceId(store, generateDeviceId, 'u1');
    expect(id).not.toBe('A4FE874857C34DB2B13E110E44');
    expect(id).toMatch(DEVICE_ID_PATTERN);
    expect(store.data.get(webDeviceIdKey('u1'))).toBe(id);
  });

  it('keeps a valid stored id so the device row stays stable', () => {
    const store = memory({ [webDeviceIdKey('u1')]: '04FE874857C34DB2B13E110E44' });
    expect(resolveWebDeviceId(store, generateDeviceId, 'u1')).toBe('04FE874857C34DB2B13E110E44');
  });

  it('TC-CORE-076 gives two accounts on one browser two different ids', () => {
    // The reported bug: account B was handed account A's id and the server answered
    // DEVICE_FORBIDDEN, so push could never be enabled for B.
    const store = memory();
    const a = resolveWebDeviceId(store, generateDeviceId, 'user-a');
    const b = resolveWebDeviceId(store, generateDeviceId, 'user-b');
    expect(a).not.toBe(b);
    expect(resolveWebDeviceId(store, generateDeviceId, 'user-a')).toBe(a);
    expect(resolveWebDeviceId(store, generateDeviceId, 'user-b')).toBe(b);
  });

  it('TC-CORE-076 never adopts the pre-DEC-103 per-profile id, which may belong to someone else', () => {
    const legacy = '04FE874857C34DB2B13E110E44';
    const store = memory({ [WEB_DEVICE_ID_KEY]: legacy });
    const id = resolveWebDeviceId(store, generateDeviceId, 'u1');
    expect(id).not.toBe(legacy);
    expect(id).toMatch(DEVICE_ID_PATTERN);
  });

  it('TC-CORE-077 still works when storage throws', () => {
    const hostile = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
    };
    expect(resolveWebDeviceId(hostile, generateDeviceId, 'u1')).toMatch(DEVICE_ID_PATTERN);
    expect(resolveWebDeviceId(null, generateDeviceId, 'u1')).toMatch(DEVICE_ID_PATTERN);
    expect(WEB_DEVICE_ID_KEY).toBe('banana-chat:web-device-id');
    expect(webDeviceIdKey('u1')).toBe('banana-chat:web-device-id:u1');
  });

  it('TC-CORE-077 mintWebDeviceId replaces only that user\'s stored id', () => {
    const store = memory();
    const b = resolveWebDeviceId(store, generateDeviceId, 'user-b');
    const a1 = resolveWebDeviceId(store, generateDeviceId, 'user-a');
    const a2 = mintWebDeviceId(store, generateDeviceId, 'user-a');
    expect(a2).not.toBe(a1);
    expect(resolveWebDeviceId(store, generateDeviceId, 'user-a')).toBe(a2);
    expect(resolveWebDeviceId(store, generateDeviceId, 'user-b')).toBe(b);
  });
});

describe('withDeviceIdRecovery', () => {
  const forbidden = () => Object.assign(new Error('[DEVICE_FORBIDDEN] x'), { code: 'DEVICE_FORBIDDEN', status: 403 });

  it('TC-CORE-080 recognises only the DEVICE_FORBIDDEN code', () => {
    expect(isDeviceForbidden(forbidden())).toBe(true);
    expect(isDeviceForbidden(Object.assign(new Error('x'), { code: 'FORBIDDEN', status: 403 }))).toBe(false);
    expect(isDeviceForbidden(new Error('network'))).toBe(false);
    expect(isDeviceForbidden(null)).toBe(false);
    expect(isDeviceForbidden('DEVICE_FORBIDDEN')).toBe(false);
  });

  it('TC-CORE-078 passes straight through when the id is accepted', async () => {
    const run = vi.fn(async (id: string) => id);
    const remint = vi.fn(() => 'fresh');
    await expect(withDeviceIdRecovery(run, 'mine', remint)).resolves.toBe('mine');
    expect(run).toHaveBeenCalledTimes(1);
    expect(remint).not.toHaveBeenCalled();
  });

  it('TC-CORE-079 re-mints and retries once when the id belongs to another account', async () => {
    const run = vi.fn(async (id: string) => {
      if (id === 'stolen') throw forbidden();
      return id;
    });
    await expect(withDeviceIdRecovery(run, 'stolen', () => 'fresh')).resolves.toBe('fresh');
    expect(run.mock.calls.map(([id]) => id)).toEqual(['stolen', 'fresh']);
  });

  it('TC-CORE-079 gives up after one retry instead of looping', async () => {
    const run = vi.fn(async () => {
      throw forbidden();
    });
    const remint = vi.fn(() => 'fresh');
    await expect(withDeviceIdRecovery(run, 'stolen', remint)).rejects.toMatchObject({ code: 'DEVICE_FORBIDDEN' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(remint).toHaveBeenCalledTimes(1);
  });

  it('TC-CORE-080 does not re-mint for any other failure', async () => {
    const boom = new Error('offline');
    const remint = vi.fn(() => 'fresh');
    await expect(withDeviceIdRecovery(async () => { throw boom; }, 'mine', remint)).rejects.toBe(boom);
    expect(remint).not.toHaveBeenCalled();
  });
});
