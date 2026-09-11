import { describe, it, expect } from "vitest";
import { editMarkdown } from "./markdown-editor.js";
describe("TC-KAN-012 Markdown editing", () => {
  it("wraps selected text and preserves surrounding Thai text", () => {
    expect(editMarkdown("สวัสดี world!", 7, 12, "bold")).toEqual({
      text: "สวัสดี **world**!",
      start: 9,
      end: 14,
    });
  });
  it("inserts selectable placeholders and formats each selected line", () => {
    expect(editMarkdown("", 0, 0, "link")).toEqual({
      text: "[link text](https://example.com)",
      start: 1,
      end: 10,
    });
    expect(editMarkdown("one\ntwo", 0, 7, "list").text).toBe("- one\n- two");
    expect(editMarkdown("abc", 0, 3, "code").text).toBe("```\nabc\n```");
  });
});
