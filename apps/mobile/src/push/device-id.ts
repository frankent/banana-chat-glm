import { newDeviceId } from '../lib/api';

/**
 * TASK-MOB-008 — stable device id for API-070 upserts. Persisted next to the
 * refresh token in SecureStore with a sync in-memory mirror.
 */
const KEY = 'bc.device_id';

interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

let secure: SecureStoreLike | null = null;
let cached: string | null = null;

async function loadNative(): Promise<SecureStoreLike> {
  if (secure === null) {
    const mod = await import('expo-secure-store');
    secure = mod as unknown as SecureStoreLike;
  }
  return secure;
}

/** returns the persisted device id, creating one on first run */
export async function getOrCreateDeviceId(): Promise<string> {
  if (cached !== null) {
    return cached;
  }
  const store = await loadNative();
  const existing = await store.getItemAsync(KEY);
  if (existing !== null && existing !== '') {
    cached = existing;
    return existing;
  }
  const id = newDeviceId();
  cached = id;
  await store.setItemAsync(KEY, id);
  return id;
}

export function cachedDeviceId(): string | null {
  return cached;
}
