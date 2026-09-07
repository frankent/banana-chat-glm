import { useEffect, useMemo, useRef, useState } from 'react';
import { useAiStore } from '../../state/ai';
import { AiConsentDialog } from './AiConsentDialog';

/**
 * FR-AI-003/004/018 — streaming chat pane. Deltas render through the shared
 * AiStreamStore (index-ordered, gap → resync); the composer blocks until
 * consent (FR-AI-007) and shows quota/errors from §7 codes.
 */

/** minimal safe rendering: React escapes everything; fences become <pre> */
function renderAssistant(content: string): Array<{ kind: 'text' | 'code'; value: string }> {
  const parts: Array<{ kind: 'text' | 'code'; value: string }> = [];
  const regex = /```(?:\w*\n)?([\s\S]*?)(?:```|$)/g;
  let at = 0;
  for (const match of content.matchAll(regex)) {
    const start = match.index ?? 0;
    if (start > at) {
      parts.push({ kind: 'text', value: content.slice(at, start) });
    }
    parts.push({ kind: 'code', value: match[1].replace(/\n$/, '') });
    at = start + match[0].length;
  }
  if (at < content.length) {
    parts.push({ kind: 'text', value: content.slice(at) });
  }
  return parts;
}

export function AiChatPane({ conversationId, slug }: { conversationId: string; slug: string }) {
  const { messages, hasMoreBefore, loadOlder, send, cancel, retry, status, streamTick, consentOpen, giveConsent } =
    useAiStore();
  const list = messages[conversationId] ?? [];
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [list.length, streamTick]);

  const liveStream = useMemo(() => {
    const generating = [...list].reverse().find((m) => m.status === 'pending' || m.status === 'streaming');
    return generating ?? null;
  }, [list, streamTick]);

  const maxChars = status?.limits.max_message_chars ?? 4000;
  const canSend = draft.trim() !== '' && liveStream === null;

  const onSubmit = async (): Promise<void> => {
    const content = draft.trim();
    if (content === '') {
      return;
    }
    setDraft('');
    setError(null);
    try {
      await send(conversationId, slug, content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ส่งข้อความไม่สำเร็จ');
      setDraft(content);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-100">
      {consentOpen ? <AiConsentDialog onAccept={() => void giveConsent(slug)} /> : null}

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {hasMoreBefore[conversationId] ? (
          <button
            onClick={() => void loadOlder(conversationId, slug)}
            className="mx-auto mb-2 block rounded border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500 hover:bg-slate-50"
          >
            โหลดข้อความก่อนหน้า
          </button>
        ) : null}

        {list.map((m) => {
          if (m.role === 'user') {
            return (
              <div key={m.id} className="mb-2 flex justify-end">
                <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-amber-400 px-3 py-2 text-sm text-slate-900">
                  {m.content}
                </div>
              </div>
            );
          }
          if (m.status === 'failed') {
            return (
              <div key={m.id} className="mb-2 flex flex-col items-start gap-1">
                <div className="max-w-[75%] rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                  ไม่สำเร็จ ({m.error_code ?? 'ERROR'}) — ลองใหม่ได้
                </div>
                {m.id === list[list.length - 1]?.id ? (
                  <button
                    onClick={() => {
                      const lastUser = [...list].reverse().find((u) => u.role === 'user');
                      if (lastUser?.content !== null && lastUser?.content !== undefined) {
                        void retry(conversationId, slug, lastUser.content);
                      }
                    }}
                    className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                  >
                    ↻ ลองอีกครั้ง
                  </button>
                ) : null}
              </div>
            );
          }
          if (m.status === 'pending' || m.status === 'streaming') {
            const streamed = useAiStore.getState().activeStreamText(m.id);
            return (
              <div key={m.id} className="mb-2 flex flex-col items-start gap-1">
                <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm text-slate-800 shadow-sm">
                  {streamed !== null && streamed !== '' ? streamed : <span className="animate-pulse">กำลังพิมพ์…</span>}
                  <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-amber-400 align-middle" />
                </div>
                <button
                  onClick={() => void cancel(m.id, slug)}
                  className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
                >
                  ■ หยุด
                </button>
              </div>
            );
          }
          return (
            <div key={m.id} className="mb-2 flex justify-start">
              <div className="max-w-[75%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm text-slate-800 shadow-sm">
                {renderAssistant(m.content ?? '').map((part, i) =>
                  part.kind === 'code' ? (
                    <pre key={i} className="my-1 overflow-x-auto rounded bg-slate-800 p-2 text-xs text-slate-100">
                      <code>{part.value}</code>
                    </pre>
                  ) : (
                    <p key={i} className="whitespace-pre-wrap">
                      {part.value}
                    </p>
                  ),
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error !== null ? <p className="px-4 pb-1 text-xs text-red-500">{error}</p> : null}

      <div className="border-t border-slate-200 bg-white p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, maxChars))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSubmit();
              }
            }}
            rows={2}
            disabled={status !== null && !status.consented}
            placeholder={status !== null && !status.consented ? 'ต้องให้ความยินยอมก่อนใช้ AI' : 'ถามอะไรก็ได้… (Enter ส่ง, Shift+Enter บรรทัดใหม่)'}
            className="min-h-[44px] flex-1 resize-y rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none disabled:bg-slate-50"
          />
          {liveStream === null ? (
            <button
              onClick={() => void onSubmit()}
              disabled={!canSend}
              className="rounded-lg bg-amber-400 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-40"
            >
              ส่ง
            </button>
          ) : (
            <button
              onClick={() => liveStream !== null && void cancel(liveStream.id, slug)}
              className="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-500 hover:bg-red-50"
            >
              หยุด
            </button>
          )}
        </div>
        <p className="mt-1 text-right text-[10px] text-slate-400">
          {draft.length}/{maxChars}
          {status !== null ? ` · วันนี้ใช้ ${status.usage_today.messages}/${status.limits.daily_messages} ข้อความ` : ''}
        </p>
      </div>
    </div>
  );
}
