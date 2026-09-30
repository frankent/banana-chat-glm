/**
 * FR-CALL-009 / DEC-086 — background survival + automatic rejoin decisions.
 * CLAUDE.md: platform-agnostic call logic lives in chat-core so web and any
 * future client share one implementation; apps only supply SDK values.
 */

/**
 * Numeric mirror of livekit-client's `DisconnectReason` (the protobuf enum).
 * Duplicated here so the classification below stays SDK-free and unit-testable
 * in chat-core; apps pass `DisconnectReason.X` straight through.
 */
export const CALL_DISCONNECT_REASON = {
  UNKNOWN: 0,
  CLIENT_INITIATED: 1,
  DUPLICATE_IDENTITY: 2,
  SERVER_SHUTDOWN: 3,
  PARTICIPANT_REMOVED: 4,
  ROOM_DELETED: 5,
  STATE_MISMATCH: 6,
  JOIN_FAILURE: 7,
  MIGRATION: 8,
  SIGNAL_CLOSE: 9,
  ROOM_CLOSED: 10,
  USER_UNAVAILABLE: 11,
  USER_REJECTED: 12,
  SIP_TRUNK_FAILURE: 13,
} as const;

/** What MediaPanel should do after a `RoomEvent.Disconnected`. */
export type CallDisconnectAction = 'leave' | 'rejoin';

/**
 * FR-CALL-009 / DEC-086: a disconnect only ends the call for us when the room
 * or our membership in it is gone (CLIENT_INITIATED, ROOM_DELETED,
 * PARTICIPANT_REMOVED or DUPLICATE_IDENTITY). Everything else — JOIN_FAILURE (livekit-client's "server unreachable", exactly what a
 * phone sees for a moment after returning from the background), USER_REJECTED
 * (a 401 from an expired token), signal close, network change, server shutdown,
 * unknown/undefined — is transient and must trigger an automatic rejoin
 * instead of hanging up, because mobile browsers routinely freeze the socket
 * in the background.
 */
export function classifyDisconnect(
  reason: number | undefined,
  callerCancelled: boolean,
): CallDisconnectAction {
  if (callerCancelled) return 'leave';
  switch (reason) {
    case CALL_DISCONNECT_REASON.CLIENT_INITIATED:
    case CALL_DISCONNECT_REASON.ROOM_DELETED:
    case CALL_DISCONNECT_REASON.PARTICIPANT_REMOVED:
    case CALL_DISCONNECT_REASON.DUPLICATE_IDENTITY:
      return 'leave';
    default:
      return 'rejoin';
  }
}

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 8_000;
export const MAX_RECONNECT_ATTEMPTS = 6;

/** FR-CALL-009: 1s, 2s, 4s, 8s… capped — `failedAttempts` are already-failed tries. */
export function reconnectDelayMs(failedAttempts: number): number {
  const n = Number.isFinite(failedAttempts) && failedAttempts > 0 ? Math.floor(failedAttempts) : 0;
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** n, RECONNECT_MAX_DELAY_MS);
}

/** FR-CALL-009: give up (leaveCall) once this many consecutive rejoins failed. */
export function shouldGiveUpReconnect(
  failedAttempts: number,
  max: number = MAX_RECONNECT_ATTEMPTS,
): boolean {
  return failedAttempts >= max;
}

/**
 * FR-CALL-009 / DEC-086: iOS/Android Safari and Chrome suspend the Web Audio
 * graph when the page is backgrounded, silencing every track routed through
 * the FR-CALL-008 boost chain — on those browsers MediaPanel must not create
 * the AudioContext at all (plain `<audio>` playback keeps working). iPadOS
 * 13+ masquerades as desktop macOS ("MacIntel" platform), so multi-touch is
 * the discriminator there.
 */
export function isMobileBrowser(ua: string, maxTouchPoints: number, platform: string): boolean {
  if (/iPhone|iPad|iPod|Android/.test(ua)) {
    return maxTouchPoints > 1;
  }
  return platform === 'MacIntel' && maxTouchPoints > 1;
}
