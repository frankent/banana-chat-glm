import { ApiError } from '@banana-chat/api-client';

/**
 * TASK-MOB-011 — 426 APP_UPDATE_REQUIRED gate (BE-025). Any API call may
 * throw it; the app swaps to a dead-end update screen (TC-MOB-042).
 */
export function isAppUpdateRequired(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 426 || error.code === 'APP_UPDATE_REQUIRED');
}
