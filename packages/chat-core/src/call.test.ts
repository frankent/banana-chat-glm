import { describe, it, expect } from "vitest";
import { CallAttempt, canRingCall } from "./call.js";
describe("TC-CALL-009 session and navigation isolation", () => {
  it("invalidates a pending join after logout or another attempt", () => {
    const g = new CallAttempt();
    const first = g.begin();
    g.cancel();
    expect(g.isCurrent(first)).toBe(false);
    const second = g.begin();
    expect(g.isCurrent(second)).toBe(true);
    expect(g.isCurrent(first)).toBe(false);
  });
  it("TC-CALL-003 rings only fresh calls from someone else", () => {
    const c = {
      started_by: "a",
      participants: ["a"],
      created_at: new Date(1000).toISOString(),
    };
    expect(canRingCall(c, "b", 2000)).toBe(true);
    expect(canRingCall(c, "a", 2000)).toBe(false);
    expect(canRingCall(c, "b", 62000)).toBe(false);
  });
});
