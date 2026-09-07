import { describe, expect, it } from '@jest/globals';
import type { Endpoints } from '@banana-chat/api-client';
import { clearPushToken, registerPushToken } from '../registration';

/**
 * TASK-MOB-008 — push token lifecycle (TC-MOB-030).
 */
function makeDeps(token: string | null) {
  const calls: Array<Record<string, unknown>> = [];
  const endpoints = {
    async updateDevice(deviceId: string, input: Record<string, unknown>) {
      calls.push({ deviceId, input });
      return { device: { id: deviceId, push_token: null } };
    },
  } as unknown as Pick<Endpoints, 'updateDevice'>;
  return {
    calls,
    deps: {
      endpoints,
      getPushToken: async () => token,
      getDeviceId: async () => '01DEVICEID0000000000000000',
      getLocale: () => 'th',
      appVersion: '1.2.3',
    },
  };
}

describe('push registration', () => {
  it('TC-MOB-030 registers the token on login with provider mapped by platform', async () => {
    const { calls, deps } = makeDeps('fcm-token-abc');

    expect(await registerPushToken(deps, 'android')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      push_token: 'fcm-token-abc',
      push_provider: 'fcm',
      platform: 'android',
      app_version: '1.2.3',
      locale: 'th',
    });

    const ios = makeDeps('apns-token-xyz');
    await registerPushToken(ios.deps, 'ios');
    expect(ios.calls[0]!.input).toMatchObject({ push_provider: 'apns', platform: 'ios' });
  });

  it('TC-MOB-030/035 no token (permission denied) → skip registration, not an error', async () => {
    const { calls, deps } = makeDeps(null);
    expect(await registerPushToken(deps, 'ios')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('TC-MOB-030 logout clears the token server-side', async () => {
    const { calls, deps } = makeDeps('fcm-token-abc');
    await clearPushToken(deps, 'android');
    expect(calls[0]!.input).toMatchObject({ push_token: null, push_provider: null, platform: 'android' });
  });
});
