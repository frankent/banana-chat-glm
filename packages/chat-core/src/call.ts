/** FR-CALL-003: invalidate asynchronous joins before they can acquire devices for an old session. */
export class CallAttempt {
  private epoch = 0;
  begin(): number {
    return ++this.epoch;
  }
  isCurrent(attempt: number): boolean {
    return this.epoch === attempt;
  }
  cancel(): void {
    this.epoch++;
  }
}
export function canRingCall(
  call: { started_by: string; created_at: string; participants: string[] },
  userId: string,
  now = Date.now(),
): boolean {
  return (
    call.started_by !== userId &&
    !call.participants.includes(userId) &&
    now - Date.parse(call.created_at) < 60_000
  );
}
