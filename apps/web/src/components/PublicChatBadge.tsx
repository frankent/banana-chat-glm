/**
 * FR-PCHAT-003 — the rail badge: API-227 `summary.new + summary.problem`, i.e.
 * the two states that need a human to pick the conversation up. It is polled
 * every 30s and invalidated by EVT-081/082 on private-workspace.{wid}, which
 * EchoProvider owns — this component deliberately does NOT subscribe to that
 * channel itself, because laravel-echo's `stopListening(event)` without a
 * callback unbinds EVERY listener for that event on the channel, so a second
 * subscriber would kill the first one's handler when it unmounts.
 */
import { useQuery } from '@tanstack/react-query';
import { pchat } from '../lib/public-chat';
import { useSession } from '../state/session';
// the badge renders in the always-mounted rail, so it carries its own stylesheet
// import rather than relying on a Public Chat page having been visited first
import '../pages/public-chat.css';

export function PublicChatBadge() {
  const { currentWorkspace } = useSession();
  const slug = currentWorkspace?.workspace.slug ?? '';

  const summary = useQuery({
    queryKey: ['public-chat', 'summary', slug],
    queryFn: () => pchat.summary(slug),
    enabled: slug !== '',
    refetchInterval: 30_000,
    // the rail is always mounted; a failed poll must not surface an error here
    retry: false,
  });

  if (summary.data === undefined || !summary.data.feature_enabled) {
    return null;
  }

  const waiting = summary.data.summary.new + summary.data.summary.problem;
  if (waiting <= 0) {
    return null;
  }

  return (
    <i className="bc-pchat-badge" aria-label={`${waiting} support conversations waiting`}>
      {waiting > 99 ? '99+' : waiting}
    </i>
  );
}
