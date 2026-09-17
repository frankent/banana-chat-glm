/**
 * FR-NOTI-003 / FR-NOTI-007 — native OS notification popups while the tab is open.
 *
 * SCOPE, stated plainly: this is the *foreground* branch. A `Notification`
 * constructed by page code only exists while the page does, so on a phone it stops
 * firing the moment the tab is backgrounded and the JS context is frozen. Background
 * delivery needs a service worker plus Web Push; when that lands, the permission
 * request, the renderer and the click router here become its foreground path (a push
 * arriving while a window client is visible is handed to the page, not the worker),
 * so none of this is throwaway.
 *
 * Deliberately NOT reusing chat-core's `NotificationGate`: it enforces a
 * 1-per-second burst limit that is right for an audio chime and wrong for popups —
 * two messages in the same second are two things you want to see. It also returns
 * false for the *whole* decision, so calling it twice (once for sound, once for a
 * popup) would consume the dedupe on the first call. This module keeps its own
 * id set and no rate limit; the OS already coalesces by tag.
 */

import { DesktopNotificationGate, desktopNotificationBody } from '@banana-chat/chat-core';
import type { AlertKind } from '@banana-chat/chat-core';

export interface DesktopNotificationInput {
  /** InAppNotification id — used only for dedupe, never displayed. */
  id: string;
  kind: AlertKind;
  /** Room display name when we know it; the popup falls back to the app name. */
  roomName?: string | null;
  /** Where a click should land. */
  href: string;
}

/** Supported = the API exists at all. Safari on iOS in a normal tab has no `Notification`. */
export function desktopNotificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function desktopNotificationPermission(): NotificationPermission | 'unsupported' {
  return desktopNotificationsSupported() ? Notification.permission : 'unsupported';
}

/**
 * TC-WEB-030 — the prompt must follow an explicit user gesture, never page load.
 * Call this from a click handler only.
 */
export async function requestDesktopNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!desktopNotificationsSupported()) {
    return 'unsupported';
  }
  try {
    return await Notification.requestPermission();
  } catch {
    // Older Safari rejects rather than resolving 'denied'.
    return Notification.permission;
  }
}

// Dedupe and body text are platform-agnostic, so they live in chat-core and are
// unit-tested there (CLAUDE.md: "Platform-agnostic client logic lives in
// packages/chat-core, never in apps"). What stays here is only the browser glue.
const gate = new DesktopNotificationGate();

/**
 * Show one popup. No-ops unless permission is granted and this id is new.
 *
 * The popup carries the room name but NOT the message text. EVT-063 is deliberately
 * content-free ({id, room_id, kind}) so the body is not available here without an
 * extra fetch — and defaulting to no content also means a desktop popup can never
 * leak message text onto a shared screen, which is the same guarantee
 * `preview_in_push=false` gives on mobile. Surfacing the preview for users who have
 * opted in is a follow-up, not an oversight.
 */
export function showDesktopNotification(
  input: DesktopNotificationInput,
  navigate: (href: string) => void,
): void {
  if (!desktopNotificationsSupported() || Notification.permission !== 'granted') {
    return;
  }
  if (!gate.accept(input.id)) {
    return;
  }

  try {
    const notification = new Notification(input.roomName?.trim() || 'Banana Chat', {
      body: desktopNotificationBody(input.kind),
      // Collapse repeats from the same room into one popup, matching the
      // collapse_key/tag the push payload uses (§10).
      tag: input.href,
      renotify: false,
      silent: true, // the in-app chime already played; two sounds is worse than one
    } as NotificationOptions);

    notification.onclick = () => {
      window.focus();
      navigate(input.href);
      notification.close();
    };
  } catch {
    // Constructing a Notification throws on some platforms (notably Android
    // Chrome, which requires a service worker registration). Failing to show a
    // popup must never break message handling.
  }
}
