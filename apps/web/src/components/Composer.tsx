import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { DEFAULT_SETTINGS } from '@banana-chat/shared';
import type { UserStub } from '@banana-chat/shared';
import { Icon } from './Visual';
import { sessionOutbox } from '../lib/outbox';
import { useUploader } from '../hooks/useUploader';

interface ComposerProps {
  roomId: string;
  workspaceId: string;
  slug: string;
  senderId: string;
  /** room roster for @mention autocomplete (FR-MSG-008, TASK-WEB-006) */
  members?: UserStub[];
}

const STATUS_LABEL: Record<string, string> = {
  creating: 'เตรียมอัปโหลด…',
  uploading: 'กำลังอัปโหลด…',
  processing: 'กำลังประมวลผล…',
};

/** @token immediately before the caret (username charset per FR-MSG-008) */
const MENTION_AT_CARET = /(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9_.]*)$/;

/** TASK-WEB-006 — Enter sends, Shift+Enter newlines, optimistic insert, one draft per room. */
export function Composer({ roomId, workspaceId, slug, senderId, members = [] }: ComposerProps) {
  const [body, setBody] = useState('');
  const submitting = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftKey = `orgchat.draft.${senderId}.${workspaceId}.${roomId}`;
  const maxLength = DEFAULT_SETTINGS['message.max_length'];
  const { staged, addFiles, remove, clear } = useUploader(slug);

  useEffect(() => {
    setBody(window.sessionStorage.getItem(draftKey) ?? '');
    textareaRef.current?.focus();
  }, [draftKey]);

  const sendable = staged.some((s) => s.status === 'ready' || s.status === 'processing')
    && staged.every((s) => s.status !== 'creating' && s.status !== 'uploading' && s.status !== 'error');

  const canSend = body.trim() !== '' || sendable;

  const send = async () => {
    if (submitting.current) return;
    const trimmed = body.trim() === '' ? null : body;
    if (trimmed === null && !sendable) {
      return;
    }
    const attachments = staged.filter(s => s.status === 'ready' || s.status === 'processing').map(s => ({
      local_path: '', attachment_id: s.attachmentId!, kind: s.kind,
      mime_type: 'application/octet-stream', original_name: s.filename, size_bytes: s.size,
    }));
    submitting.current = true;
    setSendError(null);
    try {
      const { outbox, ready } = sessionOutbox();
      await ready;
      await outbox.enqueue({ roomId, workspaceId: slug, body: trimmed, attachments });
      setBody('');
      window.sessionStorage.removeItem(draftKey);
      clear();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : 'Unable to queue message');
    } finally {
      submitting.current = false;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applyMention(mentionMatches[mentionIndex]!);
        return;
      }
      if (event.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  // ---- @mention autocomplete (FR-MSG-008) ----

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null || members.length === 0) {
      return [];
    }
    const q = mentionQuery.toLowerCase();
    return members
      .filter((m) => m.id !== senderId)
      .filter((m) => m.username.toLowerCase().startsWith(q) || m.username.toLowerCase().includes(q) || m.display_name.toLowerCase().includes(q))
      .slice(0, 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery, members, senderId]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionQuery]);

  const applyMention = (user: UserStub) => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const caret = textarea.selectionStart ?? body.length;
    const before = body.slice(0, caret);
    const after = body.slice(caret);
    const match = MENTION_AT_CARET.exec(before);
    if (match === null) return;
    const insertStart = caret - match[1].length; // keep the @, replace the partial username
    const next = `${body.slice(0, insertStart)}${user.username} ${after}`;
    setBody(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      const pos = insertStart + user.username.length + 1;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
    });
  };

  const onBodyChange = (value: string) => {
    setBody(value.slice(0, maxLength));
    window.sessionStorage.setItem(draftKey, value.slice(0, maxLength));
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? value.length;
    const match = MENTION_AT_CARET.exec(value.slice(0, caret));
    setMentionQuery(match !== null ? match[1] : null);
  };

  return (
    <div className="bc-composer relative">
      {sendError && <p role="alert" className="text-sm text-red-600">{sendError}</p>}
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
      <div className="bc-compose-box flex items-end gap-2">
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
          <Icon name="paperclip" />
        </button>
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
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
          <span>Send</span><Icon name="send" size={17} />
        </button>
      </div>
      <div className="bc-compose-hint"><span>Make room for a good conversation.</span><span><kbd>Enter</kbd> to send · <kbd>Shift + Enter</kbd> for a new line</span></div>
      {mentionQuery !== null && mentionMatches.length > 0 && (
        <div
          className="absolute bottom-full left-12 mb-1 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg"
          data-testid="mention-popup"
        >
          {mentionMatches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus/caret
                applyMention(m);
              }}
              className={`block w-full px-3 py-1.5 text-left text-sm ${i === mentionIndex ? 'bg-yellow-100' : 'hover:bg-slate-50'}`}
              data-testid="mention-option"
            >
              <span className="font-medium">@{m.username}</span>
              <span className="ml-2 text-xs text-slate-400">{m.display_name}</span>
            </button>
          ))}
        </div>
      )}
      {body.length > maxLength - 200 && (
        <p className="mt-1 text-right text-xs text-slate-400">{body.length}/{maxLength}</p>
      )}
    </div>
  );
}
