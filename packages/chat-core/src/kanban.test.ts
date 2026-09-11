import {it,expect} from 'vitest';
import {ticketKey, deadlineState} from './kanban.js';
it('TC-KAN-006 ticket identifiers and deadline completion',()=>{
 expect(ticketKey('acme',42)).toBe('ACME-42');
 expect(deadlineState('2026-09-11T10:00:00Z',false,Date.parse('2026-09-11T10:01:00Z'))).toBe('overdue');
 expect(deadlineState('2026-09-11T10:00:00Z',true,Date.parse('2026-09-11T10:01:00Z'))).toBe('done');
 expect(deadlineState(null,false,0)).toBe('none');
});
