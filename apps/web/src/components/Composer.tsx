import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { DEFAULT_SETTINGS } from '@banana-chat/shared';
import { useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { roomStore } from '../lib/room-stores';
import { optimisticMessage } from '../hooks/useMessages';

interface ComposerProps {
  roomId: string;
  workspaceId: string;
  slug: string;
  senderId: string;
}

/** TASK-WEB-006 — Enter sends, Shift+Enter newlines, optimistic insert, one draft per room. */
export function Composer({ roomId, workspaceId, slug, senderId }: ComposerProps) {
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  const draftKey = `orgchat.draft.${roomId}`;
  const maxLength = DEFAULT_SETTINGS['message.max_length'];

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

  const send = async () => {
    const trimmed = body.trim();
    if (trimmed === '') {
      return;
    }
    const clientMessageId = crypto.randomUUID();
    const store = roomStore(roomId);
    store.add(optimisticMessage(roomId, workspaceId, senderId, trimmed, clientMessageId, store.newestSeq + 1));
    setBody('');

    try {
      const { message } = await endpoints.sendMessage(roomId, slug, trimmed, clientMessageId);
      store.confirmClientMessage(clientMessageId, message);
      void endpoints.markRead(roomId, slug, message.seq).then(() => {
        void queryClient.invalidateQueries({ queryKey: ['rooms', slug] });
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      });
    } catch {
      // leave the optimistic bubble; a page reload resyncs from the server
      setBody(trimmed);
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
      <div className="flex items-end gap-2">
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
          disabled={body.trim() === ''}
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
