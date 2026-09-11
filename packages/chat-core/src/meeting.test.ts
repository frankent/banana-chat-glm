import { expect, test } from 'vitest';
import { meetingGuestName, meetingReturnPath } from './meeting.js';
test('TC-MEET-003 guest name trims Unicode and rejects empty or oversized names', () => {
  expect(meetingGuestName('  ผู้ร่วมประชุม  ')).toBe('ผู้ร่วมประชุม');
  expect(meetingGuestName('   ')).toBeNull();
  expect(meetingGuestName('a'.repeat(81))).toBeNull();
  expect(meetingGuestName('🙂'.repeat(80))).not.toBeNull();
});
test('TC-MEET-010 login return allows only public meeting paths', () => {
  expect(meetingReturnPath('/meet/' + 'a'.repeat(64))).not.toBeNull();
  for (const p of ['//evil.test','https://evil.test','/admin','/meet/abc',null]) expect(meetingReturnPath(p)).toBeNull();
});
