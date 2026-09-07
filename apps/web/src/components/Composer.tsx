import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { DEFAULT_SETTINGS } from '@banana-chat/shared';
import { useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { roomStore } from '../lib/room-stores';
import { optimisticMessage } from '../hooks/useMessages';
import { optimisticAttachment, useUploader } from '../hooks/useUploader';

interface ComposerProps {
  roomId: string;
  workspaceId: string;
  slug: string;
  senderId: string;
}

const STATUS_LABEL: Record<string, string> = {
  creating: 'เตรียมอัปโหลด…',
  uploading: 'กำลังอัปโหลด…',
  processing: 'กำลังประมวลผล…',
};

/** TASK-WEB-006 — Enter sends, Shift+Enter newlines, optimistic insert, one draft per room. */
export function Composer({ roomId, workspaceId, slug, senderId }: ComposerProps) {
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const draftKey = `orgchat.draft.${roomId}`;
  const maxLength = DEFAULT_SETTINGS['message.max_length'];
  const { staged, addFiles, remove, clear } = useUploader(slug);

  useEffect(() => {
    setBody(window.sessionStorage.getItem(draftKey) ?? '');
    textareaRef.current?.focus();
    return () => {
      const current = textareaRef.current?.value ?? '';
      if (current.trim() !== '') {
        window.sessionStorage.setItem(draftKey, current);
      } else {
        window.sessionStorage.removeItem(draftKey);
      }
    };
  }, [draftKey]);

  const sendable = staged.some((s) => s.status === 'ready' || s.status === 'processing')
    && staged.every((s) => s.status !== 'creating' && s.status !== 'uploading' && s.status !== 'error');

  const canSend = body.trim() !== '' || sendable;

  const send = async () => {
    const trimmed = body.trim() === '' ? null : body;
    if (trimmed === null && !sendable) {
      return;
    }
    const attachments = staged
      .filter((s) => s.status === 'ready' || s.status === 'processing')
      .map((s) => optimisticAttachment(s));
    const attachmentIds = staged
      .filter((s) => s.status === 'ready' || s.status === 'processing')
      .map((s) => s.attachmentId)
      .filter((id): id is string => id !== null);

    const clientMessageId = crypto.randomUUID();
    const store = roomStore(roomId);
    store.add(optimisticMessage(roomId, workspaceId, senderId, trimmed, clientMessageId, store.newestSeq + 1, attachments));
    setBody('');
    clear();

    try {
      const { message } = await endpoints.sendMessage(roomId, slug, trimmed, clientMessageId, undefined, attachmentIds);
      store.confirmClientMessage(clientMessageId, message);
      void endpoints.markRead(roomId, slug, message.seq).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      });
    } catch {
      // leave the optimistic bubble; a page reload resyncs from the server
      setBody(trimmed ?? '');
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="border-t border-slate-200 bg-white p-3">
      {staged.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2" data-testid="composer-attachments">
          {staged.map((s) => (
            <div
              key={s.localId}
              data-testid="composer-attachment"
              data-status={s.status}
              className="relative flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
            >
              {s.previewUrl !== null ? (
                <img src={s.previewUrl} alt={s.filename} className="h-10 w-10 rounded object-cover" />
              ) : (
                <span className="text-lg">{s.kind === 'video' ? '🎬' : '📎'}</span>
              )}
              <span className="max-w-40 truncate">
                {s.filename}
                <span className="block text-[10px] text-slate-400">
                  {s.status === 'error' ? s.error : s.status === 'ready' ? 'พร้อมส่ง' : STATUS_LABEL[s.status]}
                </span>
              </span>
              <button
                onClick={() => remove(s.localId)}
                aria-label={`remove ${s.filename}`}
                className="ml-1 rounded-full px-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files !== null) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          aria-label="attach files"
          data-testid="attach-button"
          className="rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          📎
        </button>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, maxLength))}
          onKeyDown={onKeyDown}
          data-testid="composer-input"
          rows={Math.min(5, body.split('\n').length)}
          placeholder="Message… (Enter to send, Shift+Enter for newline)"
          className="flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-yellow-400 focus:outline-none"
        />
        <button
          onClick={() => void send()}
          disabled={!canSend}
          data-testid="send-button"
          className="rounded-xl bg-yellow-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-yellow-300 disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {body.length > maxLength - 200 && (
        <p className="mt-1 text-right text-xs text-slate-400">{body.length}/{maxLength}</p>
      )}
    </div>
  );
}
