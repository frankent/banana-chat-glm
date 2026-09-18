/**
 * FR-NOTI-003 — the one sequence that turns notifications on.
 *
 * Popup permission and push registration are two different things that have to
 * happen in one order from one user gesture: ask for permission first (it is a
 * prerequisite for push anyway and it is what makes the tab-open case work), then
 * register with FCM. Two callers need it -- the notification panel and the soft-ask
 * prompt -- and a second copy of the order would be a copy that drifts.
 */

import { desktopNotificationPermission, requestDesktopNotificationPermission } from './desktop-notification';
import { currentWebPushStatus, enableWebPush, type EnableWebPushResult } from './web-push';

export interface EnableNotificationsOutcome {
  permission: NotificationPermission | 'unsupported';
  /** null when this deployment has no Firebase config, so push was never attempted. */
  push: EnableWebPushResult | null;
}

/**
 * MUST be called from a user gesture. Safari ignores requestPermission() outside
 * one, and Chrome demotes sites that fire it on page load to a silent indicator.
 */
export async function enableNotifications(): Promise<EnableNotificationsOutcome> {
  const permission = await requestDesktopNotificationPermission();

  if (permission !== 'granted' || currentWebPushStatus() === 'not-configured') {
    return { permission, push: null };
  }

  return { permission, push: await enableWebPush() };
}

/**
 * Whether this browser could still be asked. Used to decide if the soft ask is
 * worth showing at all -- `denied` is not reversible from script, so a prompt
 * would be a dead end.
 */
export function canAskForNotifications(): boolean {
  return desktopNotificationPermission() === 'default';
}
