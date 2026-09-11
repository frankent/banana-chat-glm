import { describe, it, expect } from 'vitest';
import { NotificationGate, unreadTitle } from './notification.js';
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
