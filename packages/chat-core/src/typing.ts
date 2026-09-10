/** FR-RT-003: untrusted/stale typing events never outlive six seconds. */
export class TypingState {
  private members = new Map<string, { name: string; until: number }>();
  constructor(private readonly selfId: string, private readonly now = () => Date.now()) {}
  receive(userId: string, name: string, typing: boolean): void {
    if (userId === this.selfId) return;
    if (!typing) this.members.delete(userId);
    else this.members.set(userId, {name, until: this.now() + 6000});
  }
  names(): string[] {
    for (const [id, member] of this.members) if (member.until <= this.now()) this.members.delete(id);
    return [...this.members.values()].map(member => member.name);
  }
}

/** Throttle publishes while typing, then explicitly clear on idle/send/unmount. */
export class TypingPublisher {
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly publish: (typing: boolean) => void) {}
  update(nonempty: boolean): void {
    if (!nonempty) { this.stop(); return; }
    if (Date.now() - this.last >= 2500) { this.last = Date.now(); this.publish(true); }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), 3000);
  }
  stop(): void { clearTimeout(this.timer); if (this.last) this.publish(false); this.last = 0; }
}
