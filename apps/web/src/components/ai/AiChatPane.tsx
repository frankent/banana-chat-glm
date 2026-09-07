import { useEffect, useMemo, useRef, useState } from 'react';
import { useAiStore } from '../../state/ai';
import { AiConsentDialog } from './AiConsentDialog';
import { AiShareDialog } from './AiShareDialog';
import { Markdown } from './Markdown';

/**
 * FR-AI-003/004/018 — streaming chat pane. Deltas render through the shared
 * AiStreamStore (index-ordered, gap → resync); the composer blocks until
 * consent (FR-AI-007) and shows quota/errors from §7 codes.
 *
 * FR-AI-009 (WEB-024) — ↻ regenerate + ✎ edit-resend on the latest pair,
 * superseded answers kept behind a "1/2" version switcher;
 * FR-AI-015 — 📤 share an answer into a room.
 */

export function AiChatPane({ conversationId, slug }: { conversationId: string; slug: string }) {
  const {
    messages, hasMoreBefore, loadOlder, send, cancel, retry, status, streamTick, consentOpen, giveConsent,
    regenerate, editResend, toggleSuperseded, supersededVisible,
  } = useAiStore();
  const list = messages[conversationId] ?? [];
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [shareId, setShareId] = useState<string | null>(null);
  /** FR-AI-009 — selected version per answer group (parent_message_id keyed) */
  const versionPick = useRef<Record<string, number>>({});
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

  const liveList = useMemo(() => list.filter((m) => m.superseded_at == null), [list]);
  const lastLiveUser = useMemo(() => [...liveList].reverse().find((m) => m.role === 'user') ?? null, [liveList]);
  const lastLiveAnswer = useMemo(
    () => [...liveList].reverse().find((m) => m.role === 'assistant' && m.status === 'completed') ?? null,
    [liveList],
  );
  const hasVersions = list.some((m) => m.superseded_at != null);

  /** FR-AI-009 — all versions of one answer, seq-ordered (superseded first) */
  const versionsOf = (messageId: string): typeof list => {
    const own = list.find((m) => m.id === messageId);
    if (own === undefined) {
      return [];
    }
    const key = own.parent_message_id ?? own.id;
    return list.filter((m) => m.role === 'assistant' && (m.parent_message_id ?? m.id) === key).sort((a, b) => a.seq - b.seq);
  };
  const selectedVersionIndex = (versions: typeof list): number => {
    const live = versions.find((v) => v.superseded_at == null) ?? versions[versions.length - 1];
    return Math.max(0, versions.findIndex((v) => v.id === live?.id));
  };

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

  const onRegenerate = async (messageId: string): Promise<void> => {
    setError(null);
    try {
      await regenerate(conversationId, messageId, slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'สร้างใหม่ไม่สำเร็จ');
    }
  };

  const onEditSave = async (): Promise<void> => {
    if (editingId === null) {
      return;
    }
    const content = editDraft.trim();
    if (content === '') {
      return;
    }
    setError(null);
    const id = editingId;
    setEditingId(null);
    try {
      await editResend(conversationId, id, slug, content);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'แก้ไขไม่สำเร็จ');
      setEditingId(id);
      setEditDraft(content);
    }
  };

  const flashNote = (text: string): void => {
    setNote(text);
    window.setTimeout(() => setNote(null), 4000);
  };

  const showSuperseded = supersededVisible[conversationId] ?? false;

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-100">
      {consentOpen ? <AiConsentDialog onAccept={() => void giveConsent(slug)} /> : null}
      {shareId !== null ? (
        <AiShareDialog
          messageId={shareId}
          slug={slug}
          onClose={() => setShareId(null)}
          onShared={(roomName) => {
            setShareId(null);
            flashNote(`ส่งคำตอบไป "${roomName}" แล้ว`);
          }}
        />
      ) : null}

      {hasVersions || showSuperseded ? (
        <div className="flex items-center justify-end border-b border-slate-200 bg-white px-3 py-1">
          <button
            onClick={() => void toggleSuperseded(conversationId, slug)}
            className="text-[11px] text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
          >
            {showSuperseded ? 'ซ่อนคำตอบเวอร์ชันเก่า' : 'แสดงคำตอบเวอร์ชันเก่า (1/2)'}
          </button>
        </div>
      ) : null}

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
            const editable = m.id === lastLiveUser?.id && liveStream === null;
            if (m.id === editingId) {
              return (
                <div key={m.id} className="mb-2 flex flex-col items-end gap-1">
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value.slice(0, maxChars))}
                    rows={3}
                    className="w-[75%] resize-y rounded-lg border border-amber-300 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => setEditingId(null)} className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                      ยกเลิก
                    </button>
                    <button
                      onClick={() => void onEditSave()}
                      disabled={editDraft.trim() === ''}
                      className="rounded bg-amber-400 px-2 py-1 text-xs font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-40"
                    >
                      บันทึกและส่งใหม่
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400">{editDraft.length}/{maxChars} · ข้อความหลังจากนี้จะถูกแทนที่</p>
                </div>
              );
            }
            return (
              <div key={m.id} className="group mb-2 flex flex-col items-end">
                <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-amber-400 px-3 py-2 text-sm text-slate-900">
                  {m.content}
                </div>
                {editable ? (
                  <button
                    onClick={() => {
                      setEditingId(m.id);
                      setEditDraft(m.content ?? '');
                    }}
                    className="mt-0.5 text-[10px] text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  >
                    ✎ แก้ไขและส่งใหม่
                  </button>
                ) : null}
              </div>
            );
          }

          // ---- assistant answers (version groups, FR-AI-009 "1/2") ----
          const versions = versionsOf(m.id);
          if (!versions.some((v) => v.id === m.id)) {
            return null;
          }
          const groupKey = m.parent_message_id ?? m.id;
          const pick = versionPick.current[groupKey];
          const selectedIdx = pick ?? selectedVersionIndex(versions);
          if (m.id !== versions[selectedIdx]?.id) {
            return null; // only the selected version renders
          }
          const switcher =
            versions.length > 1 ? (
              <div className="mb-1 flex items-center gap-1 text-[10px] text-slate-400">
                <button
                  onClick={() => {
                    versionPick.current[groupKey] = Math.max(0, selectedIdx - 1);
                    useAiStore.setState((st) => ({ streamTick: st.streamTick + 1 }));
                  }}
                  disabled={selectedIdx === 0}
                  className="rounded border border-slate-200 bg-white px-1 disabled:opacity-30"
                  aria-label="ดูเวอร์ชันก่อนหน้า"
                >
                  ◀
                </button>
                <span>
                  {selectedIdx + 1}/{versions.length}
                </span>
                <button
                  onClick={() => {
                    versionPick.current[groupKey] = Math.min(versions.length - 1, selectedIdx + 1);
                    useAiStore.setState((st) => ({ streamTick: st.streamTick + 1 }));
                  }}
                  disabled={selectedIdx === versions.length - 1}
                  className="rounded border border-slate-200 bg-white px-1 disabled:opacity-30"
                  aria-label="ดูเวอร์ชันถัดไป"
                >
                  ▶
                </button>
              </div>
            ) : null;

          if (m.status === 'failed') {
            return (
              <div key={m.id} className="mb-2 flex flex-col items-start gap-1">
                {switcher}
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
          const retired = m.superseded_at != null;
          const isLastAnswer = m.id === lastLiveAnswer?.id;
          return (
            <div key={m.id} className="group mb-2 flex flex-col items-start">
              {switcher}
              <div className={`max-w-[75%] rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm text-slate-800 shadow-sm ${retired ? 'opacity-50' : ''}`}>
                <Markdown content={m.content ?? ''} />
              </div>
              {isLastAnswer && liveStream === null ? (
                <div className="mt-0.5 flex gap-2 text-[10px] text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    onClick={() => void onRegenerate(m.id)}
                    className="rounded border border-slate-200 bg-white px-2 py-0.5 hover:text-slate-700"
                    aria-label="สร้างคำตอบใหม่"
                  >
                    ↻ สร้างใหม่
                  </button>
                  <button
                    onClick={() => setShareId(m.id)}
                    className="rounded border border-slate-200 bg-white px-2 py-0.5 hover:text-slate-700"
                    aria-label="ส่งคำตอบนี้ไปห้อง"
                  >
                    📤 ส่งไปห้อง…
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error !== null ? <p className="px-4 pb-1 text-xs text-red-500">{error}</p> : null}
      {note !== null ? <p className="px-4 pb-1 text-xs text-emerald-600">{note}</p> : null}

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
