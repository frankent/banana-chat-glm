import { describe, expect, it } from 'vitest';
import {
  CALL_DISCONNECT_REASON,
  classifyDisconnect,
  isMobileBrowser,
  MAX_RECONNECT_ATTEMPTS,
  reconnectDelayMs,
  shouldGiveUpReconnect,
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

describe('isMobileBrowser (FR-CALL-009 / DEC-086)', () => {
  it('TC-CALL-042 detects iOS, Android and iPadOS Safari; keeps touch-desktop and plain Macs on the boost chain', () => {
    expect(
      isMobileBrowser(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
        5,
        'iPhone',
      ),
    ).toBe(true);
    expect(
      isMobileBrowser(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36',
        5,
        'Linux armv8l',
      ),
    ).toBe(true);
    // iPadOS 13+: desktop-style UA/platform, only multi-touch betrays it.
    expect(
      isMobileBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        5,
        'MacIntel',
      ),
    ).toBe(true);
    // Real desktop Safari / Chrome on macOS: no multi-touch.
    expect(
      isMobileBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
        0,
        'MacIntel',
      ),
    ).toBe(false);
    // Touch-capable Windows laptop: Android absent from the UA, so boost stays on.
    expect(
      isMobileBrowser(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        10,
        'Win32',
      ),
    ).toBe(false);
  });
});
