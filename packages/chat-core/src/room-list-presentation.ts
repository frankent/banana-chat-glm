/**
 * FR-UI-CL-002/003 — room-list row presentation (time label + preview text),
 * shared by web and mobile (CLAUDE.md: platform-agnostic logic lives in
 * chat-core). Pure functions only; DOM/layout stays in the web/mobile adapter.
 */
import type { RoomListItem } from '@banana-chat/shared';
import { extractLinkCards } from './link-cards.js';

export interface RoomListTime {
  /** compact row label, e.g. "14:30", "เมื่อวาน", "จันทร์", "19 ก.ย." */
  short: string;
  /** full date + time for the accessible label */
  full: string;
}

/**
 * FR-UI-CL-003 — today: HH:mm; yesterday: "เมื่อวาน"; within 7 days: weekday
 * name; older: "d MMM" (+ year when it differs from `now`'s year).
 */
export function roomListTime(iso: string, locale = 'th-TH', now: number = Date.now()): RoomListTime {
  const date = new Date(iso);
  const today = new Date(now);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);

  const full = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(date);

  if (dayDiff <= 0) {
    return { short: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(date), full };
  }
  if (dayDiff === 1) {
    return { short: 'เมื่อวาน', full };
  }
  if (dayDiff < 7) {
    return { short: new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date), full };
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  return {
    short: new Intl.DateTimeFormat(
      locale,
      sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' },
    ).format(date),
    full,
  };
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * FR-UI-CL-002 — plain-text preview: strip markdown, prefix our own messages
 * with "คุณ:", fall back to an attachment-type label when there is no text
 * body, and "ยังไม่มีข้อความ" when the room has no messages at all. Never uses
 * a bare "…" to stand in for an attachment.
 */
export interface RoomPreviewOptions {
  /** FR-MSG-013 — app origins; when given, ticket/meeting URLs become a label */
  appOrigins?: readonly string[];
  /** localized labels (i18n `room.previewTicket` / `room.previewMeeting`) */
  labels?: { ticket: string; meeting: string };
}

/** FR-MSG-013 — swap the first ticket/meeting URL for its label (no ticket content ever). */
function labelLinks(body: string, options: RoomPreviewOptions | undefined): string {
  if (options?.appOrigins === undefined || options.appOrigins.length === 0) return body;
  const [card] = extractLinkCards(body, options.appOrigins, 1);
  if (card === undefined || (card.kind !== 'ticket' && card.kind !== 'meeting')) return body;
  const labels = options.labels ?? { ticket: '🎫 Ticket', meeting: '📹 Meeting' };
  const at = body.indexOf(card.href);
  return at < 0 ? body : body.slice(0, at) + labels[card.kind] + body.slice(at + card.href.length);
}

export function roomPreviewText(lastMessage: RoomListItem['last_message'], myUserId: string, options?: RoomPreviewOptions): string {
  if (lastMessage === null) {
    return 'ยังไม่มีข้อความ';
  }
  if (lastMessage.type === 'system') {
    return stripMarkdown(lastMessage.body ?? '');
  }
  const mine = lastMessage.sender_id === myUserId;
  const prefix = mine ? 'คุณ: ' : '';
  const body = lastMessage.body?.trim();
  if (body !== undefined && body !== '') {
    return prefix + stripMarkdown(labelLinks(body, options));
  }
  if (lastMessage.type === 'image') return prefix + 'รูปภาพ';
  if (lastMessage.type === 'video') return prefix + 'วิดีโอ';
  if (lastMessage.type === 'file') return prefix + 'ไฟล์';
  return 'ยังไม่มีข้อความ';
}
