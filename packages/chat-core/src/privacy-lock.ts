/** FR-NOTI-009 / DEC-087: a client-side screen guard, not authentication or encryption. */
export const PRIVACY_MODE_STORAGE_KEY = 'bc.privacy_mode';
export const MAX_PRIVACY_SUSPENSION_MS = 60_000;

export function parsePrivacyModeMirror(value: unknown): boolean {
  return value === '1';
}

export function privacyModeMirrorValue(enabled: boolean): '1' | null {
  return enabled ? '1' : null;
}

/** Pure lifecycle policy. Browser callers supply a monotonic clock and trusted gesture evidence. */
export class PrivacyLock {
  private privacyEnabled: boolean;
  private session: boolean;
  private needsUnlock: boolean;
  private hidden = false;
  private suspensionDeadline = 0;

  constructor({ mirror, hasSession }: { mirror: string | null; hasSession: boolean }) {
    this.privacyEnabled = parsePrivacyModeMirror(mirror);
    this.session = hasSession;
    this.needsUnlock = this.privacyEnabled && hasSession;
  }

  get enabled(): boolean { return this.privacyEnabled; }
  get locked(): boolean { return this.session && this.privacyEnabled && this.needsUnlock; }
  // Cover even exempt picker transitions so app-switcher snapshots cannot expose a conversation.
  get covered(): boolean { return this.session && this.privacyEnabled && (this.hidden || this.needsUnlock); }
  get suspendedUntil(): number { return this.suspensionDeadline; }

  setEnabled(enabled: boolean, lockOnEnable = true): void {
    const changed = this.privacyEnabled !== enabled;
    this.privacyEnabled = enabled;
    if (!enabled) {
      this.needsUnlock = false;
      this.suspensionDeadline = 0;
    } else if (changed && this.session) {
      this.needsUnlock = lockOnEnable || this.hidden;
    }
  }

  setSession(hasSession: boolean): void {
    if (!hasSession) { this.logout(); return; }
    if (!this.session) this.needsUnlock = this.privacyEnabled;
    this.session = true;
  }

  hide(now: number): void {
    this.hidden = true;
    if (this.session && this.privacyEnabled && !this.isSuspended(now)) this.needsUnlock = true;
  }

  show(now: number): void {
    if (this.hidden && this.session && this.privacyEnabled && !this.isSuspended(now)) this.needsUnlock = true;
    this.hidden = false;
    // One picker return consumes the exemption; it cannot exempt later app switches.
    this.suspensionDeadline = 0;
  }

  pageShow(persisted: boolean, now: number): void {
    if (persisted && this.session && this.privacyEnabled) this.needsUnlock = true;
    this.show(now);
  }

  suspend(ms: number, now: number, trustedUserGesture: boolean): boolean {
    if (!trustedUserGesture || !this.session || !this.privacyEnabled || this.covered || !Number.isFinite(ms) || ms <= 0 || !Number.isFinite(now)) return false;
    const deadline = now + Math.min(ms, MAX_PRIVACY_SUSPENSION_MS);
    // Repeated calls cannot extend an active exemption indefinitely.
    this.suspensionDeadline = this.isSuspended(now) ? Math.min(this.suspensionDeadline, deadline) : deadline;
    return true;
  }

  expire(now: number): void {
    if (this.suspensionDeadline && !this.isSuspended(now)) {
      this.suspensionDeadline = 0;
      if (this.hidden && this.session && this.privacyEnabled) this.needsUnlock = true;
    }
  }

  /** FR-NOTI-009: a picker that finishes without hiding must not leave a spare exemption. */
  cancelSuspension(): void {
    this.suspensionDeadline = 0;
    if (this.hidden && this.session && this.privacyEnabled) this.needsUnlock = true;
  }

  /** Call only after a successful verify-password response. Never unmask a hidden page. */
  unlock(): boolean {
    if (this.hidden || !this.session) return false;
    this.needsUnlock = false;
    this.suspensionDeadline = 0;
    return true;
  }

  logout(): void {
    this.session = false;
    this.privacyEnabled = false;
    this.needsUnlock = false;
    this.hidden = false;
    this.suspensionDeadline = 0;
  }

  private isSuspended(now: number): boolean {
    return Number.isFinite(now) && now < this.suspensionDeadline;
  }
}
