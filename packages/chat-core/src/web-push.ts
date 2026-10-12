import { isValidDeviceId } from './device-id.js';

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
export function serviceWorkerUrl(
  config: FirebaseWebConfig,
  /**
   * Build id. A browser treats a different script URL as a different worker, so this
   * is what gets a corrected worker onto devices that already installed an old one.
   * Without it the edge cache (Cloudflare was answering with max-age=14400 despite
   * the origin sending no-cache) can keep serving the previous file for hours, and
   * an old worker paired with a new payload shape renders duplicates.
   */
  version = '',
  path = '/firebase-messaging-sw.js',
): string {
  const params = new URLSearchParams({
    apiKey: config.apiKey,
    projectId: config.projectId,
    messagingSenderId: config.messagingSenderId,
    appId: config.appId,
  });
  if (version !== '') {
    params.set('v', version);
  }
  return `${path}?${params.toString()}`;
}

/**
 * A device row belongs to one user (the server answers DEVICE_FORBIDDEN to anyone
 * else presenting its id, DEC-103), and one browser profile can be signed in as
 * several people over time. So the id cannot be one-per-profile: it is kept per user.
 * Per workspace would be wrong the other way -- a push token is account-wide, and
 * several rows sharing one FCM token cannot coexist. The origin is already part of
 * localStorage's own scoping, so per domain needs no key of its own.
 *
 * Callers hand in their own storage so this stays testable and storage-agnostic; a
 * failure to persist degrades to a fresh id rather than throwing (Safari private
 * mode throws on localStorage writes).
 */
export const WEB_DEVICE_ID_KEY = 'banana-chat:web-device-id';

/**
 * The pre-DEC-103 key was one per browser profile and is never read again: an id
 * from it may belong to a different account, and adopting it is the bug.
 */
export function webDeviceIdKey(userId: string): string {
  return `${WEB_DEVICE_ID_KEY}:${userId}`;
}

type DeviceIdStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function resolveWebDeviceId(
  storage: DeviceIdStorage | null,
  generate: () => string,
  userId: string,
): string {
  try {
    const existing = storage?.getItem(webDeviceIdKey(userId));
    // A stored id the server will reject is worse than none: it is returned on every
    // load, so the browser retries a registration that can only 404, forever. Both
    // endpoints validate before writing anything, so there is no row to orphan by
    // re-minting.
    if (existing !== null && existing !== undefined && existing !== '' && isValidDeviceId(existing)) {
      return existing;
    }
  } catch {
    // unreadable storage — fall through and mint a throwaway id
  }

  return mintWebDeviceId(storage, generate, userId);
}

/** Replace this user's stored id with a fresh one (see withDeviceIdRecovery). */
export function mintWebDeviceId(
  storage: DeviceIdStorage | null,
  generate: () => string,
  userId: string,
): string {
  const fresh = generate();
  try {
    storage?.setItem(webDeviceIdKey(userId), fresh);
  } catch {
    // unwritable storage (private mode): the id lasts for this page only, which
    // means a duplicate device row per session. Acceptable; the alternative is
    // refusing to register push at all.
  }
  return fresh;
}

/** The API answered that the device id belongs to another account (DEC-103). */
export function isDeviceForbidden(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'DEVICE_FORBIDDEN';
}

/**
 * Run a device-scoped call; if the server says the id is someone else's, mint a new
 * one and try exactly once more. Stored ids made before DEC-103 can belong to a
 * different account on the same browser, and this is what un-sticks them without
 * asking anyone to clear site data. One retry only: a second refusal is a real fault
 * and must surface rather than loop.
 */
export async function withDeviceIdRecovery<T>(
  run: (deviceId: string) => Promise<T>,
  current: string,
  remint: () => string,
): Promise<T> {
  try {
    return await run(current);
  } catch (error) {
    if (!isDeviceForbidden(error)) {
      throw error;
    }
    return run(remint());
  }
}
