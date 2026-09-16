/**
 * FR-PCHAT-008 — platform-agnostic public-support-chat logic, shared by web and
 * (later) mobile. CLAUDE.md: this lives in `packages/chat-core`, NEVER in an
 * app, so the agent queue, the visitor page and the server's own test fixtures
 * all agree on one definition of "needs reply", one queue order and — most
 * importantly — one spelling of the customer-facing agent label.
 *
 * DEC-064: public chat is an isolated bounded context. Nothing here touches
 * rooms/messages logic and no `RoomType` case is added.
 *
 * TWO SURFACES, ONE MODULE. Anything named `…Public…`/`visitor…` is safe on the
 * customer surface; everything else is internal. The projection that keeps them
 * apart is `publicChatStatusPublic` — see MANDATORY graft 1.
 */

import type {
  Locale,
  PublicChatAssigneeFilter,
  PublicChatClosedReason,
  PublicChatFilters,
  PublicChatStatus,
  PublicChatStatusPublic,
  PublicChatViewer,
} from '@banana-chat/shared';

/**
 * The four internal queue statuses, in triage order of severity. `satisfies`
 * pins them to the shared union so the list cannot drift from the wire type.
 */
export const PUBLIC_CHAT_STATUSES = ['new', 'in_progress', 'done', 'problem'] as const satisfies readonly PublicChatStatus[];

/** Visual weight for the status pill. Apps map these onto their own palette. */
export type PublicChatStatusTone = 'neutral' | 'info' | 'ok' | 'warn';

/**
 * The room fields this module reasons about. Structural on purpose: a
 * `PublicChatStaffRoom` from API-220 satisfies it, and so does a hand-built
 * test fixture. `id` is required because it is the queue's final tiebreak.
 */
export interface PublicChatRoomLike {
  id: string;
  status: PublicChatStatus;
  assigned_to?: { id: string } | string | null;
  last_visitor_seq: number;
  last_agent_seq: number;
  customer_name: string;
  provider_name: string;
  external_ref?: string | null;
  last_message_at: string | null;
}

/** `assigned_to` arrives as a stub from the API and as a bare ULID in fixtures. */
function assigneeId(room: PublicChatRoomLike): string | null {
  const assigned = room.assigned_to;
  if (assigned == null) {
    return null;
  }
  return typeof assigned === 'string' ? assigned : assigned.id;
}

// ---- status ----

/**
 * MANDATORY graft 1 / FR-PCHAT-007 — the ONLY status projection a visitor may
 * receive. `problem` is an internal triage flag: a customer discovering that
 * support flagged their conversation is an information disclosure with a real
 * business cost, so it collapses into `open` exactly like `new` and
 * `in_progress`. Any visitor-facing code path must go through this function
 * rather than reading `room.status`.
 */
export function publicChatStatusPublic(status: PublicChatStatus): PublicChatStatusPublic {
  return status === 'done' ? 'closed' : 'open';
}

/**
 * The status labels, mirroring the shared `pchat.status.*` / `pchat.statusPublic.*`
 * catalog entries verbatim.
 *
 * WHY A TABLE AND NOT `t()` FROM @banana-chat/shared: importing the translator
 * here at RUNTIME (today every chat-core → shared import is `import type`) pulls
 * `shared/src/i18n.ts` into every consumer's build, and its
 * `import … with { type: 'json' }` attributes are not compilable by
 * apps/mobile's ts-jest transform — it takes three mobile suites down. Verified
 * empirically, not assumed. The single-source property is preserved where it
 * actually matters: TC-CORE-066 asserts each entry below is byte-identical to
 * the catalog (the test runs under Vitest, which handles the JSON import), so
 * drift is a failing test rather than a silent divergence. Apps that already
 * hold a translator should keep calling `t('pchat.status.…')`.
 */
const STATUS_LABELS: Record<Locale, Record<PublicChatStatus, string>> = {
  th: { new: 'ใหม่', in_progress: 'กำลังดำเนินการ', done: 'เสร็จสิ้น', problem: 'มีปัญหา' },
  en: { new: 'New', in_progress: 'In progress', done: 'Done', problem: 'Problem' },
};

const STATUS_PUBLIC_LABELS: Record<Locale, Record<PublicChatStatusPublic, string>> = {
  th: { open: 'เปิดอยู่', closed: 'ปิดแล้ว' },
  en: { open: 'Open', closed: 'Closed' },
};

/** The i18n key an app with a translator should use for this status. */
export function publicChatStatusLabelKey(status: PublicChatStatus): string {
  return `pchat.status.${status}`;
}

/** Localised label for the internal status pill (agent + admin surfaces only). */
export function publicChatStatusLabel(status: PublicChatStatus, locale: Locale = 'th'): string {
  return (STATUS_LABELS[locale] ?? STATUS_LABELS.th)[status];
}

/** Visitor-facing label — `open`/`closed` only, never the raw status. */
export function publicChatStatusPublicLabel(status: PublicChatStatusPublic, locale: Locale = 'th'): string {
  return (STATUS_PUBLIC_LABELS[locale] ?? STATUS_PUBLIC_LABELS.th)[status];
}

export function publicChatStatusTone(status: PublicChatStatus): PublicChatStatusTone {
  switch (status) {
    case 'new':
      return 'neutral';
    case 'in_progress':
      return 'info';
    case 'done':
      return 'ok';
    case 'problem':
      return 'warn';
  }
}

// ---- queue signals ----

/**
 * FR-PCHAT-005 — the queue-level "waiting on us" signal, identical for every
 * viewer. This is NOT per-agent unread (that is `unread_count`, FR-PCHAT-010,
 * and it deliberately never changes queue order): it says the customer spoke
 * last, so the conversation is owed a reply.
 */
export function needsReply(room: Pick<PublicChatRoomLike, 'status' | 'last_visitor_seq' | 'last_agent_seq'>): boolean {
  return room.last_visitor_seq > room.last_agent_seq && room.status !== 'done';
}

/** Who holds the conversation, from the viewer's point of view (FR-PCHAT-009). */
export type PublicChatClaimState = 'unassigned' | 'mine' | 'other';

export function publicChatClaimState(room: PublicChatRoomLike, meId: string | null | undefined): PublicChatClaimState {
  const assigned = assigneeId(room);
  if (assigned === null) {
    return 'unassigned';
  }
  return meId != null && assigned === meId ? 'mine' : 'other';
}

/**
 * MANDATORY graft 19 / FR-PCHAT-005 — the default queue order, one formula for
 * every viewer: `problem` first, then `needs_reply`, then `last_message_at`
 * DESC NULLS LAST, then `id` DESC. Ordering by recency alone buries a flagged
 * or unanswered conversation under a chatty resolved one.
 *
 * The server sorts authoritatively; this exists so a room arriving live on
 * EVT-081/082 can be spliced into the page at the same position the next fetch
 * would put it, instead of jumping when the list refetches.
 */
export function comparePublicChatRooms(a: PublicChatRoomLike, b: PublicChatRoomLike): number {
  const tier = (room: PublicChatRoomLike): number => (room.status === 'problem' ? 0 : needsReply(room) ? 1 : 2);
  const tierDiff = tier(a) - tier(b);
  if (tierDiff !== 0) {
    return tierDiff;
  }

  // last_message_at DESC NULLS LAST — a room nobody has written in yet sorts
  // below every room that has a message, never above the newest one.
  const aAt = a.last_message_at == null ? null : Date.parse(a.last_message_at);
  const bAt = b.last_message_at == null ? null : Date.parse(b.last_message_at);
  const aValid = aAt !== null && !Number.isNaN(aAt);
  const bValid = bAt !== null && !Number.isNaN(bAt);
  if (aValid !== bValid) {
    return aValid ? -1 : 1;
  }
  if (aValid && bValid && aAt !== bAt) {
    return (bAt as number) - (aAt as number);
  }

  // id DESC — ULIDs are lexicographically time-ordered, so this is "newest first".
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Non-mutating `comparePublicChatRooms` over a whole list. */
export function sortPublicChatQueue<T extends PublicChatRoomLike>(rooms: readonly T[]): T[] {
  return [...rooms].sort(comparePublicChatRooms);
}

// ---- list filtering ----

/**
 * FR-PCHAT-004 says every filter is applied SERVER-SIDE (API-220) and belongs in
 * the react-query key — the client must never filter a page it already fetched,
 * or "Problem only" would silently mean "problem rooms on page 1".
 *
 * This predicate therefore has exactly one job: deciding whether a room that
 * arrived LIVE on EVT-081/082 belongs in the view currently on screen, so a
 * room the agent just resolved leaves a "New" filter without a refetch. It is
 * not a substitute for the server filter, and it cannot be: `q` matches message
 * bodies server-side (an EXISTS over `public_chat_messages`) and the client has
 * no bodies, so `q` here matches the room's own fields only — the honest
 * consequence is that a live room may fail this predicate and still be a real
 * server-side `q` hit, which the next fetch corrects.
 */
export function filterPublicChatRooms<T extends PublicChatRoomLike>(
  rooms: readonly T[],
  filters: Partial<PublicChatFilters> & { meId?: string | null },
): T[] {
  return rooms.filter((room) => matchesPublicChatFilters(room, filters));
}

export function matchesPublicChatFilters(
  room: PublicChatRoomLike,
  filters: Partial<PublicChatFilters> & { meId?: string | null },
): boolean {
  const { status, assignee, q, needsReply: wantsReply, meId } = filters;

  if (status != null && status.length > 0 && !status.includes(room.status)) {
    return false;
  }

  if (assignee != null && assignee !== 'all' && !matchesAssignee(room, assignee, meId)) {
    return false;
  }

  if (wantsReply === true && !needsReply(room)) {
    return false;
  }

  const needle = q?.trim().toLowerCase() ?? '';
  if (needle !== '') {
    const haystack = [room.customer_name, room.provider_name, room.external_ref ?? ''];
    if (!haystack.some((field) => field.toLowerCase().includes(needle))) {
      return false;
    }
  }

  return true;
}

function matchesAssignee(room: PublicChatRoomLike, assignee: PublicChatAssigneeFilter, meId?: string | null): boolean {
  const assigned = assigneeId(room);
  if (assignee === 'none') {
    return assigned === null;
  }
  if (assignee === 'me') {
    // No viewer id means "me" cannot be evaluated; fail closed rather than
    // showing another agent's queue as if it were yours.
    return meId != null && assigned === meId;
  }
  return assigned === assignee;
}

// ---- display names ----

/**
 * FR-PCHAT-014 / MANDATORY fix 20 — the customer-facing identity of an agent.
 * ONE definition, shared by the server's write-time snapshot assembly, the
 * agent UI and the visitor page, so the external label cannot drift.
 *
 * The result is a PLAIN TEXT NODE on every surface: it is assembled from
 * attacker-adjacent strings (`provider_name` comes from the partner) and must
 * never reach the Markdown renderer, a Filament `->html()` column or `{!! !!}`.
 */
export function agentExternalName(providerName: string, agentUsername: string): string {
  const provider = providerName.trim();
  const username = agentUsername.trim();
  if (provider === '') {
    return username;
  }
  if (username === '') {
    return provider;
  }
  return `${provider} (${username})`;
}

/**
 * The VISITOR-side counterpart: the customer has no username and never gets
 * one, so their label is their own name and nothing else. (Note the asymmetry
 * is deliberate and only runs one way — FR-PCHAT-014 says the visitor DOES see
 * `provider (username)` for an agent; it is the customer who is nameless
 * internally, not the agent who is anonymous externally.)
 *
 * This is also the single ingest sanitiser for every customer-supplied name
 * (`customer_name`, `provider_name`): C0/C1 controls and the bidi/zero-width
 * range U+200B–U+200F / U+202A–U+202E are stripped and the result is capped at
 * 120 characters, because ingest is the only defence that travels with the data
 * into a future push payload, email template or CSV export.
 *
 * Returns `null` when nothing legible survives — callers reject rather than
 * store an empty name.
 */
export const VISITOR_DISPLAY_NAME_MAX = 120;

// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g;

export function visitorDisplayName(name: string | null | undefined): string | null {
  if (name == null) {
    return null;
  }
  const stripped = name.replace(UNSAFE_NAME_CHARS, '').trim();
  if (stripped === '') {
    return null;
  }
  // Trim again: slicing at the cap can leave a trailing space.
  const capped = stripped.slice(0, VISITOR_DISPLAY_NAME_MAX).trim();
  return capped === '' ? null : capped;
}

// ---- the capability link ----

/**
 * DEC-063 — the 64-hex code IS the visitor's credential (256 bits from
 * `random_bytes(32)`). Lowercase only: the server route is constrained to
 * `[a-f0-9]{64}`, so an uppercase code would 404 at routing, and accepting it
 * here would produce a request the client believes is well-formed.
 *
 * JavaScript's `$` does not match before a trailing newline (unlike PCRE), so
 * this anchoring is exact — see MANDATORY fix 13 on why that matters.
 */
export function isPublicChatCode(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** FR-PCHAT-007 — the SPA route the partner delivers to the customer. */
export function publicChatLinkPath(code: string): string {
  return `/support/${code}`;
}

// ---- composer gating ----

/**
 * Why the composer is shut, rather than a bare boolean — the UI needs to show
 * the right sentence, and "closed", "paused" and "you are signed in" are three
 * very different messages to a customer.
 */
export type PublicChatComposerState = 'enabled' | 'expired' | 'closed' | 'disabled' | 'signed_in';

export interface PublicChatComposerContext {
  /** `publicchat.enabled`. FR-PCHAT-034: off stops writes, never reads. */
  feature_enabled: boolean;
  /** Agents pass `publicChatStatusPublic(room.status)`; API-210 sends it directly. */
  status_public: PublicChatStatusPublic;
  /**
   * FR-PCHAT-013 — set only when a valid active-member bearer was presented on
   * the visitor route. An agent who opens the customer link reads as the
   * visitor but must NOT write as one, so the composer is replaced rather than
   * repurposed (MANDATORY graft 18).
   */
  viewer?: PublicChatViewer | null;
  /**
   * Staff rooms carry `expires_at`; API-210 does not, because an expired link
   * returns 410 for the whole route (FR-PCHAT-012) — there is no view to gate.
   */
  expires_at?: string | null;
}

/**
 * FR-PCHAT-012 — mirrors the server's `can_send` exactly: feature enabled AND
 * not expired AND `status_public === 'open'` AND the viewer is not a signed-in
 * member. The server stays authoritative (every write is re-checked there);
 * this only decides what the UI shows.
 *
 * Precedence is most-permanent-first — an expired link is dead whatever the
 * ticket says, and a closed ticket outranks a temporarily paused feature —
 * so the sentence the reader gets is the one that will still be true tomorrow.
 */
export function publicChatComposerState(ctx: PublicChatComposerContext, now: number = Date.now()): PublicChatComposerState {
  if (ctx.expires_at != null) {
    const expiresAt = Date.parse(ctx.expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt <= now) {
      return 'expired';
    }
  }
  if (ctx.status_public === 'closed') {
    return 'closed';
  }
  if (!ctx.feature_enabled) {
    return 'disabled';
  }
  if (ctx.viewer != null) {
    return 'signed_in';
  }
  return 'enabled';
}

export function publicChatCanSend(ctx: PublicChatComposerContext, now: number = Date.now()): boolean {
  return publicChatComposerState(ctx, now) === 'enabled';
}

/**
 * The i18n key for the banner that replaces the composer, or null when the
 * composer is live. Apps interpolate `{name}` on `pchat.banner.signedIn` the
 * same way they already do for `room.secret.days` — `t()` does not interpolate.
 */
export function publicChatComposerBannerKey(state: PublicChatComposerState): string | null {
  return state === 'enabled' ? null : `pchat.banner.${state === 'signed_in' ? 'signedIn' : state}`;
}

/**
 * FR-PCHAT-034 — maps API-210's informational `closed_reason` onto a banner key.
 *
 * NOT the banner source of truth: drive the banner from
 * `publicChatComposerBannerKey(publicChatComposerState(...))`. The two CAN
 * disagree — a room that is both `done` and feature-off resolves to `closed`
 * here (permanence wins) while the server's `closed_reason` precedence is
 * unspecified — so pick one, and it should be the composer state, because that
 * is the value that also decides whether the input is rendered at all.
 */
export function publicChatClosedReasonKey(reason: PublicChatClosedReason | null): string | null {
  return reason === null ? null : `pchat.banner.${reason === 'done' ? 'closed' : 'disabled'}`;
}
