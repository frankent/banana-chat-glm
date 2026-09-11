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
