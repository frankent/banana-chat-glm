import { describe, it, expect } from 'vitest';
import { NotificationGate, unreadTitle, DesktopNotificationGate, desktopNotificationBody } from './notification.js';
describe('TC-NOTI-025 browser attention', () => {
  it('deduplicates events, suppresses focused room and disabled sound', () => {
    const gate = new NotificationGate();
    expect(gate.accept('a', true, false, 10000)).toBe(true);
    expect(gate.accept('a', true, false, 12000)).toBe(false);
    expect(gate.accept('b', false, false, 14000)).toBe(false);
    expect(gate.accept('c', true, true, 16000)).toBe(false);
    expect(gate.accept('d', true, false, 18000)).toBe(true);
    expect(gate.accept('e', true, false, 18001)).toBe(false);
  });
  it('TC-READ-013 sums workspace unread and clears at zero', () => {
    expect(unreadTitle([{total_unread:3},{total_unread:4}])).toBe('(7) Banana Chat');
    expect(unreadTitle([])).toBe('Banana Chat');
  });
});

describe('DesktopNotificationGate (FR-NOTI-003)', () => {
  it('admits an id once and never again', () => {
    const gate = new DesktopNotificationGate();
    expect(gate.accept('a')).toBe(true);
    expect(gate.accept('a')).toBe(false);
    expect(gate.accept('b')).toBe(true);
  });

  // The whole reason this is not NotificationGate: that one throttles to one
  // accept per second, which would silently swallow a burst of popups.
  it('does NOT rate limit — a burst in the same instant all shows', () => {
    const gate = new DesktopNotificationGate();
    const admitted = ['n1', 'n2', 'n3', 'n4'].filter((id) => gate.accept(id));
    expect(admitted).toEqual(['n1', 'n2', 'n3', 'n4']);

    // contrast: the audio gate drops everything after the first within a second
    const audio = new NotificationGate();
    const now = 1_000;
    const played = ['n1', 'n2', 'n3', 'n4'].filter((id) => audio.accept(id, true, false, now));
    expect(played).toEqual(['n1']);
  });

  it('evicts oldest ids past the limit so a long-lived tab cannot grow forever', () => {
    const gate = new DesktopNotificationGate(2);
    gate.accept('a');
    gate.accept('b');
    gate.accept('c'); // evicts 'a'
    expect(gate.accept('a')).toBe(true); // 'a' forgotten, admitted again
    expect(gate.accept('c')).toBe(false); // 'c' still remembered
  });
});

describe('desktopNotificationBody', () => {
  it('maps each alert kind, never leaking message content', () => {
    expect(desktopNotificationBody('mention')).toBe('มีคนกล่าวถึงคุณ');
    expect(desktopNotificationBody('call')).toBe('สายเรียกเข้า');
    expect(desktopNotificationBody('message')).toBe('ข้อความใหม่');
    // unknown kinds fall back rather than rendering the raw kind string
    expect(desktopNotificationBody('something_new')).toBe('ข้อความใหม่');
  });
});
