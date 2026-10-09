import { useQuery } from '@tanstack/react-query';
import { ApiError } from '@banana-chat/api-client';
import { endpoints } from '../../lib/api';
import { useChatText } from '../../lib/use-chat-text';

/**
 * FR-MSG-013 / B5.5 — public meeting card from the unauthenticated lobby
 * endpoint. Join opens /meet/{code} in a NEW TAB (that route lives outside the
 * call providers). 410 = ended, 404 = missing, anything else (503 calls
 * disabled, network) degrades to the plain link.
 */
export function MeetingLinkCard({ code, href }: { code: string; href: string }) {
  const { text, locale } = useChatText();
  const query = useQuery({
    queryKey: ['meeting-lobby', code],
    queryFn: () => endpoints.meetingLobby(code),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const status = query.error instanceof ApiError ? query.error.status : null;
  const path = `/meet/${code}`;

  if (query.isPending) {
    return <div className="bc-linkcard bc-linkcard-skeleton" data-testid="meeting-link-card" data-state="loading" aria-busy="true"><span className="bc-linkcard-bar" /><span className="bc-linkcard-bar short" /></div>;
  }
  if (query.isError && status !== 410 && status !== 404) {
    return <a className="bc-linkcard-plain" data-testid="meeting-link-plain" href={href} target="_blank" rel="noopener noreferrer">{href}</a>;
  }
  if (query.isError || query.data === undefined) {
    const ended = status === 410;
    const label = text(ended ? 'chat.meetingEnded' : 'chat.meetingMissing');
    return (
      <div className="bc-linkcard bc-linkcard-muted" data-testid="meeting-link-card" data-state={ended ? 'ended' : 'missing'}>
        <span className="bc-linkcard-title">{label}</span>
        <span className="bc-linkcard-join" aria-disabled="true" data-testid="meeting-link-join">{text('chat.meetingJoin')}</span>
      </div>
    );
  }
  const m = query.data;
  return (
    <div className="bc-linkcard bc-linkcard-row" data-testid="meeting-link-card" data-state="live">
      <span className="bc-linkcard-body">
        <span className="bc-linkcard-title" data-testid="meeting-link-title">{m.title}</span>
        <span className="bc-linkcard-meta">
          <span>{text('chat.meetingCardExpires').replace('{time}', new Date(m.expires_at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }))}</span>
          <span>{text('chat.meetingCardCapacity').replace('{count}', String(m.capacity))}</span>
        </span>
      </span>
      <a className="bc-linkcard-join" data-testid="meeting-link-join" href={path} target="_blank" rel="noopener noreferrer">{text('chat.meetingJoin')}</a>
    </div>
  );
}
