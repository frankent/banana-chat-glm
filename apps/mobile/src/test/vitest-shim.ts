/**
 * The chat-core contract suite is authored against vitest's API surface
 * (describe/it/expect). Under Jest we alias `vitest` to this shim so the SAME
 * contract source runs in both runners (TC-MOB-002).
 */
export { describe, expect, it } from '@jest/globals';
