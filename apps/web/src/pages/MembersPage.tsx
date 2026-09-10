import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { endpoints } from '../lib/api';
import { useSession } from '../state/session';
import { Avatar, Icon } from '../components/Visual';

/** FR-WS-005 / API-138 — every page of the workspace directory, stable cursor. */
export function MembersPage() {
  const {currentWorkspace, me} = useSession();
  const slug = currentWorkspace!.workspace.slug;
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const query = useInfiniteQuery({queryKey:['directory', slug, me?.id, search], initialPageParam:'', queryFn:({pageParam}) => endpoints.directoryPage(slug, search, pageParam), getNextPageParam:last => last.next_cursor ?? undefined});
  return <section className="bc-directory"><header><span className="bc-eyebrow">YOUR WORKSPACE</span><h1>People</h1><p>Find someone and start a conversation.</p></header>
    <label className="bc-directory-search"><Icon name="search" /><input aria-label="Search workspace members" placeholder="Search by name or username" value={search} onChange={e => setSearch(e.target.value)} /></label>
    {(error || query.error) && <p role="alert">{error || query.error?.message}</p>}
    {query.isLoading && <p>Loading members…</p>}
    <div className="bc-people">{query.data?.pages.flatMap(p => p.members).map(member => <button key={member.id} disabled={busy !== null || member.id === me?.id} onClick={async () => {
      setBusy(member.id); setError('');
      try { const result = await endpoints.createDm(member.id, slug); navigate(`/rooms/${result.room.id}`); }
      catch(e) { setError(e instanceof Error ? e.message : 'Unable to start conversation'); }
      finally {setBusy(null);}
    }}><Avatar name={member.display_name} /><span><strong>{member.display_name}{member.id === me?.id ? ' (you)' : ''}</strong><small>@{member.username}</small></span><Icon name="chat" /></button>)}</div>
    {!query.isLoading && query.data?.pages[0]?.members.length === 0 && <p>No members found.</p>}
    {query.hasNextPage && <button className="bc-primary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Load more members</button>}
  </section>;
}
