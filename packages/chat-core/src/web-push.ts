/**
 * FR-NOTI-003 — Web Push readiness rules.
 *
 * Platform-agnostic decisions only (CLAUDE.md: no app-specific logic in apps/).
 * The browser calls live in apps/web; everything here is pure so it can be tested.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
  /** VAPID public key ("Web Push certificate" in the Firebase console). */
  vapidKey: string;
}

/**
 * Push ships dormant. An operator supplies Firebase credentials at build time; with
 * any piece missing the whole feature must stay inert rather than half-initialise
 * and throw inside the SDK.
 */
export function isWebPushConfigured(config: Partial<FirebaseWebConfig> | null | undefined): config is FirebaseWebConfig {
  if (!config) return false;
  return (['apiKey', 'projectId', 'messagingSenderId', 'appId', 'vapidKey'] as const)
    .every((key) => typeof config[key] === 'string' && config[key]!.trim() !== '');
}

export interface WebPushEnvironment {
  hasNotification: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  /** iOS/iPadOS Safari, by UA. */
  isIos: boolean;
  /** Running from the Home Screen (display-mode: standalone / navigator.standalone). */
  isStandalone: boolean;
  configured: boolean;
}

export type WebPushStatus =
  /** Everything present — we can ask for permission and fetch a token. */
  | 'ready'
  /** iOS in a normal Safari tab: the APIs exist only for an installed PWA. */
  | 'needs-install'
  /** Browser cannot do web push at all. */
  | 'unsupported'
  /** Code is here, credentials are not. */
  | 'not-configured';

/**
 * Why `needs-install` is its own state rather than folding into `unsupported`:
 * on iOS 16.4+ the capability is real but gated behind Add to Home Screen, and
 * Safari does not expose `Notification` in a normal tab at all. Telling an iPhone
 * user "your browser doesn't support notifications" would be both wrong and a
 * dead end — they need one specific instruction instead.
 */
export function webPushStatus(env: WebPushEnvironment): WebPushStatus {
  if (!env.configured) return 'not-configured';

  const capable = env.hasNotification && env.hasServiceWorker && env.hasPushManager;
  if (capable) return 'ready';

  // Missing capability on iOS outside standalone is the documented install gate,
  // not a missing feature.
  if (env.isIos && !env.isStandalone) return 'needs-install';

  return 'unsupported';
}

/**
 * The service worker is a static file, so it cannot read build-time env. The page
 * passes config on the registration URL and the worker reads it from its own
 * location.search. vapidKey is deliberately NOT included: it is only used by the
 * page when calling getToken(), and there is no reason to put it in a URL the
 * browser persists against the registration.
 */
export function serviceWorkerUrl(config: FirebaseWebConfig, path = '/firebase-messaging-sw.js'): string {
  const params = new URLSearchParams({
    apiKey: config.apiKey,
    projectId: config.projectId,
    messagingSenderId: config.messagingSenderId,
    appId: config.appId,
  });
  return `${path}?${params.toString()}`;
}

/**
 * A device row is per browser profile, not per tab or per login, so the id has to
 * outlive both. Callers hand in their own storage so this stays testable and
 * storage-agnostic; a failure to persist degrades to a fresh id rather than
 * throwing (Safari private mode throws on localStorage writes).
 */
export const WEB_DEVICE_ID_KEY = 'banana-chat:web-device-id';

export function resolveWebDeviceId(
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void } | null,
  generate: () => string,
): string {
  try {
    const existing = storage?.getItem(WEB_DEVICE_ID_KEY);
    if (existing !== null && existing !== undefined && existing !== '') {
      return existing;
    }
  } catch {
    // unreadable storage — fall through and mint a throwaway id
  }

  const fresh = generate();
  try {
    storage?.setItem(WEB_DEVICE_ID_KEY, fresh);
  } catch {
    // unwritable storage (private mode): the id lasts for this page only, which
    // means a duplicate device row per session. Acceptable; the alternative is
    // refusing to register push at all.
  }
  return fresh;
}
