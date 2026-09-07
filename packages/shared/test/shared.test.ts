import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, ERROR_CODES } from '../src/types.js';
import type { Message } from '../src/types.js';

describe('shared constants (§4.4 / §7)', () => {
  it('exposes the spec defaults the UI pre-renders with', () => {
    expect(DEFAULT_SETTINGS['message.max_length']).toBe(4000);
    expect(DEFAULT_SETTINGS['room.group.max_members']).toBe(500);
    expect(DEFAULT_SETTINGS['auth.access_token_ttl_minutes']).toBe(60);
  });

  it('maps error codes to their HTTP statuses', () => {
    expect(ERROR_CODES.RATE_LIMITED).toBe(429);
    expect(ERROR_CODES.ROOM_DM_IMMUTABLE).toBe(422);
    expect(ERROR_CODES.AUTH_TOKEN_EXPIRED).toBe(401);
  });

  it('Message type compiles with the §8.8 shape', () => {
    const message: Message = {
      id: '01J',
      room_id: '01R',
      workspace_id: '01W',
      sender_id: '01U',
      sender: null,
      type: 'text',
      body: 'hi',
      seq: 1,
      client_message_id: null,
      reply_to: null,
      system_event: null,
      edited_at: null,
      edit_count: 0,
      deleted_at: null,
      delete_reason: null,
      created_at: '2026-01-01T00:00:00Z',
      attachments: [],
      mentions: [],
    };
    expect(message.seq).toBe(1);
  });
});
