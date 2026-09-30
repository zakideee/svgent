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
    const inlines = parseInlineMarkdown(
      "See **result**, `code`, and [docs](https://example.test). ",
    );
    const types = inlines.map((inline) => inline.type);
    expect(types).toContain("strong");
    expect(types).toContain("code");
    expect(types).toContain("link");
    expect(JSON.stringify(inlines)).not.toContain("example.test");
  });

  it("counts code lines apart in plain text", () => {
    const blocks = parseMarkdown(["```ts", "const one = 1;", "const two = 2;", "```"].join("\n"));
    expect(markdownPlainText(blocks)).toBe("const one = 1;\nconst two = 2;");
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
