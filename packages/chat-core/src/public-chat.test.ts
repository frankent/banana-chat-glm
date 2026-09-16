import { describe, it, expect } from 'vitest';
import {
  PUBLIC_CHAT_STATUSES,
  VISITOR_DISPLAY_NAME_MAX,
  agentExternalName,
  comparePublicChatRooms,
  filterPublicChatRooms,
  isPublicChatCode,
  matchesPublicChatFilters,
  needsReply,
  publicChatCanSend,
  publicChatClaimState,
  publicChatClosedReasonKey,
  publicChatComposerBannerKey,
  publicChatComposerState,
  publicChatLinkPath,
  publicChatStatusLabel,
  publicChatStatusLabelKey,
  publicChatStatusPublic,
  publicChatStatusPublicLabel,
  publicChatStatusTone,
  sortPublicChatQueue,
  visitorDisplayName,
} from './public-chat.js';
import type { PublicChatRoomLike } from './public-chat.js';
import { t } from '@banana-chat/shared';

const ME = '01JBME00000000000000000000';
const OTHER = '01JBOTHER0000000000000000A';

function room(overrides: Partial<PublicChatRoomLike> = {}): PublicChatRoomLike {
  return {
    id: '01JB0000000000000000000001',
    status: 'new',
    assigned_to: null,
    last_visitor_seq: 0,
    last_agent_seq: 0,
    customer_name: 'Somchai',
    provider_name: 'Acme Insurance',
    external_ref: null,
    last_message_at: '2026-09-16T10:00:00Z',
    ...overrides,
  };
}

describe('TC-CORE-061 needsReply — last_visitor_seq > last_agent_seq and status is not done', () => {
  it('is true only while the customer spoke last', () => {
    expect(needsReply(room({ last_visitor_seq: 5, last_agent_seq: 4 }))).toBe(true);
    expect(needsReply(room({ last_visitor_seq: 4, last_agent_seq: 4 }))).toBe(false);
    expect(needsReply(room({ last_visitor_seq: 3, last_agent_seq: 9 }))).toBe(false);
    expect(needsReply(room({ last_visitor_seq: 0, last_agent_seq: 0 }))).toBe(false);
  });

  it('a resolved conversation is never owed a reply, however far the visitor is ahead', () => {
    expect(needsReply(room({ status: 'done', last_visitor_seq: 12, last_agent_seq: 1 }))).toBe(false);
    // `problem` is still an open conversation — it is flagged, not finished.
    expect(needsReply(room({ status: 'problem', last_visitor_seq: 12, last_agent_seq: 1 }))).toBe(true);
  });
});

describe('TC-CORE-062 filterPublicChatRooms — status, assignee (me/none/ULID), q and needsReply together', () => {
  const rooms: PublicChatRoomLike[] = [
    room({ id: '01A', status: 'new', assigned_to: null, customer_name: 'Somchai' }),
    room({ id: '01B', status: 'in_progress', assigned_to: { id: ME }, customer_name: 'Malee', last_visitor_seq: 4, last_agent_seq: 2 }),
    room({ id: '01C', status: 'problem', assigned_to: OTHER, customer_name: 'Niran', external_ref: 'TCK-4821' }),
    room({ id: '01D', status: 'done', assigned_to: { id: ME }, customer_name: 'Somchai', provider_name: 'Beta Bank' }),
  ];
  const ids = (list: PublicChatRoomLike[]): string[] => list.map((r) => r.id);

  it('filters by status (multi-select) and treats an empty selection as "all"', () => {
    expect(ids(filterPublicChatRooms(rooms, { status: ['new', 'problem'] }))).toEqual(['01A', '01C']);
    expect(ids(filterPublicChatRooms(rooms, { status: [] }))).toEqual(['01A', '01B', '01C', '01D']);
  });

  it('filters by assignee: me, none and a bare member ULID', () => {
    expect(ids(filterPublicChatRooms(rooms, { assignee: 'me', meId: ME }))).toEqual(['01B', '01D']);
    expect(ids(filterPublicChatRooms(rooms, { assignee: 'none' }))).toEqual(['01A']);
    expect(ids(filterPublicChatRooms(rooms, { assignee: OTHER }))).toEqual(['01C']);
    expect(ids(filterPublicChatRooms(rooms, { assignee: 'all', meId: ME }))).toEqual(['01A', '01B', '01C', '01D']);
  });

  it('fails closed on assignee "me" when no viewer id is known — never shows another agent\'s queue as yours', () => {
    expect(filterPublicChatRooms(rooms, { assignee: 'me', meId: null })).toEqual([]);
    expect(filterPublicChatRooms(rooms, { assignee: 'me' })).toEqual([]);
  });

  it('matches q case-insensitively over customer_name, provider_name and external_ref', () => {
    expect(ids(filterPublicChatRooms(rooms, { q: 'somchai' }))).toEqual(['01A', '01D']);
    expect(ids(filterPublicChatRooms(rooms, { q: 'beta' }))).toEqual(['01D']);
    expect(ids(filterPublicChatRooms(rooms, { q: 'tck-4821' }))).toEqual(['01C']);
    expect(ids(filterPublicChatRooms(rooms, { q: '   ' }))).toEqual(['01A', '01B', '01C', '01D']);
  });

  it('applies every filter at once (status + assignee + q + needsReply)', () => {
    expect(
      ids(filterPublicChatRooms(rooms, { status: ['in_progress', 'done'], assignee: 'me', meId: ME, q: 'malee', needsReply: true })),
    ).toEqual(['01B']);
    // Same filters, but the needs-reply toggle now excludes the only candidate.
    expect(
      filterPublicChatRooms(rooms, { status: ['done'], assignee: 'me', meId: ME, q: 'somchai', needsReply: true }),
    ).toEqual([]);
  });
});

describe('TC-CORE-063 agentExternalName — one definition of "provider (username)"', () => {
  it('composes the customer-facing agent label', () => {
    expect(agentExternalName('Acme Insurance', 'suda.k')).toBe('Acme Insurance (suda.k)');
  });

  it('trims and degrades gracefully rather than emitting empty parentheses', () => {
    expect(agentExternalName('  Acme Insurance  ', ' suda.k ')).toBe('Acme Insurance (suda.k)');
    expect(agentExternalName('Acme Insurance', '')).toBe('Acme Insurance');
    expect(agentExternalName('', 'suda.k')).toBe('suda.k');
  });
});

describe('TC-CORE-064 isPublicChatCode — exactly ^[a-f0-9]{64}$', () => {
  const code = 'a'.repeat(64);

  it('accepts a well-formed lowercase 64-hex code', () => {
    expect(isPublicChatCode(code)).toBe(true);
    expect(isPublicChatCode('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects uppercase, wrong lengths, trailing whitespace and a trailing newline', () => {
    expect(isPublicChatCode(code.toUpperCase())).toBe(false);
    expect(isPublicChatCode('a'.repeat(63))).toBe(false);
    expect(isPublicChatCode('a'.repeat(65))).toBe(false);
    expect(isPublicChatCode(`${code} `)).toBe(false);
    expect(isPublicChatCode(` ${code}`)).toBe(false);
    // JS `$` does not match before a trailing newline — MANDATORY fix 13.
    expect(isPublicChatCode(`${code}\n`)).toBe(false);
    expect(isPublicChatCode('g'.repeat(64))).toBe(false);
    expect(isPublicChatCode('')).toBe(false);
    expect(isPublicChatCode(null)).toBe(false);
    expect(isPublicChatCode(undefined)).toBe(false);
  });
});

describe('TC-CORE-065 visitorDisplayName — trim, cap 120, strip C0/C1 and U+200B–U+200F / U+202A–U+202E', () => {
  it('trims and passes ordinary names through unchanged', () => {
    expect(visitorName('  สมชาย ใจดี  ')).toBe('สมชาย ใจดี');
    expect(visitorName('Somchai')).toBe('Somchai');
  });

  it('strips C0/C1 control characters', () => {
    expect(visitorName('Som\u0000chai\u001F')).toBe('Somchai');
    expect(visitorName('Som\u007Fchai\u0085')).toBe('Somchai');
  });

  it('strips zero-width and bidi-override characters', () => {
    expect(visitorName('Som\u200Bchai')).toBe('Somchai');
    expect(visitorName('\u202ESomchai\u202A')).toBe('Somchai');
    expect(visitorName('Som\u200Echai\u200F')).toBe('Somchai');
  });

  it('caps at 120 characters and re-trims the cut edge', () => {
    expect(visitorName('x'.repeat(200))).toHaveLength(VISITOR_DISPLAY_NAME_MAX);
    expect(visitorName(`${'x'.repeat(119)}   y`)).toBe('x'.repeat(119));
  });

  it('is invalid (null) when nothing legible survives', () => {
    expect(visitorName('   ')).toBeNull();
    expect(visitorName('\u0000\u200B\u202E')).toBeNull();
    expect(visitorName('')).toBeNull();
    expect(visitorName(null)).toBeNull();
  });

  it('does not neuter markup — escaping is the renderer\'s job, ingest only strips control chars', () => {
    // TC-PCHAT-030's payload survives ingest as literal text and must render as
    // a plain text node on all three surfaces.
    expect(visitorName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('TC-CORE-066 publicChatStatusLabel / publicChatStatusTone — all four statuses x th/en', () => {
  // chat-core deliberately carries its own label table rather than importing the
  // shared translator at runtime (that import breaks apps/mobile's ts-jest — see
  // public-chat.ts). These assertions are what keeps the two from drifting: the
  // table must be byte-identical to the shared catalog in both locales.
  it('matches the shared pchat.status.* catalog exactly, for every status in both locales', () => {
    for (const status of PUBLIC_CHAT_STATUSES) {
      const key = publicChatStatusLabelKey(status);
      expect(key).toBe(`pchat.status.${status}`);
      for (const locale of ['th', 'en'] as const) {
        const catalog = t(key, locale);
        // `t()` echoes the key back when it is missing — that would be a broken catalog.
        expect(catalog).not.toBe(key);
        expect(publicChatStatusLabel(status, locale)).toBe(catalog);
      }
      expect(publicChatStatusLabel(status, 'th')).not.toBe(publicChatStatusLabel(status, 'en'));
    }
    expect(publicChatStatusLabel('in_progress', 'en')).toBe('In progress');
    // FR-I18N-001 — 'th' is the default locale, here as everywhere.
    expect(publicChatStatusLabel('new')).toBe(publicChatStatusLabel('new', 'th'));
  });

  it('matches the shared pchat.statusPublic.* catalog for the visitor projection', () => {
    for (const status of ['open', 'closed'] as const) {
      for (const locale of ['th', 'en'] as const) {
        const catalog = t(`pchat.statusPublic.${status}`, locale);
        expect(catalog).not.toBe(`pchat.statusPublic.${status}`);
        expect(publicChatStatusPublicLabel(status, locale)).toBe(catalog);
      }
    }
  });

  it('assigns one tone per status', () => {
    expect(publicChatStatusTone('new')).toBe('neutral');
    expect(publicChatStatusTone('in_progress')).toBe('info');
    expect(publicChatStatusTone('done')).toBe('ok');
    expect(publicChatStatusTone('problem')).toBe('warn');
  });
});

describe('TC-CORE-067 publicChatStatusPublic — problem never leaks to the visitor', () => {
  it('projects new/in_progress/problem to open and done to closed', () => {
    expect(publicChatStatusPublic('new')).toBe('open');
    expect(publicChatStatusPublic('in_progress')).toBe('open');
    expect(publicChatStatusPublic('problem')).toBe('open');
    expect(publicChatStatusPublic('done')).toBe('closed');
  });

  it('collapses every non-done status to exactly two visitor-visible values', () => {
    expect(new Set(PUBLIC_CHAT_STATUSES.map(publicChatStatusPublic))).toEqual(new Set(['open', 'closed']));
  });
});

describe('TC-CORE-068 queue order — problem, then needs-reply, then recency; and publicChatLinkPath', () => {
  it('puts problem rooms first, then rooms awaiting a reply, then everything else', () => {
    const quietProblem = room({ id: '01A', status: 'problem', last_message_at: '2026-09-01T00:00:00Z' });
    const waiting = room({ id: '01B', status: 'new', last_visitor_seq: 2, last_agent_seq: 0, last_message_at: '2026-09-02T00:00:00Z' });
    const chatty = room({ id: '01C', status: 'in_progress', last_message_at: '2026-09-16T23:00:00Z' });
    expect(sortPublicChatQueue([chatty, waiting, quietProblem]).map((r) => r.id)).toEqual(['01A', '01B', '01C']);
  });

  it('orders last_message_at DESC with NULLS LAST inside a tier', () => {
    const newest = room({ id: '01A', last_message_at: '2026-09-16T12:00:00Z' });
    const older = room({ id: '01B', last_message_at: '2026-09-10T12:00:00Z' });
    const never = room({ id: '01C', last_message_at: null });
    expect(sortPublicChatQueue([never, older, newest]).map((r) => r.id)).toEqual(['01A', '01B', '01C']);
  });

  it('breaks an exact tie by id DESC (ULIDs are time-ordered, so newest first)', () => {
    const a = room({ id: '01AAA', last_message_at: '2026-09-16T12:00:00Z' });
    const b = room({ id: '01BBB', last_message_at: '2026-09-16T12:00:00Z' });
    expect(sortPublicChatQueue([a, b]).map((r) => r.id)).toEqual(['01BBB', '01AAA']);
    expect(comparePublicChatRooms(a, a)).toBe(0);
  });

  it('never mutates the input list', () => {
    const input = [room({ id: '01A', last_message_at: null }), room({ id: '01B' })];
    sortPublicChatQueue(input);
    expect(input.map((r) => r.id)).toEqual(['01A', '01B']);
  });

  it('builds the capability link path', () => {
    const code = 'b'.repeat(64);
    expect(publicChatLinkPath(code)).toBe(`/support/${code}`);
    expect(isPublicChatCode(publicChatLinkPath(code).replace('/support/', ''))).toBe(true);
  });
});

describe('FR-PCHAT-009 publicChatClaimState', () => {
  it('reports unassigned, mine and other', () => {
    expect(publicChatClaimState(room({ assigned_to: null }), ME)).toBe('unassigned');
    expect(publicChatClaimState(room({ assigned_to: { id: ME } }), ME)).toBe('mine');
    expect(publicChatClaimState(room({ assigned_to: OTHER }), ME)).toBe('other');
    // Unknown viewer: an assigned room is somebody else's, never "mine".
    expect(publicChatClaimState(room({ assigned_to: { id: ME } }), null)).toBe('other');
  });
});

describe('FR-PCHAT-012/013/034 publicChatComposerState — why the composer is shut', () => {
  const NOW = Date.parse('2026-09-16T12:00:00Z');
  const open = { feature_enabled: true, status_public: 'open' as const, viewer: null };

  it('is enabled only when the feature is on, the link is live, the ticket is open and the viewer is a real visitor', () => {
    expect(publicChatComposerState(open, NOW)).toBe('enabled');
    expect(publicChatCanSend(open, NOW)).toBe(true);
    expect(publicChatComposerBannerKey('enabled')).toBeNull();
  });

  it('reports a closed ticket, a paused feature and a signed-in member distinctly', () => {
    expect(publicChatComposerState({ ...open, status_public: 'closed' }, NOW)).toBe('closed');
    expect(publicChatComposerState({ ...open, feature_enabled: false }, NOW)).toBe('disabled');
    expect(publicChatComposerState({ ...open, viewer: { kind: 'member', display_name: 'Suda' } }, NOW)).toBe('signed_in');
  });

  it('an expired link outranks every other reason and is evaluated first', () => {
    const expired = { ...open, expires_at: '2026-09-15T12:00:00Z' };
    expect(publicChatComposerState(expired, NOW)).toBe('expired');
    expect(publicChatComposerState({ ...expired, feature_enabled: false, status_public: 'closed' as const }, NOW)).toBe('expired');
    // Still in the future, and an unparseable/absent value never expires the room.
    expect(publicChatComposerState({ ...open, expires_at: '2026-10-16T12:00:00Z' }, NOW)).toBe('enabled');
    expect(publicChatComposerState({ ...open, expires_at: 'not-a-date' }, NOW)).toBe('enabled');
    expect(publicChatComposerState({ ...open, expires_at: null }, NOW)).toBe('enabled');
  });

  it('maps every shut state onto a banner key that exists in both catalogs', () => {
    for (const state of ['expired', 'closed', 'disabled', 'signed_in'] as const) {
      const key = publicChatComposerBannerKey(state);
      expect(key).not.toBeNull();
      expect(publicChatStatusLabelRaw(key as string, 'th')).not.toBe(key);
      expect(publicChatStatusLabelRaw(key as string, 'en')).not.toBe(key);
    }
  });
});

// -- local helpers: keep the assertions above readable --

function visitorName(value: string | null): string | null {
  return visitorDisplayName(value);
}

function publicChatStatusLabelRaw(key: string, locale: 'th' | 'en'): string {
  return t(key, locale);
}

// ===========================================================================
// Coverage completion — every remaining exported helper, plus the boundary and
// empty cases the blocks above leave implicit. Added as a second pass so the
// TC-CORE-061..068 assertions stay readable; nothing above is modified.
// ===========================================================================

describe('TC-CORE-069 PUBLIC_CHAT_STATUSES — the list itself is a contract, not an implementation detail', () => {
  it('is exactly the four statuses, in severity order, with no duplicates', () => {
    // The ORDER is load-bearing: PublicChatListPage renders the segmented
    // status control by mapping this array, and PublicChatRoomPage builds the
    // status <select> from it, so reordering silently reorders both controls.
    expect(PUBLIC_CHAT_STATUSES).toEqual(['new', 'in_progress', 'done', 'problem']);
    expect(PUBLIC_CHAT_STATUSES).toHaveLength(4);
    expect(new Set(PUBLIC_CHAT_STATUSES).size).toBe(PUBLIC_CHAT_STATUSES.length);
  });

  it('every member has a label, a tone and a visitor projection — no status is unhandled', () => {
    for (const status of PUBLIC_CHAT_STATUSES) {
      expect(publicChatStatusLabel(status, 'en')).not.toBe('');
      expect(publicChatStatusLabel(status, 'th')).not.toBe('');
      expect(['neutral', 'info', 'ok', 'warn']).toContain(publicChatStatusTone(status));
      expect(['open', 'closed']).toContain(publicChatStatusPublic(status));
    }
    // Four distinct tones — the pill must not render two statuses identically.
    expect(new Set(PUBLIC_CHAT_STATUSES.map(publicChatStatusTone)).size).toBe(4);
  });

  it('falls back to the FR-I18N-001 default locale rather than returning undefined', () => {
    // A locale outside the catalog (a stored preference from a future build)
    // must degrade to Thai, never to `undefined` rendered as text.
    const rogue = 'de' as unknown as 'th';
    expect(publicChatStatusLabel('problem', rogue)).toBe(publicChatStatusLabel('problem', 'th'));
    expect(publicChatStatusPublicLabel('open', rogue)).toBe(publicChatStatusPublicLabel('open', 'th'));
  });
});

describe('TC-CORE-070 publicChatClosedReasonKey — API-210 closed_reason → banner key', () => {
  it('maps done to the closed banner and disabled to the paused banner', () => {
    expect(publicChatClosedReasonKey('done')).toBe('pchat.banner.closed');
    expect(publicChatClosedReasonKey('disabled')).toBe('pchat.banner.disabled');
  });

  it('is null when the composer is live', () => {
    expect(publicChatClosedReasonKey(null)).toBeNull();
  });

  it('every key it can return exists in both catalogs', () => {
    for (const reason of ['done', 'disabled'] as const) {
      const key = publicChatClosedReasonKey(reason) as string;
      for (const locale of ['th', 'en'] as const) {
        // `t()` echoes an unknown key back — that would be a broken catalog.
        expect(t(key, locale)).not.toBe(key);
      }
    }
  });

  it('agrees with the composer state where both are defined, and documents where they do not', () => {
    const NOW = Date.parse('2026-09-16T12:00:00Z');
    // A closed ticket: both routes say "closed".
    expect(publicChatClosedReasonKey('done')).toBe(
      publicChatComposerBannerKey(publicChatComposerState({ feature_enabled: true, status_public: 'closed', viewer: null }, NOW)),
    );
    // The documented disagreement: a room that is BOTH done and feature-off.
    // The composer state resolves by permanence (closed), `closed_reason` is
    // whatever the server chose. The composer state is the source of truth —
    // it is the value that also decides whether the input renders at all.
    const bothShut = publicChatComposerState({ feature_enabled: false, status_public: 'closed', viewer: null }, NOW);
    expect(bothShut).toBe('closed');
    expect(publicChatClosedReasonKey('disabled')).not.toBe(publicChatComposerBannerKey(bothShut));
  });
});

describe('TC-CORE-071 matchesPublicChatFilters — the predicate itself, including the empty filter', () => {
  const ME_ROOM = room({ id: '01E', status: 'in_progress', assigned_to: { id: ME }, last_visitor_seq: 3, last_agent_seq: 1 });

  it('an empty filter object matches every room — "no filter" is not "no results"', () => {
    expect(matchesPublicChatFilters(ME_ROOM, {})).toBe(true);
    expect(filterPublicChatRooms([ME_ROOM], {})).toEqual([ME_ROOM]);
  });

  it('every filter key is independently optional — an absent key is never a rejection', () => {
    expect(matchesPublicChatFilters(ME_ROOM, { status: undefined })).toBe(true);
    expect(matchesPublicChatFilters(ME_ROOM, { assignee: undefined })).toBe(true);
    expect(matchesPublicChatFilters(ME_ROOM, { q: undefined })).toBe(true);
    expect(matchesPublicChatFilters(ME_ROOM, { needsReply: undefined })).toBe(true);
    // `needsReply: false` is the toggle OFF, which means "do not filter" — it
    // must NOT be read as "show only rooms that do not need a reply".
    expect(matchesPublicChatFilters(room({ last_visitor_seq: 0, last_agent_seq: 0 }), { needsReply: false })).toBe(true);
    expect(matchesPublicChatFilters(ME_ROOM, { needsReply: false })).toBe(true);
  });

  it('q matches an empty external_ref without throwing, and never matches a null ref as a substring', () => {
    const noRef = room({ id: '01F', external_ref: null, customer_name: 'Anan', provider_name: 'Gamma Co' });
    expect(matchesPublicChatFilters(noRef, { q: 'anan' })).toBe(true);
    expect(matchesPublicChatFilters(noRef, { q: 'null' })).toBe(false);
    expect(matchesPublicChatFilters(noRef, { q: 'TCK' })).toBe(false);
  });

  it('filtering an empty list is an empty list, whatever the filters', () => {
    expect(filterPublicChatRooms([], { status: ['new'], assignee: 'me', meId: ME, q: 'x', needsReply: true })).toEqual([]);
    expect(filterPublicChatRooms([], {})).toEqual([]);
  });

  it('never mutates the input list and preserves the incoming order', () => {
    const input = [room({ id: '01A' }), room({ id: '01B' }), room({ id: '01C' })];
    const out = filterPublicChatRooms(input, {});
    expect(out).not.toBe(input);
    expect(out.map((r) => r.id)).toEqual(['01A', '01B', '01C']);
    expect(input).toHaveLength(3);
  });

  it('status and assignee are ANDed, not ORed — a room must satisfy both', () => {
    // The room is in_progress AND mine. Either half alone passes; the wrong
    // half of either filter must reject it.
    expect(matchesPublicChatFilters(ME_ROOM, { status: ['in_progress'], assignee: 'me', meId: ME })).toBe(true);
    expect(matchesPublicChatFilters(ME_ROOM, { status: ['new'], assignee: 'me', meId: ME })).toBe(false);
    expect(matchesPublicChatFilters(ME_ROOM, { status: ['in_progress'], assignee: 'none' })).toBe(false);
    expect(matchesPublicChatFilters(ME_ROOM, { status: ['in_progress'], assignee: OTHER })).toBe(false);
  });
});

describe('TC-CORE-072 the external agent label vs. its visitor-side counterpart — the username must not cross', () => {
  // FR-PCHAT-014 states the asymmetry plainly: the VISITOR sees an agent as
  // "provider name (admin username)", and the AGENT sees the customer as the
  // customer's own name and nothing more. The customer has no username, is
  // never given one, and none of the internal identity may travel with them.
  const PROVIDER = 'Acme Insurance';
  const AGENT_USERNAME = 'suda.k';
  const CUSTOMER = 'สมชาย ใจดี';

  it('the agent label is exactly "provider name (admin username)"', () => {
    expect(agentExternalName(PROVIDER, AGENT_USERNAME)).toBe('Acme Insurance (suda.k)');
    expect(agentExternalName(PROVIDER, AGENT_USERNAME)).toContain(AGENT_USERNAME);
  });

  it('the visitor label is the customer name alone — no username, no parentheses, no provider', () => {
    const label = visitorDisplayName(CUSTOMER);
    expect(label).toBe(CUSTOMER);
    expect(label).not.toContain(AGENT_USERNAME);
    expect(label).not.toContain(PROVIDER);
    expect(label).not.toMatch(/[()]/);
  });

  it('the visitor composer has no username parameter to leak one through', () => {
    // Structural, not incidental: `agentExternalName` takes two arguments
    // (provider + username) and `visitorDisplayName` takes exactly one. There
    // is no call shape that puts an admin username onto a customer label.
    expect(agentExternalName).toHaveLength(2);
    expect(visitorDisplayName).toHaveLength(1);
  });

  it('a customer who types an agent-shaped name is still just a name, never an agent label', () => {
    // A customer is free to call themselves "Acme Insurance (suda.k)". It is
    // stored and rendered verbatim as a TEXT NODE — ingest strips control
    // characters, it does not rewrite, escape or reinterpret content
    // (MANDATORY fix 20: escaping is the renderer's job).
    const impostor = 'Acme Insurance (suda.k)';
    expect(visitorDisplayName(impostor)).toBe(impostor);
    // The defence is not the string: the visitor serializer sets sender_kind
    // server-side from the tier, so a visitor row can never be an agent row.
    // This assertion exists to pin the fact that chat-core does NOT sanitise
    // it, so nobody later mistakes ingest for the impersonation defence.
  });

  it('the visitor status vocabulary is disjoint from the internal one — "problem" has no visitor spelling', () => {
    for (const locale of ['th', 'en'] as const) {
      const internal = PUBLIC_CHAT_STATUSES.map((s) => publicChatStatusLabel(s, locale));
      const visitor = (['open', 'closed'] as const).map((s) => publicChatStatusPublicLabel(s, locale));
      for (const label of visitor) {
        expect(internal).not.toContain(label);
      }
      // Specifically: nothing a visitor can be shown spells "problem".
      expect(visitor).not.toContain(publicChatStatusLabel('problem', locale));
    }
  });
});

describe('TC-CORE-073 publicChatComposerState — the boundaries between the four shut reasons', () => {
  const NOW = Date.parse('2026-09-16T12:00:00Z');
  const open = { feature_enabled: true, status_public: 'open' as const, viewer: null };

  it('expiry is inclusive at the instant itself: expires_at === now is already expired', () => {
    expect(publicChatComposerState({ ...open, expires_at: new Date(NOW).toISOString() }, NOW)).toBe('expired');
    expect(publicChatComposerState({ ...open, expires_at: new Date(NOW + 1).toISOString() }, NOW)).toBe('enabled');
    expect(publicChatComposerState({ ...open, expires_at: new Date(NOW - 1).toISOString() }, NOW)).toBe('expired');
  });

  it('treats an absent viewer key the same as an explicit null — a genuine visitor either way', () => {
    expect(publicChatComposerState({ feature_enabled: true, status_public: 'open' }, NOW)).toBe('enabled');
    expect(publicChatComposerState({ ...open, viewer: undefined }, NOW)).toBe('enabled');
  });

  it('precedence runs most-permanent-first: expired > closed > disabled > signed_in', () => {
    const signedIn = { kind: 'member' as const, display_name: 'Suda' };
    // Each pair adds one MORE reason to the one before; the answer must not move.
    expect(publicChatComposerState({ ...open, status_public: 'closed', feature_enabled: false, viewer: signedIn }, NOW)).toBe('closed');
    expect(publicChatComposerState({ ...open, feature_enabled: false, viewer: signedIn }, NOW)).toBe('disabled');
    expect(publicChatComposerState({ ...open, viewer: signedIn }, NOW)).toBe('signed_in');
  });

  it('publicChatCanSend is true for exactly one state', () => {
    expect(publicChatCanSend(open, NOW)).toBe(true);
    expect(publicChatCanSend({ ...open, expires_at: '2020-01-01T00:00:00Z' }, NOW)).toBe(false);
    expect(publicChatCanSend({ ...open, status_public: 'closed' }, NOW)).toBe(false);
    expect(publicChatCanSend({ ...open, feature_enabled: false }, NOW)).toBe(false);
    expect(publicChatCanSend({ ...open, viewer: { kind: 'member', display_name: 'Suda' } }, NOW)).toBe(false);
  });

  it('defaults `now` to the wall clock, so a caller that omits it is not stuck at the epoch', () => {
    // Omitting `now` must not make every future link look expired (or every
    // past one look live). A link one day out is open; one day past is not.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(publicChatComposerState({ ...open, expires_at: tomorrow })).toBe('enabled');
    expect(publicChatComposerState({ ...open, expires_at: yesterday })).toBe('expired');
  });

  it('maps signed_in to the camelCase banner key the catalog actually holds', () => {
    // The state is snake_case (`signed_in`); the catalog key is `signedIn`.
    // Getting this wrong renders the raw key to a customer.
    expect(publicChatComposerBannerKey('signed_in')).toBe('pchat.banner.signedIn');
    expect(publicChatComposerBannerKey('expired')).toBe('pchat.banner.expired');
    expect(publicChatComposerBannerKey('closed')).toBe('pchat.banner.closed');
    expect(publicChatComposerBannerKey('disabled')).toBe('pchat.banner.disabled');
  });
});

describe('TC-CORE-074 claim state and queue order — the remaining edge and empty cases', () => {
  it('publicChatClaimState handles a bare ULID assignee and an unknown viewer', () => {
    expect(publicChatClaimState(room({ assigned_to: ME }), ME)).toBe('mine');
    expect(publicChatClaimState(room({ assigned_to: ME }), undefined)).toBe('other');
    expect(publicChatClaimState(room({ assigned_to: null }), undefined)).toBe('unassigned');
    // An empty-string assignee is a truthy-looking value that is NOT a ULID.
    // It must never read as "mine" for a viewer whose id is also unknown.
    expect(publicChatClaimState(room({ assigned_to: '' }), null)).toBe('other');
  });

  it('sorts an empty or single-element queue without touching it', () => {
    expect(sortPublicChatQueue([])).toEqual([]);
    const one = room({ id: '01A' });
    expect(sortPublicChatQueue([one]).map((r) => r.id)).toEqual(['01A']);
  });

  it('an unparseable last_message_at sorts as if it were null (NULLS LAST), never above a real timestamp', () => {
    const real = room({ id: '01A', last_message_at: '2026-09-10T12:00:00Z' });
    const broken = room({ id: '01B', last_message_at: 'not-a-date' });
    const missing = room({ id: '01C', last_message_at: null });
    // The real timestamp leads. The broken string and the null then TIE — both
    // are "no date" — so the final `id DESC` tiebreak decides between them,
    // which puts 01C ahead of 01B. That is the point: an unparseable date is
    // indistinguishable from a missing one, never a date in its own right.
    expect(sortPublicChatQueue([broken, missing, real]).map((r) => r.id)).toEqual(['01A', '01C', '01B']);
    expect(comparePublicChatRooms(broken, missing)).toBeGreaterThan(0);
    expect(comparePublicChatRooms(broken, real)).toBeGreaterThan(0);
  });

  it('is a consistent comparator: a<b implies b>a, and equal rooms tie at 0', () => {
    const flagged = room({ id: '01A', status: 'problem' });
    const quiet = room({ id: '01B', status: 'done' });
    expect(comparePublicChatRooms(flagged, quiet)).toBeLessThan(0);
    expect(comparePublicChatRooms(quiet, flagged)).toBeGreaterThan(0);
    expect(comparePublicChatRooms(flagged, { ...flagged })).toBe(0);
  });

  it('puts a problem room ahead of a needs-reply room even when the latter is newer', () => {
    // MANDATORY graft 19 — recency must never bury a flagged conversation.
    const flagged = room({ id: '01A', status: 'problem', last_message_at: '2020-01-01T00:00:00Z' });
    const waiting = room({ id: '01B', status: 'new', last_visitor_seq: 9, last_agent_seq: 0, last_message_at: '2026-09-16T23:59:00Z' });
    expect(sortPublicChatQueue([waiting, flagged]).map((r) => r.id)).toEqual(['01A', '01B']);
  });
});
