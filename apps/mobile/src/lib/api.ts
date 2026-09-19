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

export const api = new ApiClient(
  API_BASE_URL,
  tokenManager,
  fetch.bind(globalThis),
  () => ({ 'X-App-Version': appVersion() }),
  // R8 — the only automatic route to /force-update lives in _layout.tsx's
  // __onApiError handler; nothing previously called it.
  (e) => (globalThis as { __onApiError?: (e: unknown) => void }).__onApiError?.(e),
);

export const endpoints = new Endpoints(api);

/** client-generated device id (stable per install) for API-070 */
export const DEVICE_ID_KEY = 'bc.device_id';

// The server means ULID literally (whereUlid + the `ulid` rule), and base36 is not
// Crockford base32 -- it has I, L, O and U. The timestamp prefix alone currently
// contains U and O, so every id this used to mint was rejected and no mobile device
// has ever registered for push. Shared with web now, one correct implementation.
export { generateDeviceId as newDeviceId } from '@banana-chat/chat-core';
