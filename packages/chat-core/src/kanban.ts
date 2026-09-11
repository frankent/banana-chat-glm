/** FR-KAN-003: identifiers and deadline state shared by clients. */
export function ticketKey(workspaceSlug: string, number: number): string { return `${workspaceSlug.toUpperCase()}-${number}`; }
export function deadlineState(due: string | null, done: boolean, now = Date.now()): 'done' | 'none' | 'overdue' | 'upcoming' {
  if (done) return 'done';
  if (!due) return 'none';
  return Date.parse(due) <= now ? 'overdue' : 'upcoming';
}
