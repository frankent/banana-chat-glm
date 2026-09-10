import { useCallback, useRef, useState } from 'react';
import type { Attachment, AttachmentKind } from '@banana-chat/shared';
import { uploadTicket } from '@banana-chat/chat-core';
import { endpoints } from '../lib/api';

export interface StagedUpload {
  localId: string;
  filename: string;
  kind: AttachmentKind;
  size: number;
  previewUrl: string | null;
  status: 'creating' | 'uploading' | 'processing' | 'ready' | 'error';
  attachmentId: string | null;
  error: string | null;
}

const BLOCKED = ['exe', 'bat', 'cmd', 'sh', 'ps1', 'msi', 'scr', 'js', 'jar', 'com', 'vbs'];

function kindFor(file: File): AttachmentKind {
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * FR-MEDIA-001 client flow: create ticket → PUT bytes → complete →
 * (poll until ready — the worker is fast; attachment.ready events exist
 * server-side but polling keeps the composer self-contained).
 */
export function useUploader(slug: string) {
  const [staged, setStaged] = useState<StagedUpload[]>([]);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;

  const patch = useCallback((localId: string, changes: Partial<StagedUpload>) => {
    setStaged((current) => current.map((s) => (s.localId === localId ? { ...s, ...changes } : s)));
  }, []);

  const remove = useCallback((localId: string) => {
    setStaged((current) => current.filter((s) => s.localId !== localId));
  }, []);

  const clear = useCallback(() => {
    // NB: preview URLs are NOT revoked here — the optimistic message still
    // renders them until the server row confirms; they die with the document
    setStaged([]);
  }, []);

  const uploadOne = useCallback(
    async (file: File) => {
      const localId = crypto.randomUUID();
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (BLOCKED.includes(extension)) {
        setStaged((current) => [
          ...current,
          { localId, filename: file.name, kind: 'file', size: file.size, previewUrl: null, status: 'error', attachmentId: null, error: 'ประเภทไฟล์นี้ถูกห้าม' },
        ]);
        return;
      }

      const kind = kindFor(file);
      setStaged((current) => [
        ...current,
        {
          localId,
          filename: file.name,
          kind,
          size: file.size,
          previewUrl: kind === 'image' ? URL.createObjectURL(file) : null,
          status: 'creating',
          attachmentId: null,
          error: null,
        },
      ]);

      try {
        const ticket = await endpoints.createUpload(slug, {
          kind,
          filename: file.name,
          mime_type: file.type === '' ? 'application/octet-stream' : file.type,
          size_bytes: file.size,
        });

        patch(localId, { status: 'uploading', attachmentId: ticket.attachment_id });

        const parts = await uploadTicket(ticket, file.size, async (url, headers, start, end) => {
          const response = await fetch(url, { method: 'PUT', headers, body: file.slice(start, end) });
          if (!response.ok) throw new Error(`upload failed (${response.status})`);
          return response.headers.get('ETag');
        });
        const { attachment } = await endpoints.completeUpload(ticket.attachment_id, slug, parts);

        if (attachment.status === 'ready') {
          patch(localId, { status: 'ready' });
          return;
        }

        // processing — poll until the worker flips it
        patch(localId, { status: 'processing' });
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const current = stagedRef.current.find((s) => s.localId === localId);
          if (current === undefined) return; // user removed the chip
          const { attachment: fresh } = await endpoints.attachment(ticket.attachment_id, slug);
          if (fresh.status === 'ready') {
            patch(localId, { status: 'ready' });
            return;
          }
          if (fresh.status === 'failed') {
            patch(localId, { status: 'error', error: 'ประมวลผลไฟล์ไม่สำเร็จ' });
            return;
          }
        }
        // still processing after ~15s — ready-enough to send (spinner keeps showing)
        patch(localId, { status: 'processing' });
      } catch (err) {
        patch(localId, { status: 'error', error: err instanceof Error ? err.message : 'อัปโหลดไม่สำเร็จ' });
      }
    },
    [slug, patch],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        void uploadOne(file);
      }
    },
    [uploadOne],
  );

  return { staged, addFiles, remove, clear };
}

/**
 * Optimistic attachment for the composer preview — local blob URL until the
 * server row replaces it on confirm.
 */
export function optimisticAttachment(staged: StagedUpload): Attachment {
  return {
    id: staged.attachmentId ?? staged.localId,
    kind: staged.kind,
    status: staged.status === 'ready' ? 'ready' : 'processing',
    original_name: staged.filename,
    mime_type: staged.kind === 'image' ? 'image/*' : 'application/octet-stream',
    size_bytes: staged.size,
    width: null,
    height: null,
    duration_ms: null,
    urls: {
      original: staged.previewUrl,
      thumb_sm: staged.previewUrl,
      thumb_md: staged.previewUrl,
      poster: null,
    },
    urls_expire_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}
