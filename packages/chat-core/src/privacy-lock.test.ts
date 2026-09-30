import { describe, expect, it } from 'vitest';
import { PrivacyLock, parsePrivacyModeMirror, privacyModeMirrorValue } from './privacy-lock.js';

const unlocked = () => {
  const lock = new PrivacyLock({ mirror: '1', hasSession: true });
  lock.unlock();
  return lock;
};

describe('FR-NOTI-009 privacy lifecycle', () => {
  it('TC-AUTH-PRIVACY-001 cold start locks only with both mirror and session', () => {
    for (const mirror of [null, '0', '1']) {
      for (const hasSession of [false, true]) {
        const lock = new PrivacyLock({ mirror, hasSession });
        expect(lock.locked).toBe(mirror === '1' && hasSession);
        expect(lock.covered).toBe(lock.locked);
      }
    }
  });
  it('TC-AUTH-PRIVACY-002 covers at hide and requires unlock on every return', () => {
    const lock = unlocked();
    lock.hide(10);
    expect(lock.covered).toBe(true);
    expect(lock.locked).toBe(true);
    expect(lock.unlock()).toBe(false);
    lock.show(11);
    expect(lock.locked).toBe(true);
    expect(lock.unlock()).toBe(true);
    expect(lock.covered).toBe(false);
    lock.hide(12);
    lock.show(12);
    expect(lock.locked).toBe(true);
  });
  it('TC-AUTH-PRIVACY-003 bfcache restore requires unlock even with an exemption', () => {
    const lock = unlocked();
    lock.pageShow(false, 0);
    expect(lock.locked).toBe(false);
    lock.suspend(1000, 0, true);
    lock.pageShow(true, 1);
    expect(lock.locked).toBe(true);
  });
  it('TC-AUTH-PRIVACY-004 picker exemption covers snapshots and is consumed on return', () => {
    const lock = unlocked();
    expect(lock.suspend(1000, 0, true)).toBe(true);
    lock.hide(10);
    expect(lock.covered).toBe(true);
    expect(lock.locked).toBe(false);
    lock.show(999);
    expect(lock.covered).toBe(false);
    expect(lock.suspendedUntil).toBe(0);
    lock.hide(999);
    lock.show(999);
    expect(lock.locked).toBe(true);
  });
  it('TC-AUTH-PRIVACY-005 suspension is capped and cannot be extended by repeated calls', () => {
    const lock = unlocked();
    lock.suspend(999_999, 100, true);
    expect(lock.suspendedUntil).toBe(60_100);
    lock.suspend(60_000, 200, true);
    expect(lock.suspendedUntil).toBe(60_100);
    lock.hide(201);
    lock.expire(60_100);
    expect(lock.locked).toBe(true);
    lock.show(60_101);
    expect(lock.locked).toBe(true);
  });
  it('TC-AUTH-PRIVACY-006 expired exemption locks on return even if timer was throttled', () => {
    const lock = unlocked();
    lock.suspend(50, 10, true);
    lock.hide(20);
    lock.show(60);
    expect(lock.locked).toBe(true);
  });
  it('TC-AUTH-PRIVACY-007 untrusted/invalid requests and locked/hidden state cannot suspend', () => {
    const lock = unlocked();
    expect(lock.suspend(1000, 0, false)).toBe(false);
    for (const ms of [0, -1, NaN, Infinity]) expect(lock.suspend(ms, 0, true)).toBe(false);
    expect(lock.suspend(100, NaN, true)).toBe(false);
    lock.hide(10);
    expect(lock.suspend(100, 10, true)).toBe(false);
    lock.show(10);
    expect(lock.suspend(100, 10, true)).toBe(false);
  });
  it('TC-AUTH-PRIVACY-008 authoritative disable and logout clear all lock and mirror state', () => {
    const lock = unlocked();
    lock.suspend(1000, 0, true);
    lock.hide(1);
    lock.setEnabled(false);
    expect(lock.locked).toBe(false);
    expect(lock.covered).toBe(false);
    expect(lock.suspendedUntil).toBe(0);
    expect(privacyModeMirrorValue(lock.enabled)).toBeNull();
    lock.setEnabled(true);
    expect(lock.locked).toBe(true);
    lock.logout();
    expect(lock.covered).toBe(false);
    expect(lock.enabled).toBe(false);
    expect(lock.unlock()).toBe(false);
    expect(lock.suspend(100, 0, true)).toBe(false);
  });
  it('TC-AUTH-PRIVACY-009 server enable locks and repeated refresh preserves unlock', () => {
    const lock = new PrivacyLock({ mirror: null, hasSession: true });
    lock.setEnabled(true);
    expect(lock.locked).toBe(true);
    lock.unlock();
    lock.setEnabled(true);
    expect(lock.locked).toBe(false);
    lock.setSession(false);
    lock.setEnabled(true);
    lock.setSession(true);
    expect(lock.locked).toBe(true);
    lock.setEnabled(true, false);
    expect(lock.locked).toBe(true);
  });
  it('TC-AUTH-PRIVACY-010 picker completion without hide cancels the unused exemption', () => {
    const lock = unlocked();
    lock.suspend(1000, 0, true);
    lock.cancelSuspension();
    expect(lock.suspendedUntil).toBe(0);
    expect(lock.locked).toBe(false);
    lock.hide(1);
    lock.show(2);
    expect(lock.locked).toBe(true);
  });
  it('TC-AUTH-PRIVACY-011 cancelling while hidden fails closed', () => {
    const lock = unlocked();
    lock.suspend(1000, 0, true);
    lock.hide(1);
    lock.cancelSuspension();
    expect(lock.covered).toBe(true);
    lock.show(2);
    expect(lock.locked).toBe(true);
  });
  it('TC-WEB-PRIVACY-001 mirror accepts only the exact flag and never treats truthy strings as enabled', () => {
    for (const value of [null, undefined, '', '0', 'true', true, 1, {}, ' 1', '1 ']) expect(parsePrivacyModeMirror(value)).toBe(false);
    expect(parsePrivacyModeMirror('1')).toBe(true);
    expect(privacyModeMirrorValue(true)).toBe('1');
    expect(privacyModeMirrorValue(false)).toBeNull();
  });
});
