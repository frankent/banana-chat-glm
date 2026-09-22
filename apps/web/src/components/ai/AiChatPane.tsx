import { useEffect, useMemo, useRef, useState } from 'react';
import { useAiStore } from '../../state/ai';
import { useChatText } from '../../lib/use-chat-text';
import { AiConsentDialog } from './AiConsentDialog';
import { AiShareDialog } from './AiShareDialog';
import { Markdown } from './Markdown';
import { Icon } from '../Visual';
import { AiStepSummary, AiStepTrail } from './AiStepTrail';

/**
 * FR-AI-003/004/018 — streaming chat pane. Deltas render through the shared
 * AiStreamStore (index-ordered, gap → resync); the composer blocks until
 * consent (FR-AI-007) and shows quota/errors from §7 codes.
 *
 * FR-AI-009 (WEB-024) — ↻ regenerate + ✎ edit-resend on the latest pair,
 * superseded answers kept behind a "1/2" version switcher;
 * FR-AI-015 — 📤 share an answer into a room.
 *
 * DEC-078 — reuses the chat shell's bubble/composer classes (bc-message,
 * bc-message-bubble, bc-composer…) rather than MessageItem, whose edit/
 * delete/reply/pin action model doesn't fit AI's edit-resend/regenerate/
 * version-switch/share model. Composer controls use distinct testids
 * (ai-composer-input/ai-send-button) from the room composer.
 */

export function AiChatPane({ conversationId, slug }: { conversationId: string; slug: string }) {
  const { text } = useChatText();
  const {
    messages, hasMoreBefore, loadOlder, send, cancel, retry, status, streamTick, consentOpen, giveConsent,
    regenerate, editResend, toggleSuperseded, supersededVisible, sending,
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
      setError(e instanceof Error ? e.message : text('ai.sendFailed'));
      setDraft(content);
    }
  };

  const onRegenerate = async (messageId: string): Promise<void> => {
    setError(null);
    try {
      await regenerate(conversationId, messageId, slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : text('ai.regenerateFailed'));
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
      setError(e instanceof Error ? e.message : text('ai.editFailed'));
      setEditingId(id);
      setEditDraft(content);
    }
  };

  const flashNote = (message: string): void => {
    setNote(message);
    window.setTimeout(() => setNote(null), 4000);
  };

  const showSuperseded = supersededVisible[conversationId] ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {consentOpen ? <AiConsentDialog onAccept={() => void giveConsent(slug)} /> : null}
      {shareId !== null ? (
        <AiShareDialog
          messageId={shareId}
          slug={slug}
          onClose={() => setShareId(null)}
          onShared={(roomName) => {
            setShareId(null);
            flashNote(text('ai.sharedNote').replace('{room}', roomName));
          }}
        />
      ) : null}

      {hasVersions || showSuperseded ? (
        <div className="bc-chat-pins" style={{ padding: '0 24px' }}>
          <button
            onClick={() => void toggleSuperseded(conversationId, slug)}
            style={{ minHeight: 36, fontSize: 12, color: 'var(--chat-muted)', background: 'transparent', border: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}
          >
            {showSuperseded ? text('ai.hideOldVersions') : text('ai.showOldVersions')}
          </button>
        </div>
      ) : null}

      <div className="bc-timeline-frame">
        <div className="bc-message-list" data-testid="ai-message-list">
          <div className="bc-timeline-content">
            {hasMoreBefore[conversationId] ? (
              <div className="bc-history-loader">
                <button onClick={() => void loadOlder(conversationId, slug)}>{text('chat.older')}</button>
              </div>
            ) : null}

            {list.map((m) => {
              if (m.role === 'user') {
                const editable = m.id === lastLiveUser?.id && liveStream === null;
                if (m.id === editingId) {
                  return (
                    <div key={m.id} className="bc-message flex justify-end" data-mine="true">
                      <div className="bc-message-bubble" style={{ width: '75%', maxWidth: 'none' }}>
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value.slice(0, maxChars))}
                          rows={3}
                          className="w-full resize-y rounded-lg border border-amber-300 px-2 py-1 text-sm focus:border-amber-400 focus:outline-none"
                        />
                        <div className="mt-1 flex justify-end gap-2 text-xs">
                          <button onClick={() => setEditingId(null)} className="rounded border border-slate-200 bg-white px-2 py-1 text-slate-600 hover:bg-slate-50">
                            {text('chat.cancel')}
                          </button>
                          <button
                            onClick={() => void onEditSave()}
                            disabled={editDraft.trim() === ''}
                            className="rounded bg-amber-400 px-2 py-1 font-semibold text-slate-900 hover:bg-amber-300 disabled:opacity-40"
                          >
                            {text('ai.editResend')}
                          </button>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-400">{editDraft.length}/{maxChars} · {text('ai.editHintSuffix')}</p>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={m.id} className="bc-message group flex justify-end" data-mine="true">
                    <div className="bc-message-bubble">
                      <div className="bc-markdown"><p className="whitespace-pre-wrap">{m.content}</p></div>
                      {editable ? (
                        <button
                          onClick={() => {
                            setEditingId(m.id);
                            setEditDraft(m.content ?? '');
                          }}
                          className="mt-1 text-[10px] text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                        >
                          ✎ {text('ai.editResend')}
                        </button>
                      ) : null}
                    </div>
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
                      aria-label={text('ai.versionPrev')}
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
                      aria-label={text('ai.versionNext')}
                    >
                      ▶
                    </button>
                  </div>
                ) : null;

              if (m.status === 'failed') {
                return (
                  <div key={m.id} className="bc-message flex flex-col items-start gap-1" data-mine="false">
                    {switcher}
                    <div className="bc-message-bubble" style={{ borderColor: '#f3c6c1', background: '#fdf1ef', color: '#a13e32' }}>
                      {text('ai.answerFailed').replace('{code}', m.error_code ?? 'ERROR')}
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
                        ↻ {text('ai.retry')}
                      </button>
                    ) : null}
                  </div>
                );
              }
              if (m.status === 'pending' || m.status === 'streaming') {
                const streamed = useAiStore.getState().activeStreamText(m.id);
                const steps = useAiStore.getState().activeStreamSteps(m.id);
                return (
                  <div key={m.id} className="bc-message flex flex-col items-start gap-1" data-mine="false">
                    <div className="bc-message-bubble">
                      <div className="bc-markdown">
                        {streamed !== null && streamed !== '' ? (
                          <AiStepTrail text={streamed} steps={steps} />
                        ) : steps.length > 0 ? (
                          <AiStepTrail text="" steps={steps} />
                        ) : (
                          <span className="animate-pulse">{text('ai.typing')}</span>
                        )}
                        <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-amber-400 align-middle" />
                      </div>
                    </div>
                    <button
                      onClick={() => void cancel(m.id, slug)}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-500 hover:bg-slate-50"
                    >
                      ■ {text('ai.stop')}
                    </button>
                  </div>
                );
              }
              const retired = m.superseded_at != null;
              const isLastAnswer = m.id === lastLiveAnswer?.id;
              return (
                <div key={m.id} className="bc-message group flex flex-col items-start" data-mine="false">
                  {switcher}
                  <div className="bc-message-bubble" style={retired ? { opacity: 0.5 } : undefined}>
                    <div className="bc-markdown">
                      <Markdown content={m.content ?? ''} />
                    </div>
                    <AiStepSummary steps={useAiStore.getState().activeStreamSteps(m.id)} />
                  </div>
                  {isLastAnswer && liveStream === null ? (
                    <div className="mt-0.5 flex gap-2 text-[10px] text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        onClick={() => void onRegenerate(m.id)}
                        className="rounded border border-slate-200 bg-white px-2 py-0.5 hover:text-slate-700"
                        aria-label={text('ai.regenerateAria')}
                      >
                        ↻ {text('ai.regenerate')}
                      </button>
                      <button
                        onClick={() => setShareId(m.id)}
                        className="rounded border border-slate-200 bg-white px-2 py-0.5 hover:text-slate-700"
                        aria-label={text('ai.shareAria')}
                      >
                        📤 {text('ai.share')}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {/* The assistant's own bubble cannot appear until the send round-trip
                returns and the server hands back a pending row, so until then the
                screen said nothing at all — you pressed Enter and waited. `sending`
                was already tracked in the store and simply had no reader. */}
            {sending && !list.some((m) => m.status === 'pending' || m.status === 'streaming') ? (
              <div className="bc-message flex flex-col items-start gap-1" data-mine="false" data-testid="ai-thinking">
                <div className="bc-message-bubble" style={{ color: 'var(--chat-muted)' }}>
                  <span className="animate-pulse">{text('ai.thinking')}</span>
                  <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-amber-400 align-middle" />
                </div>
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>
        </div>
      </div>

      {error !== null ? <p role="alert" className="bc-message-error px-6 pb-1">{error}</p> : null}
      {note !== null ? <p className="px-6 pb-1 text-xs text-emerald-600">{note}</p> : null}

      <div className="bc-composer">
        <div className="bc-compose-box flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value.slice(0, maxChars))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void onSubmit();
              }
            }}
            rows={Math.min(5, draft.split('\n').length)}
            disabled={status !== null && !status.consented}
            // Same string as the placeholder rather than a fixed one: an
            // aria-label overrides the placeholder as the accessible name, so a
            // stable label would have hidden the consent-required instruction
            // from a screen reader while sighted users could read it.
            aria-label={status !== null && !status.consented ? text('ai.consentRequired') : text('ai.placeholder')}
            placeholder={status !== null && !status.consented ? text('ai.consentRequired') : text('ai.placeholder')}
            data-testid="ai-composer-input"
          />
          {liveStream === null ? (
            <button onClick={() => void onSubmit()} disabled={!canSend} className="bc-compose-send" data-testid="ai-send-button" aria-label={text('chat.send')}>
              <Icon name="send" size={18} />
            </button>
          ) : (
            <button onClick={() => liveStream !== null && void cancel(liveStream.id, slug)} className="bc-compose-send" aria-label={text('ai.stop')}>
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        <p className="bc-ai-compose-meta">
          <span>
            {draft.length}/{maxChars}
            {status !== null ? text('ai.usageToday').replace('{used}', String(status.usage_today.messages)).replace('{limit}', String(status.limits.daily_messages)) : ''}
          </span>
        </p>
      </div>
    </div>
  );
}
