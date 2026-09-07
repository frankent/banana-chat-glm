import { ApiError, NetworkError, type Endpoints } from '@banana-chat/api-client';
import type { OutboxSendFn } from '@banana-chat/chat-core';

/**
 * TASK-MOB-005 / TASK-MOB-006 — outbox sender: uploads offline-queued
 * attachments from their local paths (TC-MOB-013), then sends the message
 * with the original client_message_id. 4xx fails permanently, network/5xx
 * stay retryable (FR-OFF-002). A local file that vanished from the device
 * fails with a user-facing message (TC-MOB-014).
 */
export interface OutboxSenderDeps {
  endpoints: Pick<Endpoints, 'sendMessage' | 'createUpload' | 'completeUpload'>;
  /** PUT the local file to the presigned URL; returns bytes uploaded */
  uploadFile: (localPath: string, putUrl: string, headers: Record<string, string>) => Promise<number>;
  /** check the local file still exists before uploading (TC-MOB-014) */
  fileExists: (localPath: string) => Promise<boolean>;
}

export const ATTACHMENT_MISSING_ERROR = 'ไฟล์แนบหายจากเครื่อง ไม่สามารถส่งได้';

export function createOutboxSender(deps: OutboxSenderDeps): OutboxSendFn {
  return async (entry) => {
    try {
      const attachmentIds: string[] = [];
      for (const draft of entry.attachments) {
        if (!(await deps.fileExists(draft.local_path))) {
          return { ok: false, retryable: false, error: ATTACHMENT_MISSING_ERROR };
        }
        const ticket = await deps.endpoints.createUpload(entry.workspace_id, {
          kind: draft.kind,
          filename: draft.original_name,
          mime_type: draft.mime_type,
          size_bytes: draft.size_bytes,
        });
        await deps.uploadFile(draft.local_path, ticket.put_url, ticket.headers);
        await deps.endpoints.completeUpload(ticket.attachment_id, entry.workspace_id);
        attachmentIds.push(ticket.attachment_id);
      }

      const res = await deps.endpoints.sendMessage(
        entry.room_id,
        entry.workspace_id,
        entry.body,
        entry.client_message_id,
        undefined,
        attachmentIds,
      );
      return { ok: true, message: res.message };
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        return { ok: false, retryable: false, error: e.message };
      }
      const message = e instanceof NetworkError || e instanceof Error ? e.message : 'network error';
      return { ok: false, retryable: true, error: message };
    }
  };
}
