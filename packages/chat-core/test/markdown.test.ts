import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../src/markdown.js';

/**
 * TC-CORE-047 — MarkdownFull sanitizer: script/iframe/raw html stay literal
 * text (the consumer escapes strings), table/code/link survive, links are
 * http(s)-only (noopener is applied by the renderer, not the parser).
 */
describe('TC-CORE-047 MarkdownFull', () => {
  it('renders paragraphs, code fences with language, headings', () => {
    const blocks = parseMarkdown('# Title\n\nplain text\n\n```php\necho 1;\n```');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'plain text' },
      { kind: 'code', lang: 'php', code: 'echo 1;' },
    ]);
  });

  it('keeps script/iframe/raw html as literal text nodes', () => {
    const blocks = parseMarkdown('<script>alert(1)</script>\n\n<iframe src="x"></iframe>');
    expect(blocks).toEqual([
      { kind: 'paragraph', text: '<script>alert(1)</script>' },
      { kind: 'paragraph', text: '<iframe src="x"></iframe>' },
    ]);
    // no block kind ever carries html — consumers escape strings
    expect(JSON.stringify(blocks)).not.toMatch(/"kind":\s*"(?!paragraph|code|heading|list|quote|table|hr)/);
  });

  it('renders tables with header + rows', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
    expect(blocks).toEqual([
      { kind: 'table', header: ['a', 'b'], rows: [['1', '2'], ['3', '4']] },
    ]);
  });

  it('renders ordered and unordered lists', () => {
    const blocks = parseMarkdown('- one\n- two\n\n1. first\n2. second');
    expect(blocks).toEqual([
      { kind: 'list', ordered: false, items: ['one', 'two'] },
      { kind: 'list', ordered: true, items: ['first', 'second'] },
    ]);
  });

  it('renders blockquotes and hr', () => {
    const blocks = parseMarkdown('> quoted\n> more\n\n---');
    expect(blocks).toEqual([
      { kind: 'quote', text: 'quoted\nmore' },
      { kind: 'hr' },
    ]);
  });

  it('unclosed fence swallows the rest (streaming mid-block)', () => {
    const blocks = parseMarkdown('before\n```js\nconst x = 1;');
    expect(blocks).toEqual([
      { kind: 'paragraph', text: 'before' },
      { kind: 'code', lang: 'js', code: 'const x = 1;' },
    ]);
  });

  it('inline: bold, italic, code, http link', () => {
    const nodes = parseInline('a **b** c *d* `e` [f](https://x.dev/g)');
    expect(nodes).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'strong', text: 'b' },
      { type: 'text', text: ' c ' },
      { type: 'em', text: 'd' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'e' },
      { type: 'text', text: ' ' },
      { type: 'link', href: 'https://x.dev/g', text: 'f' },
    ]);
  });

  it('inline: javascript:/data: link stays literal text (no href)', () => {
    const nodes = parseInline('click [here](javascript:alert) now');
    expect(nodes).toEqual([
      { type: 'text', text: 'click ' },
      { type: 'text', text: '[here](javascript:alert)' },
      { type: 'text', text: ' now' },
    ]);
  });
});
