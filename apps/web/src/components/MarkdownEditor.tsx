import { useLayoutEffect, useRef, useState } from "react";
import { editMarkdown, type MarkdownAction } from "@banana-chat/chat-core";
import { Markdown } from "./ai/Markdown";

/** FR-KAN-006 / TASK-WEB-044: accessible source editor and shared safe preview. */
export function MarkdownEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    if (selection.current && input.current) {
      input.current.focus();
      input.current.setSelectionRange(
        selection.current.start,
        selection.current.end,
      );
      selection.current = null;
    }
  }, [value]);
  const [preview, setPreview] = useState(false);
  const actions: [MarkdownAction, string, string][] = [
    ["bold", "Bold", "B"],
    ["italic", "Italic", "I"],
    ["heading", "Heading", "H"],
    ["list", "Bullet list", "≡"],
    ["quote", "Quote", "❝"],
    ["link", "Insert link", "↗"],
    ["code", "Code block", "</>"],
  ];
  function apply(action: MarkdownAction) {
    const area = input.current;
    if (!area) return;
    const edit = editMarkdown(
      value,
      area.selectionStart,
      area.selectionEnd,
      action,
    );
    if (edit.text.length > 20000) return;
    selection.current = edit;
    onChange(edit.text);
  }
  return (
    <div className="bc-md-editor">
      <div
        className="bc-md-toolbar"
        role="toolbar"
        aria-label="Markdown formatting"
      >
        {actions.map(([action, label, icon]) => (
          <button
            key={action}
            type="button"
            title={label}
            aria-label={label}
            disabled={disabled || preview}
            onClick={() => apply(action)}
          >
            {icon}
          </button>
        ))}
        <button
          type="button"
          className="bc-md-preview-toggle"
          aria-pressed={preview}
          onClick={() => setPreview(!preview)}
        >
          {preview ? "Write" : "Preview"}
        </button>
      </div>
      {preview ? (
        <div
          className="bc-md-preview bc-markdown"
          aria-label="Markdown preview"
        >
          <Markdown content={value || "_Nothing to preview yet._"} />
        </div>
      ) : (
        <textarea
          ref={input}
          aria-label="Description"
          rows={8}
          maxLength={20000}
          placeholder="Describe the work… Markdown supported."
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (
              (e.metaKey || e.ctrlKey) &&
              ["b", "i"].includes(e.key.toLowerCase())
            ) {
              e.preventDefault();
              apply(e.key.toLowerCase() === "b" ? "bold" : "italic");
            }
          }}
        />
      )}
      <small>Markdown · {value.length.toLocaleString()} / 20,000</small>
    </div>
  );
}
