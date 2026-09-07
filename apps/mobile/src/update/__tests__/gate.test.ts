import { describe, expect, it } from '@jest/globals';
import { ApiError } from '@banana-chat/api-client';
import { isAppUpdateRequired } from '../gate';

/**
 * TASK-MOB-011 — 426 APP_UPDATE_REQUIRED gate (TC-MOB-042).
 */
describe('update gate', () => {
  it('TC-MOB-042 detects the 426 envelope by status or code', () => {
    expect(isAppUpdateRequired(new ApiError(426, { code: 'APP_UPDATE_REQUIRED', message: 'อัปเดตแอป', request_id: null }))).toBe(true);
    expect(isAppUpdateRequired(new ApiError(200, { code: 'APP_UPDATE_REQUIRED', message: 'x', request_id: null }))).toBe(true);
    expect(isAppUpdateRequired(new ApiError(426, { code: 'OTHER', message: 'x', request_id: null }))).toBe(true);
  });

  it('TC-MOB-042 other errors pass through untouched', () => {
    expect(isAppUpdateRequired(new ApiError(401, { code: 'UNAUTHENTICATED', message: 'x', request_id: null }))).toBe(false);
    expect(isAppUpdateRequired(new Error('plain'))).toBe(false);
    expect(isAppUpdateRequired(null)).toBe(false);
  });
});
