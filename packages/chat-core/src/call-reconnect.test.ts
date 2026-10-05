import { describe, expect, it } from 'vitest';
import {
  CALL_DISCONNECT_REASON,
  classifyDisconnect,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  shouldGiveUpReconnect,
  shouldPlayViaMediaElement,
} from './call-reconnect.js';

describe('classifyDisconnect (FR-CALL-009 / DEC-086)', () => {
  it('TC-CALL-040 leaves only on terminal reasons: caller cancel, client hang-up, removed, deleted, duplicate, join failure', () => {
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.CLIENT_INITIATED, false)).toBe('leave');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.ROOM_DELETED, false)).toBe('leave');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.PARTICIPANT_REMOVED, false)).toBe('leave');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.DUPLICATE_IDENTITY, false)).toBe('leave');
    // JOIN_FAILURE = "server unreachable" and USER_REJECTED = expired token 401: both are what a
    // phone sees on return from the background, so they must rejoin, not hang up.
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.JOIN_FAILURE, false)).toBe('rejoin');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.USER_REJECTED, false)).toBe('rejoin');
    // Our own registered disconnect / parent teardown wins over any reason.
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.SIGNAL_CLOSE, true)).toBe('leave');
    expect(classifyDisconnect(undefined, true)).toBe('leave');
  });

  it('TC-CALL-040 rejoins on transient reasons: unknown, signal close, server shutdown, state mismatch, migration, undefined', () => {
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.UNKNOWN, false)).toBe('rejoin');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.SIGNAL_CLOSE, false)).toBe('rejoin');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.SERVER_SHUTDOWN, false)).toBe('rejoin');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.STATE_MISMATCH, false)).toBe('rejoin');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.MIGRATION, false)).toBe('rejoin');
    expect(classifyDisconnect(CALL_DISCONNECT_REASON.ROOM_CLOSED, false)).toBe('rejoin');
    expect(classifyDisconnect(undefined, false)).toBe('rejoin');
  });
});

describe('reconnect backoff and give-up (FR-CALL-009 / DEC-086)', () => {
  it('TC-CALL-041 doubles the delay 1s→2s→4s→8s and caps it there', () => {
    expect(reconnectDelayMs(0)).toBe(1_000);
    expect(reconnectDelayMs(1)).toBe(2_000);
    expect(reconnectDelayMs(2)).toBe(4_000);
    expect(reconnectDelayMs(3)).toBe(8_000);
    expect(reconnectDelayMs(4)).toBe(8_000);
    expect(reconnectDelayMs(99)).toBe(8_000);
  });

  it('TC-CALL-041 gives up only after the attempt budget is exhausted', () => {
    expect(shouldGiveUpReconnect(0)).toBe(false);
    expect(shouldGiveUpReconnect(MAX_RECONNECT_ATTEMPTS - 1)).toBe(false);
    expect(shouldGiveUpReconnect(MAX_RECONNECT_ATTEMPTS)).toBe(true);
    expect(shouldGiveUpReconnect(MAX_RECONNECT_ATTEMPTS + 1)).toBe(true);
    expect(MAX_RECONNECT_ATTEMPTS).toBe(6);
  });
});

describe('shouldPlayViaMediaElement (FR-CALL-008/009 / DEC-094)', () => {
  it('TC-CALL-049 the boost graph owns playback only while the AudioContext is running; any other state hands it to the <audio> element', () => {
    expect(shouldPlayViaMediaElement('running')).toBe(false);
    // iOS Safari reports a backgrounded context as "interrupted"; a not-yet-unlocked one is "suspended".
    expect(shouldPlayViaMediaElement('interrupted')).toBe(true);
    expect(shouldPlayViaMediaElement('suspended')).toBe(true);
    expect(shouldPlayViaMediaElement('closed')).toBe(true);
  });
});
