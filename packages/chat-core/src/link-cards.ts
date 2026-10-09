/**
 * FR-MSG-013 / FR-KAN-007 / DEC-100 — link-card grammar (platform agnostic).
 *
 * A share / pasted link is an ordinary text message whose body holds a URL;
 * the client upgrades the FIRST card-worthy URL to a card. This file is the
 * single place that decides what a URL is. Origins are injected so chat-core
 * never touches `window`.
 *
 * Grammar (frozen, Tech Lead B2):
 *   ticket   {ORIGIN}/board/{ULID}[?ws={slug}]   (no other query params)
 *   meeting  {ORIGIN}/meet/{64 lowercase hex}    (no query)
 *   ORIGIN   an app origin; any other path on an app host (/support, /join,
 *            …) is `internal-plain`: a plain link, never carded, never fetched.
 *   other http(s) URLs are `external` (server-side preview, API-241).
 */
import { parseInline } from './markdown.js';

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MEETING_RE = /^[a-f0-9]{64}$/;
const MAX_URL_LENGTH = 2048;

export type LinkClass =
  | { kind: 'ticket'; ticketId: string; ws: string | null }
  | { kind: 'meeting'; code: string }
  | { kind: 'external'; url: string }
  | { kind: 'internal-plain' };

export type LinkCard = Exclude<LinkClass, { kind: 'internal-plain' }> & {
  /** the exact href as it appears in the body */
  href: string;
};

function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Classify one href. `null` = not a link we ever treat specially (not
 * http(s), unparsable, over-long, or an external URL the server would refuse
 * anyway: userinfo, non-80/443 port).
 *
 * Deliberate hardening beyond "origin equals": a URL on the same HOSTNAME as
 * an app origin but with another scheme/port is `internal-plain` (never
 * external), so the previewer is never asked about our own host.
 */
export function classifyLink(href: string, appOrigins: readonly string[]): LinkClass | null {
  if (href.length > MAX_URL_LENGTH) return null;
  const url = parseOrigin(href);
  if (url === null) return null;

  const origins = appOrigins.map(parseOrigin).filter((u): u is URL => u !== null);
  const sameOrigin = origins.some(o => o.origin === url.origin);
  const sameHost = origins.some(o => o.hostname === url.hostname);

  if (!sameOrigin) {
    if (sameHost) return { kind: 'internal-plain' };
    if (url.username !== '' || url.password !== '') return null;
    if (url.port !== '') return null; // WHATWG drops default ports, so any left is non-80/443
    return { kind: 'external', url: href };
  }

  // userinfo on an app origin is never a card (credential-looking look-alike)
  if (url.username !== '' || url.password !== '') return { kind: 'internal-plain' };

  const ticket = /^\/board\/([^/]+)$/.exec(url.pathname);
  if (ticket !== null && ULID_RE.test(ticket[1])) {
    let ws: string | null = null;
    const keys = [...url.searchParams.keys()];
    if (keys.length > 0) {
      const all = url.searchParams.getAll('ws');
      if (keys.length !== 1 || keys[0] !== 'ws' || all.length !== 1 || !SLUG_RE.test(all[0])) {
        return { kind: 'internal-plain' };
      }
      ws = all[0];
    }
    return { kind: 'ticket', ticketId: ticket[1].toLowerCase(), ws };
  }

  const meeting = /^\/meet\/([^/]+)$/.exec(url.pathname);
  if (meeting !== null && MEETING_RE.test(meeting[1]) && url.search === '') {
    return { kind: 'meeting', code: meeting[1] };
  }

  return { kind: 'internal-plain' };
}

/**
 * ONE card per message: the first link in body order whose class is a card
 * kind. Fenced code blocks are skipped; inline code is already a `code` node
 * in the markdown parser, so it never yields a link.
 */
export function extractLinkCards(body: string, appOrigins: readonly string[], max = 1): LinkCard[] {
  const cards: LinkCard[] = [];
  if (max < 1) return cards;
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const marker = /^\s{0,3}(```|~~~)/.exec(line);
    if (fence !== null) {
      if (marker !== null && marker[1] === fence) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = marker[1];
      continue;
    }
    for (const node of parseInline(line)) {
      if (node.type !== 'link') continue;
      const cls = classifyLink(node.href, appOrigins);
      if (cls === null || cls.kind === 'internal-plain') continue;
      cards.push({ ...cls, href: node.href });
      if (cards.length >= max) return cards;
    }
  }
  return cards;
}

/** Shareable ticket URL; always carries the workspace slug (`?ws=`). */
export function ticketLinkUrl(origin: string, ticketId: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}/board/${ticketId}?ws=${encodeURIComponent(slug)}`;
}

/** Login `returnTo` whitelist for ticket deep links (never an open redirect). */
export function ticketReturnPath(value: string | null): string | null {
  if (value === null) return null;
  const m = /^\/board\/([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\?ws=([a-z0-9][a-z0-9-]{0,62}))?$/i.exec(value);
  if (m === null) return null;
  return m[2] !== undefined && !SLUG_RE.test(m[2]) ? null : value;
}

/** Room-list prefix kind for the first card-worthy URL in a body, or null. */
export function linkPreviewLabel(body: string, appOrigins: readonly string[]): 'ticket' | 'meeting' | null {
  const [card] = extractLinkCards(body, appOrigins, 1);
  return card !== undefined && (card.kind === 'ticket' || card.kind === 'meeting') ? card.kind : null;
}
