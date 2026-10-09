import { describe, expect, it } from 'vitest';
import { classifyLink, extractLinkCards, linkPreviewLabel, ticketLinkUrl, ticketReturnPath } from './link-cards.js';
import { meetingReturnPath } from './meeting.js';
import { roomPreviewText } from './room-list-presentation.js';
import type { RoomListItem } from '@banana-chat/shared';

const APP = 'https://chat.example.com';
const O = [APP];
const ULID = '01HZX3K9QW8N5T2V7B4C6D0EFG'.replace('G', 'H'); // 26 chars, valid alphabet
const HEX = 'a'.repeat(64);

describe('TC-CORE-069 classifyLink ticket', () => {
  it('ticket without ws', () => {
    expect(classifyLink(`${APP}/board/${ULID}`, O)).toEqual({ kind: 'ticket', ticketId: ULID.toLowerCase(), ws: null });
  });
  it('ticket with ws', () => {
    expect(classifyLink(`${APP}/board/${ULID}?ws=acme-1`, O)).toEqual({ kind: 'ticket', ticketId: ULID.toLowerCase(), ws: 'acme-1' });
  });
  it('lowercase and uppercase ULIDs normalise to lowercase (API ids are lowercase)', () => {
    expect(classifyLink(`${APP}/board/${ULID.toLowerCase()}`, O)).toEqual({ kind: 'ticket', ticketId: ULID.toLowerCase(), ws: null });
  });
  it('fragment is ignored', () => {
    expect(classifyLink(`${APP}/board/${ULID}#x`, O)).toMatchObject({ kind: 'ticket' });
  });
  it('rejects bad ULIDs (length, I/L/O/U, first char > 7)', () => {
    for (const bad of [ULID.slice(1), ULID + 'A', '8' + ULID.slice(1), 'I' + ULID.slice(1), ULID.slice(0, 25) + 'U', 'x']) {
      expect(classifyLink(`${APP}/board/${bad}`, O)).toEqual({ kind: 'internal-plain' });
    }
  });
  it('extra params, repeated ws, bad slug, uppercase slug -> internal-plain', () => {
    for (const q of ['?ws=a&x=1', '?x=1', '?ws=a&ws=b', '?ws=', '?ws=-a', '?ws=ACME', `?ws=${'a'.repeat(64)}`, '?ws=a%20b']) {
      expect(classifyLink(`${APP}/board/${ULID}${q}`, O)).toEqual({ kind: 'internal-plain' });
    }
  });
  it('trailing slash, subpath, encoded or case-changed path are not tickets', () => {
    for (const p of [`/board/${ULID}/`, `/board/${ULID}/x`, `/Board/${ULID}`, `/board/%30${ULID.slice(1)}`, `/board`, `/board/`]) {
      expect(classifyLink(`${APP}${p}`, O)).toEqual({ kind: 'internal-plain' });
    }
  });
  it('ws slug of 63 chars accepted', () => {
    expect(classifyLink(`${APP}/board/${ULID}?ws=${'a'.repeat(63)}`, O)).toMatchObject({ kind: 'ticket' });
  });
});

describe('TC-CORE-069 hostile hosts', () => {
  it('look-alike hosts are external, never ticket cards', () => {
    for (const host of ['https://chat.example.com.evil.com', 'https://evilchat.example.com', 'https://chat.example.co', 'https://chat-example.com', 'https://chat.example.com.']) {
      const r = classifyLink(`${host}/board/${ULID}`, O);
      // the trailing-dot FQDN is a different hostname string -> external, not a card
      expect(r?.kind).toBe('external');
    }
  });
  it('userinfo tricks never reach a card', () => {
    expect(classifyLink(`https://chat.example.com@evil.com/board/${ULID}`, O)).toBeNull();
    expect(classifyLink(`https://chat.example.com:pw@evil.com/board/${ULID}`, O)).toBeNull();
    // real app host with userinfo: no card, no preview
    expect(classifyLink(`https://u:p@chat.example.com/board/${ULID}`, O)).toEqual({ kind: 'internal-plain' });
    expect(classifyLink(`https://u@chat.example.com/meet/${HEX}`, O)).toEqual({ kind: 'internal-plain' });
    // userinfo on a foreign host is never previewed
    expect(classifyLink('https://u:p@evil.com/x', O)).toBeNull();
  });
  it('same hostname with another scheme/port is internal-plain, never external', () => {
    expect(classifyLink(`http://chat.example.com/board/${ULID}`, O)).toEqual({ kind: 'internal-plain' });
    expect(classifyLink(`https://chat.example.com:8443/board/${ULID}`, O)).toEqual({ kind: 'internal-plain' });
    expect(classifyLink('http://chat.example.com/anything', O)).toEqual({ kind: 'internal-plain' });
  });
  it('host case is normalised by URL (app host in caps still ours)', () => {
    expect(classifyLink(`https://CHAT.EXAMPLE.COM/board/${ULID}`, O)).toMatchObject({ kind: 'ticket' });
  });
  it('non http(s), garbage, over-long -> null', () => {
    for (const h of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.com/a', 'mailto:a@b.c', '//evil.com/board/x', 'not a url', '', `https://x.com/${'a'.repeat(2100)}`]) {
      expect(classifyLink(h, O)).toBeNull();
    }
  });
  it('external: plain http(s) ok, non-default port refused, default port accepted', () => {
    expect(classifyLink('https://news.example.org/a?b=1', O)).toEqual({ kind: 'external', url: 'https://news.example.org/a?b=1' });
    expect(classifyLink('http://news.example.org', O)?.kind).toBe('external');
    expect(classifyLink('https://news.example.org:443/x', O)?.kind).toBe('external');
    expect(classifyLink('https://news.example.org:8080/x', O)).toBeNull();
  });
  it('no app origins configured: nothing is internal, /board URLs are external', () => {
    expect(classifyLink(`${APP}/board/${ULID}`, [])?.kind).toBe('external');
  });
  it('invalid entries in appOrigins are ignored; several origins supported', () => {
    expect(classifyLink(`https://staging.example.com/board/${ULID}`, ['', 'nonsense', 'ftp://x', APP, 'https://staging.example.com/'])).toMatchObject({ kind: 'ticket' });
  });
});

describe('TC-CORE-070 meeting', () => {
  it('64 lowercase hex', () => {
    expect(classifyLink(`${APP}/meet/${HEX}`, O)).toEqual({ kind: 'meeting', code: HEX });
  });
  it('wrong length / uppercase / non-hex / trailing slash / query -> internal-plain', () => {
    for (const p of [`/meet/${HEX.slice(1)}`, `/meet/${HEX}a`, `/meet/${HEX.toUpperCase()}`, `/meet/${'g'.repeat(64)}`, `/meet/${HEX}/`, `/meet/${HEX}?x=1`, '/meet', '/meet/']) {
      expect(classifyLink(`${APP}${p}`, O)).toEqual({ kind: 'internal-plain' });
    }
  });
  it('other origin meeting URL is external', () => {
    expect(classifyLink(`https://evil.com/meet/${HEX}`, O)?.kind).toBe('external');
  });
});

describe('TC-CORE-071 other app paths stay internal-plain', () => {
  it('/support, /join, /, /rooms, /public-chat', () => {
    for (const p of [`/support/${HEX}`, '/support/abc', '/join/sometoken', '/', '/rooms/1', '/public-chat/x', '/login', '/api/v1/me']) {
      expect(classifyLink(`${APP}${p}`, O)).toEqual({ kind: 'internal-plain' });
    }
  });
});

describe('TC-CORE-072 extractLinkCards', () => {
  const t1 = `${APP}/board/${ULID}`;
  const t2 = `${APP}/board/${ULID.slice(0, 25)}J`;
  it('empty / no links', () => {
    expect(extractLinkCards('', O)).toEqual([]);
    expect(extractLinkCards('hello world', O)).toEqual([]);
  });
  it('bare url, with note', () => {
    expect(extractLinkCards(`please look\n${t1}`, O)).toEqual([{ kind: 'ticket', ticketId: ULID.toLowerCase(), ws: null, href: t1 }]);
  });
  it('first link wins; max=1 default', () => {
    expect(extractLinkCards(`${t1} and ${t2}`, O)).toHaveLength(1);
    expect(extractLinkCards(`https://a.example.org/x ${t1}`, O)[0].kind).toBe('external');
    expect(extractLinkCards(`${t1} ${t2}`, O, 2)).toHaveLength(2);
    expect(extractLinkCards(`${t1}`, O, 0)).toEqual([]);
  });
  it('internal-plain links are skipped; the next card-worthy link wins', () => {
    expect(extractLinkCards(`${APP}/support/${HEX} then ${t1}`, O)[0].kind).toBe('ticket');
    expect(extractLinkCards(`${APP}/support/${HEX} ${APP}/join/tok`, O)).toEqual([]);
  });
  it('markdown [text](url) links classify by href, not label', () => {
    expect(extractLinkCards(`[click](${t1})`, O)[0]).toMatchObject({ kind: 'ticket', href: t1 });
    expect(extractLinkCards(`[${t1}](https://evil.com/x)`, O)[0]).toMatchObject({ kind: 'external', url: 'https://evil.com/x' });
    expect(extractLinkCards('[x](javascript:alert(1))', O)).toEqual([]);
  });
  it('fenced code and inline code are skipped', () => {
    expect(extractLinkCards('```\n' + t1 + '\n```', O)).toEqual([]);
    expect(extractLinkCards('~~~\n' + t1 + '\n~~~', O)).toEqual([]);
    expect(extractLinkCards('`' + t1 + '`', O)).toEqual([]);
    expect(extractLinkCards('```\n' + t1 + '\n```\n' + t2, O)[0]).toMatchObject({ href: t2 });
  });
  it('an unclosed fence swallows the rest; a ~~~ does not close a ``` fence', () => {
    expect(extractLinkCards('```\ncode\n' + t1, O)).toEqual([]);
    expect(extractLinkCards('```\n~~~\n' + t1 + '\n```', O)).toEqual([]);
  });
  it('trailing punctuation is stripped like the renderer does', () => {
    expect(extractLinkCards(`see ${t1}.`, O)[0]).toMatchObject({ kind: 'ticket', href: t1 });
    expect(extractLinkCards(`(${t1})`, O)).toEqual([]); // ")" stays in the href exactly as the rendered link: no card
  });
  it('meeting card', () => {
    expect(extractLinkCards(`join ${APP}/meet/${HEX}`, O)[0]).toMatchObject({ kind: 'meeting', code: HEX });
  });
  it('look-alike host in body gives only an external card', () => {
    expect(extractLinkCards(`https://chat.example.com.evil.com/board/${ULID}`, O)[0].kind).toBe('external');
  });
  it('handles CRLF and huge input without throwing', () => {
    expect(extractLinkCards(`a\r\n${t1}\r\n`, O)).toHaveLength(1);
    expect(() => extractLinkCards('x '.repeat(50_000) + t1, O)).not.toThrow();
  });
});

describe('TC-CORE-073 return-path whitelist', () => {
  it('ticketReturnPath accepts only /board/<ULID>[?ws=slug]', () => {
    expect(ticketReturnPath(`/board/${ULID}`)).toBe(`/board/${ULID}`);
    expect(ticketReturnPath(`/board/${ULID}?ws=acme`)).toBe(`/board/${ULID}?ws=acme`);
    expect(ticketReturnPath(`/board/${ULID.toLowerCase()}`)).not.toBeNull();
    for (const bad of [null, '', '//evil.com', '/board/x', '/board', `/board/${ULID}?ws=`, `/board/${ULID}?ws=A`, `/board/${ULID}?ws=a&x=1`, `/board/${ULID}#x`, `/board/${ULID}/`, 'javascript:alert(1)', `https://evil.com/board/${ULID}`, `/board/${ULID}\n`, `/board/${ULID}?ws=a\n`, `/\\evil.com`]) {
      expect(ticketReturnPath(bad)).toBeNull();
    }
  });
  it('meetingReturnPath unchanged', () => {
    expect(meetingReturnPath(`/meet/${HEX}`)).toBe(`/meet/${HEX}`);
    expect(meetingReturnPath('//evil')).toBeNull();
  });
});

describe('TC-CORE-074 ticketLinkUrl', () => {
  it('round trips through classifyLink', () => {
    const url = ticketLinkUrl(APP, ULID, 'acme');
    expect(url).toBe(`${APP}/board/${ULID}?ws=acme`);
    expect(classifyLink(url, O)).toEqual({ kind: 'ticket', ticketId: ULID.toLowerCase(), ws: 'acme' });
    expect(ticketReturnPath(new URL(url).pathname + new URL(url).search)).not.toBeNull();
  });
  it('trailing slash on origin is tolerated', () => {
    expect(ticketLinkUrl(`${APP}/`, ULID, 'a')).toBe(`${APP}/board/${ULID}?ws=a`);
  });
});

describe('TC-CORE-075 room-list preview label', () => {
  const t1 = `${APP}/board/${ULID}`;
  const msg = (body: string, sender = 'u2'): RoomListItem['last_message'] =>
    ({ id: 'm', type: 'text', body, sender_id: sender, created_at: '2026-10-10T00:00:00Z' }) as unknown as RoomListItem['last_message'];
  const opts = { appOrigins: O, labels: { ticket: 'Ticket', meeting: 'Meeting' } };
  it('linkPreviewLabel', () => {
    expect(linkPreviewLabel(t1, O)).toBe('ticket');
    expect(linkPreviewLabel(`${APP}/meet/${HEX}`, O)).toBe('meeting');
    expect(linkPreviewLabel('https://news.example.org', O)).toBeNull();
    expect(linkPreviewLabel(`${APP}/support/${HEX}`, O)).toBeNull();
  });
  it('replaces only the URL with the label, keeps the note and the "คุณ:" prefix', () => {
    expect(roomPreviewText(msg(t1), 'u1', opts)).toBe('Ticket');
    expect(roomPreviewText(msg(`look ${t1}`, 'u1'), 'u1', opts)).toBe('คุณ: look Ticket');
    expect(roomPreviewText(msg(`join ${APP}/meet/${HEX}`), 'u1', opts)).toBe('join Meeting');
  });
  it('unchanged without options, for external links and for /support', () => {
    expect(roomPreviewText(msg(t1), 'u1')).toBe(t1);
    expect(roomPreviewText(msg('https://news.example.org/a'), 'u1', opts)).toBe('https://news.example.org/a');
    expect(roomPreviewText(msg(`${APP}/support/${HEX}`), 'u1', opts)).toBe(`${APP}/support/${HEX}`);
  });
  it('default labels carry the emoji', () => {
    expect(roomPreviewText(msg(t1), 'u1', { appOrigins: O })).toBe('🎫 Ticket');
  });
});
