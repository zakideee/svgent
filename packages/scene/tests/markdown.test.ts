import {
  highlightCode,
  markdownPlainText,
  parseInlineMarkdown,
  parseMarkdown,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

describe("markdown parser", () => {
  it("parses authored prose, lists, and fenced code without producing HTML", () => {
    const blocks = parseMarkdown(
      [
        "## Result",
        "",
        "- **Added** an empty state",
        "- Kept `space-6`",
        "",
        "```ts",
        "const ready = true;",
        "```",
      ].join("\n"),
    );

    expect(blocks.map((block) => block.type)).toEqual(["heading", "list", "code"]);
    expect(markdownPlainText(blocks)).toContain("Added");
    expect(markdownPlainText(blocks)).toContain("const ready = true;");
  });

  it("retains inline style roles while dropping link destinations from the scene", () => {
    const runs = parseInlineMarkdown("See **result**, `code`, and [docs](https://example.test). ");
    expect(runs.map((run) => run.style)).toContain("strong");
    expect(runs.map((run) => run.style)).toContain("code");
    expect(runs.map((run) => run.style)).toContain("link");
    expect(runs.map((run) => run.text).join("")).not.toContain("example.test");
  });

  it("assigns syntax token roles through Prism", () => {
    const lines = highlightCode("const count = 3;", "ts");
    expect(lines.flat().some((run) => run.token === "keyword")).toBe(true);
    expect(
      lines
        .flat()
        .map((run) => run.text)
        .join(""),
    ).toBe("const count = 3;");
  });
});
