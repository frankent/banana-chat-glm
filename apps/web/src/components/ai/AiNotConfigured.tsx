import { useSession } from '../../state/session';
import { useChatText } from '../../lib/use-chat-text';
import { Icon } from '../Visual';

/**
 * FR-AI-001 AC#2 — `ai.enabled` is on but no provider is `is_enabled && is_default`.
 * The spec keeps the nav entry visible and explains on open, so this renders in the
 * pane AND in the sidebar: on a phone `/ai` shows only the sidebar (`is-chat-list`
 * hides `.bc-main`), so an explanation living solely in the pane would be invisible
 * on exactly the surface the user landed on.
 *
 * Before this existed the sidebar showed its ordinary "no conversations yet / start
 * a new chat" empty state, which was a lie — every one of those actions 503s.
 */
export function AiNotConfigured({ variant }: { variant: 'pane' | 'list' }) {
  const { text } = useChatText();
  const { me } = useSession();
  // instance-wide, not a workspace role: only a system admin can add a provider
  const isAdmin = me?.is_system_admin === true;
  const Heading = variant === 'pane' ? 'h3' : 'strong';

  return (
    <div className={variant === 'pane' ? 'bc-empty-conversation' : 'bc-chat-list-empty'} data-testid="ai-not-configured">
      <Icon name="sparkle" size={variant === 'pane' ? 30 : 28} />
      <Heading>{text('ai.notConfigured')}</Heading>
      <p>{isAdmin ? text('ai.notConfiguredAdminHint') : text('ai.notConfiguredHint')}</p>
      {isAdmin && (
        // A plain <a>, not a router link: /admin is Filament behind its own guard
        // (it 302s to /admin/login), so it is not a route this SPA can render.
        <a className="bc-primary" href="/admin" data-testid="ai-admin-panel-link">
          {text('ai.openAdminPanel')}
        </a>
      )}
    </div>
  );
}
