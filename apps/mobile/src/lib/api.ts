import Constants from 'expo-constants';
import { ApiClient, Endpoints, TokenManager } from '@banana-chat/api-client';
import { secureTokenStore } from '../auth/token-store';

/**
 * TASK-MOB-001 — api-client wiring. X-App-Version rides every request so the
 * 426 APP_UPDATE_REQUIRED gate (BE-025) can do its job.
 */
export const API_BASE_URL: string =
  (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl ?? 'http://localhost:8000';

export function appVersion(): string {
  return Constants.expoConfig?.version ?? '0.0.0';
}

export const tokenManager = new TokenManager(`${API_BASE_URL}/api/v1/auth/refresh`, secureTokenStore);

export const api = new ApiClient(API_BASE_URL, tokenManager, fetch.bind(globalThis), () => ({
  'X-App-Version': appVersion(),
}));

export const endpoints = new Endpoints(api);

/** client-generated device id (stable per install) for API-070 */
export const DEVICE_ID_KEY = 'bc.device_id';

export function newDeviceId(): string {
  // ULID-ish: time-ordered + random — device ids are ULIDs on the server
  const time = Date.now().toString(36).padStart(10, '0');
  const rand = Math.random().toString(36).slice(2, 16).padEnd(16, '0');
  return (time + rand).toUpperCase();
}
