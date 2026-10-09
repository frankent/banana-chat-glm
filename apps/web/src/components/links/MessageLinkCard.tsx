import { extractLinkCards, type LinkCard } from '@banana-chat/chat-core';
import { ExternalLinkCard } from './ExternalLinkCard';
import { MeetingLinkCard } from './MeetingLinkCard';
import { TicketLinkCard } from './TicketLinkCard';
import '../../styles/link-cards.css';

/**
 * FR-MSG-013 / DEC-100 (R1) — app origins: the current web origin plus the
 * optional comma list VITE_APP_ORIGINS. Anything else is `external`.
 */
export function appOrigins(): string[] {
  const extra = String(import.meta.env['VITE_APP_ORIGINS'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const own = typeof window !== 'undefined' ? [window.location.origin] : [];
  return [...new Set([...own, ...extra])];
}

export interface MessageCardInfo {
  card: LinkCard | null;
  /** ticket/meeting card whose message is ONLY the URL: hide the raw line (stays in DOM for copy/a11y) */
  hideBody: boolean;
}

/** Pure; one card per message (first card-worthy URL). Callers skip deleted/pending/editing rows. */
export function messageCardInfo(body: string | null): MessageCardInfo {
  if (body === null || body.trim() === '') return { card: null, hideBody: false };
  const [card] = extractLinkCards(body, appOrigins(), 1);
  if (card === undefined) return { card: null, hideBody: false };
  // external stays visible: when the preview is none/pending the plain link is the fallback
  return { card, hideBody: card.kind !== 'external' && body.trim() === card.href };
}

/** R2: rendered by MessageItem under the body, never inside the shared Markdown component. */
export function MessageLinkCard({ card }: { card: LinkCard }) {
  if (card.kind === 'ticket') return <TicketLinkCard ticketId={card.ticketId} ws={card.ws} href={card.href} />;
  if (card.kind === 'meeting') return <MeetingLinkCard code={card.code} href={card.href} />;
  return <ExternalLinkCard url={card.url} />;
}

/** Ref for the visually hidden raw-URL body: out of the tab order and screen-reader tree, text stays selectable. */
export function hiddenBodyRef(el: HTMLElement | null): void {
  if (el === null) return;
  el.setAttribute('aria-hidden', 'true');
  el.querySelectorAll('a').forEach(a => a.setAttribute('tabindex', '-1'));
}
