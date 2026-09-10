import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '../lib/api';
import { useUploader } from '../hooks/useUploader';
import { Markdown } from './ai/Markdown';
import { AttachmentView } from './MessageItem';

/** FR-NOTE-001 — paginated durable notes; no limit on number created. */
export function NotesPanel({roomId, slug, me, canModerate, onClose}: {roomId:string; slug:string; me:string; canModerate:boolean; onClose:()=>void}) {
  const client = useQueryClient();
  const key = ['notes', slug, roomId, me];
  const query = useInfiniteQuery({queryKey:key, initialPageParam:'', queryFn:({pageParam}) => endpoints.notes(roomId, slug, pageParam), getNextPageParam:last => last.has_more ? last.notes.at(-1)?.id : undefined, refetchInterval:15000});
  const [body, setBody] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const {staged, addFiles, remove, clear} = useUploader(slug);
  const refresh = () => client.invalidateQueries({queryKey:['notes', slug, roomId]});
  async function save() {
    setBusy(true); setError('');
    try {
      if (editing) await endpoints.updateNote(roomId, slug, editing, body);
      else await endpoints.createNote(roomId, slug, body, staged.map(a => a.attachmentId!));
      setBody(''); setEditing(null); clear(); await refresh();
    } catch(e) {setError(e instanceof Error ? e.message : 'Unable to save note');} finally {setBusy(false);}
  }
  return <aside className="bc-notes" aria-label="Room notes"><header><div><strong>Notes</strong><small>A shared notebook for this room</small></div><button onClick={onClose} aria-label="Close notes">✕</button></header>
    <div className="bc-note-compose"><textarea aria-label="Note text" placeholder="Write a note… Markdown and links supported" value={body} maxLength={20000} onChange={e => setBody(e.target.value)} />
      {!editing && <label className="bc-note-upload">Attach image / video / file<input type="file" multiple aria-label="Note attachments" onChange={e => {if(e.target.files) void addFiles(Array.from(e.target.files)); e.target.value='';}} /></label>}
      {staged.map(a => <div key={a.localId}>{a.filename} · {a.status}<button aria-label={`Remove ${a.filename}`} onClick={() => remove(a.localId)}>✕</button></div>)}
      {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
      <div><button className="bc-primary" disabled={busy || (!body.trim() && !staged.length && !editing) || staged.some(a => !['ready','processing'].includes(a.status))} onClick={() => void save()}>{editing ? 'Save changes' : 'Create note'}</button>{editing && <button onClick={() => {setEditing(null);setBody('');}}>Cancel</button>}</div>
    </div>
    <div className="bc-note-list">{query.isLoading && <p>Loading notes…</p>}{query.data?.pages.flatMap(p => p.notes).map(note => <article key={note.id} data-testid="room-note"><header><strong>{note.author_name}</strong><time>{new Date(note.created_at).toLocaleDateString()}</time></header>{note.body && <Markdown content={note.body} />}{note.attachments.map(a => <AttachmentView key={a.id} attachment={a} />)}{(note.author_id === me || canModerate) && <footer><button onClick={() => {setEditing(note.id);setBody(note.body ?? '');clear();}}>Edit note</button><button disabled={busy} onClick={async () => {setBusy(true);setError('');try {await endpoints.deleteNote(roomId, slug, note.id);await refresh();}catch(e){setError(e instanceof Error ? e.message : 'Unable to delete');}finally{setBusy(false);}}}>Delete note</button></footer>}</article>)}
    {query.data?.pages[0]?.notes.length === 0 && <p>No notes yet. Save something worth keeping.</p>}
    {query.hasNextPage && <button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load older notes</button>}</div>
  </aside>;
}
