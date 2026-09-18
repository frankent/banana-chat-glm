import { describe, it, expect } from 'vitest';
import {
  isWebPushConfigured,
  webPushStatus,
  serviceWorkerUrl,
  resolveWebDeviceId,
  WEB_DEVICE_ID_KEY,
  type FirebaseWebConfig,
} from './web-push.js';

const config: FirebaseWebConfig = {
  apiKey: 'k', projectId: 'p', messagingSenderId: 's', appId: 'a', vapidKey: 'v',
};
const env = (over: Partial<Parameters<typeof webPushStatus>[0]> = {}) => ({
  hasNotification: true, hasServiceWorker: true, hasPushManager: true,
  isIos: false, isStandalone: false, configured: true, ...over,
});

describe('isWebPushConfigured (FR-NOTI-003)', () => {
  it('requires every key — push ships dormant until all are supplied', () => {
    expect(isWebPushConfigured(config)).toBe(true);
    expect(isWebPushConfigured(null)).toBe(false);
    expect(isWebPushConfigured({})).toBe(false);
    for (const key of Object.keys(config) as (keyof FirebaseWebConfig)[]) {
      expect(isWebPushConfigured({ ...config, [key]: '' })).toBe(false);
      expect(isWebPushConfigured({ ...config, [key]: '   ' })).toBe(false);
    }
  });
});

describe('webPushStatus', () => {
  it('is ready when configured and the browser is capable', () => {
    expect(webPushStatus(env())).toBe('ready');
  });

  it('reports not-configured before anything else, even on a capable browser', () => {
    expect(webPushStatus(env({ configured: false }))).toBe('not-configured');
  });

  // The iOS gate is the whole reason this is not a boolean: the capability is real
  // but only exists once the site is on the Home Screen.
  it('tells an iPhone in a Safari tab to install, not that it is unsupported', () => {
    expect(webPushStatus(env({ isIos: true, isStandalone: false, hasNotification: false, hasPushManager: false })))
      .toBe('needs-install');
  });

  it('is ready on iOS once running standalone', () => {
    expect(webPushStatus(env({ isIos: true, isStandalone: true }))).toBe('ready');
  });

  it('is unsupported for a non-iOS browser missing the APIs', () => {
    expect(webPushStatus(env({ hasPushManager: false }))).toBe('unsupported');
    expect(webPushStatus(env({ hasServiceWorker: false }))).toBe('unsupported');
  });
});

describe('serviceWorkerUrl', () => {
  it('passes config the worker cannot read from build env', () => {
    const url = serviceWorkerUrl(config);
    expect(url.startsWith('/firebase-messaging-sw.js?')).toBe(true);
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('apiKey')).toBe('k');
    expect(params.get('projectId')).toBe('p');
    expect(params.get('messagingSenderId')).toBe('s');
    expect(params.get('appId')).toBe('a');
  });

  it('never leaks the vapid key into the registration URL', () => {
    expect(serviceWorkerUrl(config)).not.toContain('v');
    expect(new URLSearchParams(serviceWorkerUrl(config).split('?')[1]).get('vapidKey')).toBeNull();
  });
});

describe('resolveWebDeviceId', () => {
  const store = (initial: Record<string, string> = {}) => {
    const map = new Map(Object.entries(initial));
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
    };
  };

  // Realistic ids, because the stored value is now checked against the shape the
  // server accepts -- a placeholder like 'existing' is exactly what gets discarded.
  const STORED = '04FE874857C34DB2B13E110E44';
  const MINTED = '0123456789ABCDEFGHJKMNPQRS';

  it('reuses a persisted id so one browser is one device row', () => {
    const s = store({ [WEB_DEVICE_ID_KEY]: STORED });
    expect(resolveWebDeviceId(s, () => MINTED)).toBe(STORED);
  });

  it('mints and persists on first use', () => {
    const s = store();
    expect(resolveWebDeviceId(s, () => MINTED)).toBe(MINTED);
    expect(s.map.get(WEB_DEVICE_ID_KEY)).toBe(MINTED);
  });

  // Safari private mode throws on write; registering push matters more than
  // reusing the row, so this degrades instead of failing.
  it('still returns an id when storage throws', () => {
    const hostile = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(resolveWebDeviceId(hostile, () => 'fresh')).toBe('fresh');
    expect(resolveWebDeviceId(null, () => 'fresh')).toBe('fresh');
  });
});
