/**
 * TASK-MOB-014 — pure helpers for the search screen (FR-SRCH-001/002).
 */

/** RN Text renders no HTML — turn the server's <mark> tags into visible guillemets. */
export function stripMarks(highlight: string): string {
  return highlight.replaceAll('<mark>', '«').replaceAll('</mark>', '»');
}

/** API-080 server contract: q must be >= 2 chars (TC-SRCH-006 mirrors client-side). */
export function isSearchable(q: string): boolean {
  return q.trim().length >= 2;
}

/** ?around_seq= deep-link param → integer seq, or undefined when absent/invalid. */
export function parseAroundSeq(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
