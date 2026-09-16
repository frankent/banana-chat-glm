import { useCallback, useRef, useState } from 'react';
import type { Attachment, AttachmentKind, AttachmentStatus, UploadTicket } from '@banana-chat/shared';
import { uploadTicket } from '@banana-chat/chat-core';
import { endpoints } from '../lib/api';

/**
 * FR-PCHAT-011/020 — where the ticket/complete/poll calls go.
 *
 * Public Chat uploads use different endpoints on both of its surfaces (the
 * visitor has no session and addresses everything by its 64-hex code; the agent
 * addresses the public-chat room, not a `rooms` row), but the parts that must
 * NOT drift — the extension screen, the mime→kind mapping, the chunked PUT and
 * the processing poll — are the same code. Injecting the three calls keeps one
 * copy of that logic instead of three.
 *
 * DEC-072 — injecting a driver is also what marks an upload as public-chat, and
 * the public-chat surface screens the markup family on top of the shared list.
 * That is the single deliberate difference; see PUBLIC_CHAT_BLOCKED below.
 */
export interface UploadDriver {
  create(input: { kind: 'image' | 'video' | 'file'; filename: string; mime_type: string; size_bytes: number }): Promise<UploadTicket>;
  /**
   * Only `status` is read, because the Public Chat completion endpoints answer
   * `{attachment:{id,status}}` rather than a fully serialised attachment row.
   */
  complete(attachmentId: string, parts?: { part_number: number; etag: string }[]): Promise<{ attachment: { status: AttachmentStatus } }>;
  /** Omitted where no read-back endpoint exists (the visitor tier has none). */
  poll?(attachmentId: string): Promise<{ attachment: { status: AttachmentStatus } }>;
}

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

/**
 * DEC-072 — MIRROR of the server floor `upload.file.blocked_extensions`
 * (SettingsService::DEFAULTS). Re-synced by hand, and by hand is the only
 * option available from here: the server list is a PHP default an admin can
 * override at runtime, there is no endpoint that ships it to the client, and
 * the one place a single shared copy could live for both web and mobile —
 * `packages/chat-core/src/upload.ts` — is outside this change's ownership.
 * Hoisting these two arrays there is the real fix and is filed as such.
 *
 * This is a UX shortcut, NEVER the control: the server re-checks every
 * extension, plus the DECLARED mime at ticket time and the SNIFFED mime at
 * complete time, which is what actually holds. Drifting behind the server list
 * therefore shows a worse error message, not a hole.
 */
const BLOCKED = [
  'html', 'htm', 'shtml', 'shtm', 'hta', 'htc', 'mhtml', 'mht',
  'js', 'mjs', 'cjs', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1',
  'exe', 'bat', 'cmd', 'sh', 'msi', 'scr', 'jar', 'com',
  'lnk', 'scf', 'url', 'reg', 'cpl',
];

/**
 * DEC-072 — the markup family, refused ON THE PUBLIC CHAT SURFACE ONLY, mirror
 * of InlineSafety::PUBLIC_CHAT_BLOCKED_EXTENSIONS.
 *
 * Internal uploads accept these on purpose (FR-MEDIA-004/005 spec SVG sharing;
 * a stored SVG is made inert by the forced `Content-Disposition: attachment` at
 * read time), so this list must not be folded into BLOCKED above.
 */
const PUBLIC_CHAT_BLOCKED = [
  'html', 'htm', 'xhtml', 'xht', 'shtml', 'shtm', 'hta', 'htc',
  'svg', 'svgz', 'xml', 'xsl', 'xslt', 'mhtml', 'mht',
];

/**
 * Server-side (InlineSafety::normalizeExtension) Windows and several object
 * stores strip trailing dots and spaces, so "evil.html " is really evil.html.
 * Normalise the same way here or the client message disagrees with the 422.
 */
function extensionOf(filename: string): string {
  const trimmed = filename.trim().replace(/[.\s]+$/, '');
  const dot = trimmed.lastIndexOf('.');
  return dot === -1 ? '' : trimmed.slice(dot + 1).toLowerCase();
}

/** 'avatar' is absent by construction — it is not a message attachment kind. */
function kindFor(file: File): Exclude<AttachmentKind, 'avatar'> {
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * FR-MEDIA-001 client flow: create ticket → PUT bytes → complete →
 * (poll until ready — the worker is fast; attachment.ready events exist
 * server-side but polling keeps the composer self-contained).
 */
export function useUploader(slug: string, driver?: UploadDriver) {
  const [staged, setStaged] = useState<StagedUpload[]>([]);
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  // held in a ref so an inline driver object does not re-create uploadOne on
  // every render (and so an in-flight upload keeps the driver it started with)
  const driverRef = useRef<UploadDriver | undefined>(driver);
  driverRef.current = driver;

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
      const extension = extensionOf(file.name);
      // DEC-072 — a driver is injected by, and only by, the two Public Chat
      // surfaces (PublicChatVisitorPage / PublicChatRoomPage): they are the
      // pages that cannot use `endpoints.*`. That makes driver-presence the
      // signal for "this upload lands in a public chat ticket", which is the
      // surface where the markup family is refused. Getting this wrong only
      // changes whether the rejection message appears here or comes back as a
      // 422 — the server decides either way.
      const blocked = driverRef.current === undefined
        ? BLOCKED
        : [...BLOCKED, ...PUBLIC_CHAT_BLOCKED];

      if (extension !== '' && blocked.includes(extension)) {
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

      const transport: UploadDriver = driverRef.current ?? {
        create: (input) => endpoints.createUpload(slug, input),
        complete: (attachmentId, parts) => endpoints.completeUpload(attachmentId, slug, parts),
        poll: (attachmentId) => endpoints.attachment(attachmentId, slug),
      };

      try {
        const ticket = await transport.create({
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
        const { attachment } = await transport.complete(ticket.attachment_id, parts);

        if (attachment.status === 'ready') {
          patch(localId, { status: 'ready' });
          return;
        }

        // processing — poll until the worker flips it
        patch(localId, { status: 'processing' });
        const poll = transport.poll;
        if (poll === undefined) {
          // No read-back endpoint on this tier (the visitor has no session, so
          // API-063 is not reachable). The row is already attachable — the
          // transcript re-renders it ready on the next message fetch.
          return;
        }
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const current = stagedRef.current.find((s) => s.localId === localId);
          if (current === undefined) return; // user removed the chip
          const { attachment: fresh } = await poll(ticket.attachment_id);
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
