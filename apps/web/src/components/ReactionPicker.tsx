import { useEffect, useRef, useState } from 'react';
import { emojiEntries, pastedEmoji } from '../lib/emoji-data';
import type { reactionsText } from '../lib/reactions-text';

type Copy = typeof reactionsText[keyof typeof reactionsText];

export function ReactionPicker({ copy, onChoose, onClose }: {
  copy: Copy;
  onChoose: (emoji: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [recent, setRecent] = useState<string[]>(() => {
    try { const value = window.localStorage.getItem('banana.reaction-recent'); return value ? JSON.parse(value).filter((x: unknown) => typeof x === 'string').slice(0, 24) : []; }
    catch { return []; }
  });
  const pickerRef = useRef<HTMLElement>(null);
  const closeHandler = useRef(onClose); closeHandler.current = onClose;
  const pasted = pastedEmoji(search);
  const filtered = (() => {
    const query = search.trim().toLocaleLowerCase();
    const found = (query ? emojiEntries.filter(entry => entry.keywords.toLocaleLowerCase().includes(query) || entry.emoji.includes(query)) : emojiEntries).slice(0, 320);
    return pasted && !found.some(entry => entry.emoji === pasted) ? [{ category: 'pasted', emoji: pasted, keywords: pasted }, ...found] : found;
  })();

  useEffect(() => {
    pickerRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeHandler.current(); return; }
      if (event.key !== 'Tab') return;
      const items = [...(pickerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input') ?? [])];
      if (!items.length) return;
      const first = items[0]!; const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);

  const choose = (emoji: string) => {
    const next = [emoji, ...recent.filter(item => item !== emoji)].slice(0, 24);
    setRecent(next); try { window.localStorage.setItem('banana.reaction-recent', JSON.stringify(next)); } catch { /* private mode */ }
    onChoose(emoji);
  };
  return <div className="bc-emoji-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={pickerRef} className="bc-emoji-picker" role="dialog" aria-modal="true" aria-label={copy.picker} onKeyDown={event => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...(pickerRef.current?.querySelectorAll<HTMLButtonElement>('button[data-emoji]') ?? [])];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (index >= 0) { event.preventDefault(); const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 8 : -8; buttons[(index + delta + buttons.length) % buttons.length]?.focus(); }
    }}>
      <header><strong>{copy.picker}</strong><button type="button" aria-label={copy.close} onClick={onClose}>×</button></header>
      <label className="bc-emoji-search">{copy.search}<input value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && pasted && !event.nativeEvent.isComposing) { event.preventDefault(); choose(pasted); } }} /></label>
      {recent.length > 0 && !search && <><h4>{copy.recent}</h4><div className="bc-emoji-grid">{recent.map(emoji => <button data-emoji type="button" key={emoji} aria-label={copy.selected.replace('{emoji}', emoji)} onClick={() => choose(emoji)}>{emoji}</button>)}</div></>}
      <h4>{copy.all}</h4><div className="bc-emoji-grid" role="group" aria-label={copy.all}>{filtered.map(item => <button data-emoji type="button" key={`${item.category}-${item.emoji}`} aria-label={copy.selected.replace('{emoji}', item.emoji)} title={item.keywords} onClick={() => choose(item.emoji)}>{item.emoji}</button>)}</div>
    </section>
  </div>;
}
