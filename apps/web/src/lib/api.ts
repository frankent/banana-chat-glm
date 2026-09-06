import { ApiClient } from '@banana-chat/api-client';
import { Endpoints } from '@banana-chat/api-client';
import { TokenManager } from '@banana-chat/api-client';
import type { TokenStore } from '@banana-chat/api-client';

/** DEC-011 — refresh token in localStorage, access token in memory only. */
const localStorageStore: TokenStore = {
  getRefreshToken(): string | null {
    return window.localStorage.getItem('orgchat.refresh');
  },
  setRefreshToken(token: string | null): void {
    if (token === null) {
      window.localStorage.removeItem('orgchat.refresh');
    } else {
      window.localStorage.setItem('orgchat.refresh', token);
    }
  },
};

export const tokenManager = new TokenManager('/api/v1/auth/refresh', localStorageStore);

export const api = new ApiClient('', tokenManager);

export const endpoints = new Endpoints(api);
