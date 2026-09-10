import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '@banana-chat/shared';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';
import { Markdown } from './ai/Markdown';

/** FR-MEDIA-005: native modal gives Escape, focus trapping and focus restoration. */
export function MediaViewer({attachment, onClose}: {attachment: Attachment; onClose: () => void}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);
  const slug = useSession(s => s.currentWorkspace?.workspace.slug);
  const [urls, setUrls] = useState(attachment.urls);
  const url = urls.original;
  useEffect(() => {
    if (!slug || Date.parse(attachment.urls_expire_at) > Date.now() + 10000) return;
    let active = true;
    void endpoints.attachment(attachment.id, slug).then(result => {if (active) setUrls(result.attachment.urls);}).catch(() => {if (active) setError('Unable to refresh this attachment.');});
    return () => {active = false;};
  }, [attachment.id, attachment.urls_expire_at, slug]);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  useEffect(() => {
    if (attachment.kind !== 'file' || !url) return;
    const abort = new AbortController();
    if (attachment.size_bytes > 1024 * 1024) {setError('Text preview supports files up to 1 MB. Download to view the full file.');return;}
    void fetch(url, {signal:abort.signal}).then(async response => {
      if (!response.ok) throw new Error('Preview unavailable. Reopen the room to refresh the file URL.');
      setText((await response.text()).slice(0, 1024 * 1024));
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [attachment.id, url]);
  return <dialog ref={ref} className="bc-viewer" aria-label={attachment.original_name} onCancel={onClose} onClick={e => {if (e.target === ref.current) onClose();}}>
    <header><strong>{attachment.original_name}</strong><div>{attachment.kind === 'image' && <button onClick={() => setZoom(!zoom)}>{zoom ? 'Fit' : 'Zoom'}</button>}<a href={url ?? undefined} target="_blank" rel="noreferrer">Download</a><button aria-label="Close viewer" onClick={onClose}>✕</button></div></header>
    <div className="bc-viewer-content">{attachment.kind === 'image' ? <img className={zoom ? 'zoom' : ''} src={url ?? undefined} alt={attachment.original_name} /> : attachment.kind === 'video' ? <video controls autoPlay playsInline src={url ?? undefined} poster={attachment.urls.poster ?? undefined} /> : error ? <p role="alert">{error}</p> : <Markdown content={text || 'Loading…'} />}</div>
  </dialog>;
}
