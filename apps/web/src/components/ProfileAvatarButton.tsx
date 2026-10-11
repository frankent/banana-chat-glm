import type { UserStub } from '@banana-chat/shared';
import { isAiBotUsername } from '@banana-chat/chat-core';
import { Avatar } from './Visual';
import '../profile-popover.css';

/**
 * FR-PROF-009 — the clickable sender avatar / name. The AI bot is not a person,
 * so it keeps today's plain markup. `hidden` is a grouped follow-up row: the
 * avatar stays for layout but leaves the tab order and the accessibility tree.
 */
export function ProfileAvatarButton({ sender, label, variant, hidden = false, onOpen }: {
  sender: UserStub;
  label: string;
  variant: 'avatar' | 'name';
  hidden?: boolean;
  onOpen: (sender: UserStub, trigger: HTMLButtonElement) => void;
}) {
  const content = variant === 'avatar'
    ? <Avatar name={sender.display_name} avatar={sender.avatar} className="bc-message-avatar" />
    : sender.display_name;
  if (isAiBotUsername(sender.username)) return <>{content}</>;
  return (
    <button
      type="button"
      className={`bc-profile-trigger ${variant === 'name' ? 'is-name' : 'is-avatar'}`}
      aria-haspopup="dialog"
      aria-label={label}
      data-testid={variant === 'avatar' ? 'profile-avatar-button' : 'profile-name-button'}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden ? true : undefined}
      onClick={event => onOpen(sender, event.currentTarget)}
    >
      {content}
    </button>
  );
}
