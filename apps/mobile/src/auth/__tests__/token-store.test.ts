import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { bindSecureStore, primeTokenStore, secureTokenStore } from '../token-store';

/**
 * TASK-MOB-001 — SecureStore token persistence (TC-MOB-040).
 */
const nativeStore = new Map<string, string>();

beforeEach(() => {
  nativeStore.clear();
  bindSecureStore({
    getItemAsync: async (k) => nativeStore.get(k) ?? null,
    setItemAsync: async (k, v) => void nativeStore.set(k, v),
    deleteItemAsync: async (k) => void nativeStore.delete(k),
  });
});

describe('secureTokenStore', () => {
  it('TC-MOB-040 persists the refresh token through SecureStore, never logs it', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    secureTokenStore.setRefreshToken('rt-secret-value');
    await new Promise((r) => setTimeout(r, 0)); // let the native mirror settle

    expect(nativeStore.get('bc.refresh_token')).toBe('rt-secret-value');

    await primeTokenStore(); // cold start reads it back into memory
    expect(secureTokenStore.getRefreshToken()).toBe('rt-secret-value');

    secureTokenStore.setRefreshToken(null);
    await new Promise((r) => setTimeout(r, 0));
    expect(nativeStore.has('bc.refresh_token')).toBe(false);

    for (const call of logSpy.mock.calls) {
      expect(String(call)).not.toContain('rt-secret-value');
    }
    logSpy.mockRestore();
  });

  it('TC-MOB-040 a fresh install starts with no token → anonymous', async () => {
    await primeTokenStore();
    expect(secureTokenStore.getRefreshToken()).toBeNull();
  });
});
