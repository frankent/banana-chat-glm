/**
 * MarkdownFull — GFM-subset markdown parser for AI assistant answers
 * (FR-AI-018, TC-CORE-047; closes DEC-041).
 *
 * Emits a typed block/inline tree instead of an HTML string: raw HTML,
 * <script>/<iframe> and every other tag stay literal text because the
 * consumer (React / React Native) escapes strings — XSS-safe by
 * construction. Links only resolve for http(s); javascript:/data: URLs
 * render as plain text.
 */

export type MdInlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'em'; text: string }
  | { type: 'link'; href: string; text: string };

export type MdBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; lang: string | null; code: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'hr' };

const FENCE_RE = /^```([A-Za-z0-9_+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const ORDERED_RE = /^\d+[.)]\s+(.*)$/;
const UNORDERED_RE = /^[-*+]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}[-:\s|]*\|/;

/** only http(s) hrefs become links — javascript:/data: stay literal text */
function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/** split a table row `| a | b |` into trimmed cells */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function parseMarkdown(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence !== null) {
      // unclosed fence swallows the rest — an in-flight stream renders as
      // a growing code block instead of raw backticks
      const lang = fence[1] === '' ? null : fence[1];
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        i += 1; // consume the closing fence
      }
      blocks.push({ kind: 'code', lang, code: code.join('\n') });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    if (HR_RE.test(line.trim())) {
      blocks.push({ kind: 'hr' });
      i += 1;
      continue;
    }

    // table: header row + |---|---| separator
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }

    // blockquote: consecutive `> ` lines
    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'quote', text: quoted.join('\n').trim() });
      continue;
    }

    // list: consecutive ordered or unordered items of the same flavour
    const orderedItem = line.match(ORDERED_RE);
    const unorderedItem = line.match(UNORDERED_RE);
    if (orderedItem !== null || unorderedItem !== null) {
      const ordered = orderedItem !== null;
      const itemRe = ordered ? ORDERED_RE : UNORDERED_RE;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(itemRe);
        if (m === null) {
          break;
        }
        items.push(m[1].trim());
        i += 1;
        // continuation lines (indented under an item) join that item
        if (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !itemRe.test(lines[i].trim())) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
        }
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // paragraph: consecutive plain lines until a blank or block opener
    const para: string[] = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE_RE.test(lines[i]) &&
      HEADING_RE.test(lines[i]) === false &&
      !HR_RE.test(lines[i].trim()) &&
      !/^>\s?/.test(lines[i]) &&
      ORDERED_RE.test(lines[i]) === false &&
      UNORDERED_RE.test(lines[i]) === false
    ) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: 'paragraph', text: para.join('\n').trim() });
  }

  return blocks;
}

const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

export function parseInline(text: string): MdInlineNode[] {
  const nodes: MdInlineNode[] = [];
  let at = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const start = match.index ?? 0;
    if (start > at) {
      nodes.push({ type: 'text', text: text.slice(at, start) });
    }
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      nodes.push({ type: 'strong', text: token.slice(2, -2) });
    } else if (token.startsWith('*')) {
      nodes.push({ type: 'em', text: token.slice(1, -1) });
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link !== null ? safeHref(link[2]) : null;
      if (link !== null && href !== null) {
        nodes.push({ type: 'link', href, text: link[1] });
      } else {
        nodes.push({ type: 'text', text: token }); // unsafe scheme → literal
      }
    }
    at = start + token.length;
  }
  if (at < text.length) {
    nodes.push({ type: 'text', text: text.slice(at) });
  }
  return nodes;
}
