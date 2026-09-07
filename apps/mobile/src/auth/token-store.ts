import type { TokenStore } from '@banana-chat/api-client';

/**
 * TASK-MOB-001 — refresh token in SecureStore (encrypted keystore/keychain),
 * never logged. TokenStore is sync, so an in-memory copy is primed once at
 * cold start (primeTokenStore) and mirrored on every write (TC-MOB-040).
 */
const KEY = 'bc.refresh_token';

interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** injectable so Jest can pass a plain map (expo-secure-store is native) */
let secure: SecureStoreLike | null = null;
let cached: string | null = null;

export function bindSecureStore(impl: SecureStoreLike): void {
  secure = impl;
}

async function loadFromNative(): Promise<SecureStoreLike> {
  if (secure === null) {
    const mod = await import('expo-secure-store');
    secure = mod as unknown as SecureStoreLike;
  }
  return secure;
}

export async function primeTokenStore(): Promise<void> {
  const store = await loadFromNative();
  cached = await store.getItemAsync(KEY);
}

export const secureTokenStore: TokenStore = {
  getRefreshToken: () => cached,
  setRefreshToken: (token) => {
    cached = token;
    void loadFromNative().then((store) =>
      token === null ? store.deleteItemAsync(KEY) : store.setItemAsync(KEY, token),
    );
  },
};
