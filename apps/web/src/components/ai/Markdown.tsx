import { useState } from 'react';
import { parseInline, parseMarkdown } from '@banana-chat/chat-core';
import type { MdInlineNode } from '@banana-chat/chat-core';

/**
 * FR-AI-018 / TC-CORE-047 (closes DEC-041) — full GFM answer rendering:
 * headings, lists, tables, blockquotes, code fences (copy + language
 * label), links. The parser emits typed nodes and React escapes every
 * string — no raw HTML ever reaches the DOM. Links are http(s)-only
 * (parser) + rel="noopener noreferrer" (here).
 */

function Inline({ node }: { node: MdInlineNode }) {
  switch (node.type) {
    case 'strong':
      return <strong>{node.text}</strong>;
    case 'em':
      return <em>{node.text}</em>;
    case 'code':
      return <code className="rounded bg-slate-100 px-1 py-0.5 text-[0.85em] text-pink-600">{node.text}</code>;
    case 'link':
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-600 underline"
        >
          {node.text}
        </a>
      );
    default:
      return <>{node.text}</>;
  }
}

function InlineText({ text }: { text: string }) {
  return <>{parseInline(text).map((n, i) => <Inline key={i} node={n} />)}</>;
}

function CodeBlock({ lang, code }: { lang: string | null; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-1 overflow-hidden rounded bg-slate-800 text-xs">
      <div className="flex items-center justify-between border-b border-slate-700 px-2 py-0.5 text-[10px] text-slate-300">
        <span>{lang ?? 'text'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded px-1.5 py-0.5 text-slate-300 hover:bg-slate-700"
          aria-label="คัดลอกโค้ด"
        >
          {copied ? '✓ คัดลอกแล้ว' : 'คัดลอก'}
        </button>
      </div>
      <pre className="overflow-x-auto p-2 text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ content }: { content: string }) {
  const blocks = parseMarkdown(content);
  return (
    <div className="space-y-1">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'heading': {
            const sizes = ['text-base', 'text-sm', 'text-sm'] as const;
            const size = sizes[Math.min(b.level, 3) - 1];
            return (
              <p key={i} className={`${size} font-bold`}>
                <InlineText text={b.text} />
              </p>
            );
          }
          case 'code':
            return <CodeBlock key={i} lang={b.lang} code={b.code} />;
          case 'list':
            return b.ordered ? (
              <ol key={i} className="ml-4 list-decimal space-y-0.5">
                {b.items.map((item, j) => <li key={j}><InlineText text={item} /></li>)}
              </ol>
            ) : (
              <ul key={i} className="ml-4 list-disc space-y-0.5">
                {b.items.map((item, j) => <li key={j}><InlineText text={item} /></li>)}
              </ul>
            );
          case 'quote':
            return (
              <blockquote key={i} className="border-l-3 border-slate-300 pl-2 text-slate-500">
                <InlineText text={b.text} />
              </blockquote>
            );
          case 'table':
            return (
              <div key={i} className="overflow-x-auto">
                <table className="min-w-full border-collapse text-xs">
                  <thead>
                    <tr>
                      {b.header.map((h, j) => (
                        <th key={j} className="border border-slate-200 bg-slate-50 px-2 py-1 text-left font-semibold">
                          <InlineText text={h} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td key={k} className="border border-slate-200 px-2 py-1">
                            <InlineText text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'hr':
            return <hr key={i} className="border-slate-200" />;
          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                <InlineText text={b.text} />
              </p>
            );
        }
      })}
    </div>
  );
}
