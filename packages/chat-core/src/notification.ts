/** FR-NOTI-007: per-session deduplication and burst limiting. */
export class NotificationGate {
  private seen = new Set<string>();
  private lastPlayed = -Infinity;
  accept(id: string, enabled: boolean, focused: boolean, now: number): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
    if (!enabled || focused || now - this.lastPlayed < 1000) return false;
    this.lastPlayed = now;
    return true;
  }
}
export function unreadTitle(workspaces: ReadonlyArray<{total_unread: number}>): string {
  const count = workspaces.reduce((sum, workspace) => sum + Math.max(0, workspace.total_unread), 0);
  return `${count > 0 ? `(${count}) ` : ''}Banana Chat`;
}

/** Alert kinds carried by EVT-063 `notification.alert` (NotificationAlert.php:36). */
export type AlertKind = 'message' | 'mention' | 'call' | (string & {});

/**
 * FR-NOTI-003 — popup admission, kept separate from {@link NotificationGate}.
 *
 * The gate throttles to one accept per second, which is right for an audio chime
 * and wrong for OS popups: two messages in the same second are two things you want
 * to see, and the OS already coalesces by tag. It also folds dedupe and rate limit
 * into a single boolean, so calling it twice (once for sound, once for a popup)
 * would consume the dedupe on the first call. Hence a second, throttle-free gate.
 */
export class DesktopNotificationGate {
  private seen = new Set<string>();

  constructor(private readonly limit = 500) {}

  /** True the first time an alert id is offered, false for every repeat. */
  accept(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.limit) this.seen.delete(this.seen.values().next().value!);
    return true;
  }
}

/**
 * Popup body text. EVT-063 is deliberately content-free ({id, room_id, kind}), so
 * there is no message text to show here without an extra fetch — and defaulting to
 * a generic line also means a desktop popup can never leak message content onto a
 * shared screen, the same guarantee `preview_in_push=false` gives on mobile.
 */
export function desktopNotificationBody(kind: AlertKind): string {
  switch (kind) {
    case 'mention':
      return 'มีคนกล่าวถึงคุณ';
    case 'call':
      return 'สายเรียกเข้า';
    default:
      return 'ข้อความใหม่';
  }
}
