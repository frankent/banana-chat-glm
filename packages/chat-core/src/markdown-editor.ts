/** FR-KAN-006: platform-independent Markdown selection transformations. */
export type MarkdownAction =
  | "bold"
  | "italic"
  | "heading"
  | "list"
  | "quote"
  | "link"
  | "code";
export function editMarkdown(
  text: string,
  start: number,
  end: number,
  action: MarkdownAction,
) {
  const selected =
    text.slice(start, end) || (action === "link" ? "link text" : "text");
  const wrappers = {
    bold: ["**", "**"],
    italic: ["_", "_"],
    heading: ["## ", ""],
    list: ["- ", ""],
    quote: ["> ", ""],
    link: ["[", "](https://example.com)"],
    code: ["```\n", "\n```"],
  } as const;
  const [prefix, suffix] = wrappers[action];
  const block = ["heading", "list", "quote", "code"].includes(action);
  const before = block && start > 0 && text[start - 1] !== "\n" ? "\n" : "";
  const after = block && end < text.length && text[end] !== "\n" ? "\n" : "";
  const body =
    action === "list" || action === "quote"
      ? selected.replace(/\n/g, `\n${prefix}`)
      : selected;
  return {
    text:
      text.slice(0, start) +
      before +
      prefix +
      body +
      suffix +
      after +
      text.slice(end),
    start: start + before.length + prefix.length,
    end: start + before.length + prefix.length + body.length,
  };
}
