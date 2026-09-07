import type { Endpoints } from '@banana-chat/api-client';

/**
 * TASK-MOB-008 — push token lifecycle (API-070). Register on login, clear on
 * logout (TC-MOB-030). Token registration is idempotent; a token that moved
 * to another user is reclaimed server-side.
 */
export interface PushRegistrationDeps {
  endpoints: Pick<Endpoints, 'updateDevice'>;
  getPushToken: () => Promise<string | null>;
  getDeviceId: () => Promise<string>;
  getLocale: () => string;
  appVersion: string;
}

export async function registerPushToken(deps: PushRegistrationDeps, platform: 'ios' | 'android'): Promise<boolean> {
  const token = await deps.getPushToken();
  if (token === null) {
    return false; // permission denied or no token yet — TC-MOB-035 handles UX
  }
  await deps.endpoints.updateDevice(await deps.getDeviceId(), {
    push_token: token,
    push_provider: platform === 'ios' ? 'apns' : 'fcm',
    platform,
    app_version: deps.appVersion,
    device_name: 'Banana Chat mobile',
    locale: deps.getLocale(),
  });
  return true;
}

export async function clearPushToken(deps: PushRegistrationDeps, platform: 'ios' | 'android'): Promise<void> {
  await deps.endpoints.updateDevice(await deps.getDeviceId(), {
    push_token: null,
    push_provider: null,
    platform,
    app_version: deps.appVersion,
  });
}
