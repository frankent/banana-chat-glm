/** FR-MEET-002: shared preflight; server remains authoritative. */
export function meetingGuestName(value: string): string | null {
  const name = value.trim();
  return [...name].length >= 1 && [...name].length <= 80 ? name : null;
}
export function meetingReturnPath(value: string | null): string | null {
  return value && /^\/meet\/[a-f0-9]{64}$/.test(value) ? value : null;
}
