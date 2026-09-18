/**
 * FR-NOTI-003 — Web Push registration (browser glue).
 *
 * Pairs with `public/firebase-messaging-sw.js`. This module owns everything that
 * needs a browser: feature detection, service-worker registration, fetching an FCM
 * registration token and handing it to the API as a device row.
 *
 * The decision rules live in `@banana-chat/chat-core/web-push` so they can be unit
 * tested; this file stays thin on purpose.
 *
 * Ships DORMANT. With no `VITE_FIREBASE_*` build vars every entry point here
 * returns a status and does nothing — the app must never throw or prompt because
 * an operator has not set up Firebase yet.
 */

import {
  generateDeviceId,
  isWebPushConfigured,
  resolveWebDeviceId,
  serviceWorkerUrl,
  webPushStatus,
  type FirebaseWebConfig,
  type WebPushStatus,
} from '@banana-chat/chat-core';
import { endpoints } from './api';

declare const __SW_BUILD_ID__: string;

/**
 * Build-time config. Vite inlines these; absent vars become '' and
 * isWebPushConfigured() then reports the whole feature as not-configured.
 */
const config: Partial<FirebaseWebConfig> = {
  apiKey: import.meta.env['VITE_FIREBASE_API_KEY'] ?? '',
  projectId: import.meta.env['VITE_FIREBASE_PROJECT_ID'] ?? '',
  messagingSenderId: import.meta.env['VITE_FIREBASE_MESSAGING_SENDER_ID'] ?? '',
  appId: import.meta.env['VITE_FIREBASE_APP_ID'] ?? '',
  vapidKey: import.meta.env['VITE_FIREBASE_VAPID_KEY'] ?? '',
};

function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Macintosh; maxTouchPoints separates it from a real Mac.
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}

/**
 * Whether a push for this device would actually be delivered and rendered by the
 * service worker. Callers use it to stay out of the worker's way rather than
 * double-render the same message.
 */
export function isWebPushReady(): boolean {
  return (
    currentWebPushStatus() === 'ready' &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted' &&
    lastResult?.state === 'enabled'
  );
}

export function currentWebPushStatus(): WebPushStatus {
  return webPushStatus({
    hasNotification: 'Notification' in window,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    isIos: isIos(),
    isStandalone: isStandalone(),
    configured: isWebPushConfigured(config),
  });
}

let registration: ServiceWorkerRegistration | null = null;

/**
 * Register the push worker. Idempotent — the browser dedupes by scope, and we cache
 * the registration so repeated calls are free.
 */
export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isWebPushConfigured(config) || !('serviceWorker' in navigator)) {
    return null;
  }
  if (registration !== null) {
    return registration;
  }
  try {
    registration = await navigator.serviceWorker.register(serviceWorkerUrl(config, __SW_BUILD_ID__), { scope: '/' });
    return registration;
  } catch {
    // A failed SW registration must never break the app. The most common cause is
    // the file 404ing and nginx serving index.html as text/html instead -- which is
    // why the deploy checklist verifies /firebase-messaging-sw.js returns JS.
    return null;
  }
}

/**
 * Outcome of an enable attempt.
 *
 * A bare status was not enough. `failed` covers a VAPID mismatch, a blocked push
 * service and an iOS home-screen app without the entitlement, and the panel could
 * say nothing about any of them -- so a user whose registration failed saw exactly
 * what a user with working notifications sees, and had nothing to report back.
 */
export type EnableWebPushResult =
  | { state: 'enabled' }
  | { state: 'denied' }
  | { state: 'blocked'; status: WebPushStatus }
  | { state: 'failed'; reason: string };

let lastResult: EnableWebPushResult | null = null;

/**
 * The most recent attempt in this page's lifetime, including the silent one
 * ensureWebPushRegistered() makes on load, so the panel can surface a failure the
 * user was never present for.
 */
export function lastWebPushResult(): EnableWebPushResult | null {
  return lastResult;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    // Firebase attaches a machine-readable code (messaging/token-subscribe-failed
    // and friends); it is the part worth quoting in a bug report.
    const code = (error as { code?: string }).code;
    return code !== undefined && code !== '' ? `${code} (${error.message})` : error.message;
  }
  return String(error);
}

/**
 * Full enable path, driven by an explicit user gesture (TC-WEB-030):
 * permission -> service worker -> FCM token -> device row on the server.
 */
let inFlight: Promise<EnableWebPushResult> | null = null;

export async function enableWebPush(): Promise<EnableWebPushResult> {
  // Concurrent callers share one run. The silent registration on load and the
  // user pressing the button overlap constantly, and two getToken() calls against
  // the same service worker make Firebase rotate: it mints a second token and
  // DELETES the first. The server had already stored whichever one landed first,
  // so the push that followed came back UNREGISTERED and the device was struck
  // off -- observed end to end on a clean profile.
  if (inFlight !== null) {
    return inFlight;
  }

  inFlight = runEnable();
  try {
    lastResult = await inFlight;
    return lastResult;
  } finally {
    inFlight = null;
  }
}

/**
 * Finish a registration the browser has already consented to.
 *
 * Until this existed a user who granted permission but whose token never reached
 * the server was stuck: the enable button only rendered while permission was still
 * `default`, so the device stayed tokenless for good and no push could ever be
 * addressed to it. This is also the only path that picks up a rotated FCM token.
 *
 * It never prompts -- requestPermission() resolves immediately when permission is
 * already granted -- so TC-WEB-030 (no prompt without a gesture) still holds.
 */
export async function ensureWebPushRegistered(): Promise<EnableWebPushResult | null> {
  if (currentWebPushStatus() !== 'ready' || Notification.permission !== 'granted') {
    return null;
  }
  return enableWebPush();
}

async function runEnable(): Promise<EnableWebPushResult> {
  const status = currentWebPushStatus();
  if (status !== 'ready') {
    return { state: 'blocked', status };
  }

  // Never ask twice. WebKit resolves requestPermission() as `denied` whenever it is
  // called outside a user gesture -- including when permission has ALREADY been
  // granted -- and by the time enableNotifications() has awaited its own call the
  // gesture is spent. Asking again turned a successful Allow on iOS into
  // "push is not available on this browser (denied)", and it silently broke the
  // auto-registration path too, which never runs from a gesture at all.
  const permission = Notification.permission === 'granted'
    ? 'granted'
    : await Notification.requestPermission();
  if (permission !== 'granted') {
    return { state: 'denied' };
  }

  const swRegistration = await registerPushServiceWorker();
  if (swRegistration === null) {
    return { state: 'failed', reason: 'service worker did not register' };
  }

  let token: string;
  try {
    // Imported lazily so the Firebase SDK is not in the initial bundle for a
    // deployment that has push switched off.
    const [{ initializeApp, getApps, getApp }, { getMessaging, getToken, isSupported }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    if (!(await isSupported())) {
      return { state: 'blocked', status: 'unsupported' };
    }

    // Reuse the app across retries: initializeApp() is only idempotent for an
    // identical config, and a second call is now reachable (auto-register on load,
    // then the user pressing the button).
    const app = getApps().length > 0
      ? getApp()
      : initializeApp({
          apiKey: config.apiKey!,
          projectId: config.projectId!,
          messagingSenderId: config.messagingSenderId!,
          appId: config.appId!,
        });

    token = await getToken(getMessaging(app), {
      vapidKey: config.vapidKey!,
      serviceWorkerRegistration: swRegistration,
    });
  } catch (error) {
    return { state: 'failed', reason: describe(error) };
  }

  if (!token) {
    return { state: 'failed', reason: 'Firebase returned an empty token' };
  }

  try {
    await endpoints.updateDevice(webDeviceId(), {
      platform: 'web',
      push_token: token,
      push_provider: 'fcm',
      device_name: navigator.userAgent.slice(0, 100),
      locale: navigator.language?.slice(0, 5) ?? null,
    });
  } catch (error) {
    // Kept distinct from a token failure: the browser side worked and the next load
    // will retry, which is a different thing to tell the user.
    return { state: 'failed', reason: `could not save this device (${describe(error)})` };
  }

  return { state: 'enabled' };
}

/**
 * Stable per-browser device id. The server keys a device row on it, so it must
 * survive reloads and logins — see resolveWebDeviceId for the storage-failure rule.
 */
export function webDeviceId(): string {
  return resolveWebDeviceId(
    typeof localStorage !== 'undefined' ? localStorage : null,
    generateDeviceId,
  );
}

/**
 * API-074 focus reporting. The server silences a push when the user's device is
 * already looking at that room within the last 30s (FR-NOTI-002), and until now
 * web never told it anything — so a desktop user got a phone push for a message
 * they were actively reading. Fire-and-forget: a failed ping must not surface.
 */
export function reportFocus(roomId: string | null): void {
  if (!isWebPushConfigured(config)) {
    return;
  }
  void endpoints.reportFocus(webDeviceId(), roomId).catch(() => {});
}
