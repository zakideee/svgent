/**
 * The Markdown contract, checked against svgent's own tree.
 *
 * Every case in `fixtures/markdown-contract.json` pins the text a body
 * displays and the reveal ticks it spends. The checks below pin the meaning of
 * the tree for the cases where the text alone could come out right for the
 * wrong reason. Nothing here looks at parser tokens or HTML, so the same file
 * holds for any parser behind `parseMarkdown`.
 */

import { readFileSync } from "node:fs";
import {
  type MarkdownBlock,
  type MarkdownInline,
  markdownPlainText,
  markdownRevealCharacters,
  parseInlineMarkdown,
  parseMarkdown,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

type ContractCase = {
  id: string;
  description: string;
  source: string;
  plainText: string;
  revealCharacters: number;
};

const CASES: ContractCase[] = JSON.parse(
  readFileSync(new URL("./fixtures/markdown-contract.json", import.meta.url), "utf8"),
).cases;

function blocksOf(id: string): MarkdownBlock[] {
  const found = CASES.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`No contract case "${id}"`);
  }
  return parseMarkdown(found.source);
}

function only<T>(values: T[]): T {
  expect(values).toHaveLength(1);
  const [value] = values;
  if (value === undefined) {
    throw new Error("Expected one value");
  }
  return value;
}

function block<Type extends MarkdownBlock["type"]>(
  value: MarkdownBlock | undefined,
  type: Type,
): Extract<MarkdownBlock, { type: Type }> {
  expect(value?.type).toBe(type);
  return value as Extract<MarkdownBlock, { type: Type }>;
}

/** Every inline node in document order, containers before their children. */
function flatten(inlines: MarkdownInline[]): MarkdownInline[] {
  return inlines.flatMap((inline) =>
    "children" in inline ? [inline, ...flatten(inline.children)] : [inline],
  );
}

describe("markdown contract corpus", () => {
  it("keeps every case id unique and every source inside the import limit", () => {
    expect(new Set(CASES.map((entry) => entry.id)).size).toBe(CASES.length);
    for (const entry of CASES) {
      expect(entry.source.length).toBeLessThanOrEqual(2_400);
    }
  });

  it.each(
    CASES.map((entry) => [entry.id, entry] as const),
  )("%s: displays and spends as specified", (_id, entry) => {
    const blocks = parseMarkdown(entry.source);
    expect(markdownPlainText(blocks), entry.description).toBe(entry.plainText);
    expect(markdownRevealCharacters(entry.source), entry.description).toBe(entry.revealCharacters);
  });
});

describe("markdown contract tree", () => {
  it("normalizes empty and blank bodies to one empty paragraph", () => {
    for (const id of ["empty", "whitespace", "reference-definition-only"]) {
      expect(blocksOf(id)).toEqual([{ type: "paragraph", children: [{ type: "text", text: "" }] }]);
    }
    expect(parseInlineMarkdown("")).toEqual([{ type: "text", text: "" }]);
  });

  it("keeps heading levels and forms", () => {
    expect(block(only(blocksOf("heading-six")), "heading").level).toBe(6);
    expect(block(only(blocksOf("setext")), "heading").level).toBe(1);
    const trimmed = block(only(blocksOf("heading-trim")), "heading");
    expect(trimmed.level).toBe(2);
    expect(trimmed.children).toEqual([{ type: "text", text: "Title" }]);
    expect(block(only(blocksOf("empty-heading")), "heading").level).toBe(3);
  });

  it("nests marks instead of flattening them to one style", () => {
    const paragraph = block(only(blocksOf("nested-marks")), "paragraph");
    const [both, , gone] = paragraph.children;
    expect(both?.type).toBe("emphasis");
    expect(both && "children" in both ? both.children[0]?.type : undefined).toBe("strong");
    expect(gone?.type).toBe("strikethrough");
    expect(gone && "children" in gone ? gone.children[0]?.type : undefined).toBe("strong");
    const underscore = block(only(blocksOf("underscore")), "paragraph");
    expect(underscore.children.map((inline) => inline.type)).toEqual([
      "emphasis",
      "text",
      "strong",
    ]);
  });

  it("decodes character references once, and never inside code", () => {
    expect(markdownPlainText(blocksOf("entities"))).toBe("& # A ©");
    expect(markdownPlainText(blocksOf("entity-once"))).toBe("&copy;");
    expect(markdownPlainText(blocksOf("escaped-entity"))).toBe("&copy;");
    const code = block(only(blocksOf("code-entity")), "paragraph");
    expect(code.children).toEqual([{ type: "code", text: "&copy; &#35;" }]);
  });

  it("decodes references beside raw HTML, and keeps blanks written as references", () => {
    expect(markdownPlainText(parseMarkdown("x <pre>&amp; y</pre> z"))).toBe("x <pre>& y</pre> z");
    expect(markdownPlainText(parseMarkdown("x <span>&amp;</span> z"))).toBe("x <span>&</span> z");
    // The tree keeps blanks written as references; the display, like the
    // engine, collapses blanks and drops them at a line's ends.
    expect(block(only(parseMarkdown("&#32;&#32;lead")), "paragraph").children).toEqual([
      { type: "text", text: "  lead" },
    ]);
    expect(markdownPlainText(parseMarkdown("&#32;&#32;lead"))).toBe("lead");
    expect(markdownPlainText(parseMarkdown("   lead   "))).toBe("lead");
    const broken = block(only(parseMarkdown("a\n&#32;&#32;b")), "paragraph").children;
    expect(broken).toEqual([
      { type: "text", text: "a" },
      { type: "softBreak" },
      { type: "text", text: "  b" },
    ]);
    expect(markdownPlainText(parseMarkdown("a  b\t\tc"))).toBe("a b c");
    expect(markdownRevealCharacters("a  b\t\tc")).toBe(5);
  });

  it("reads the tree it is given, not an earlier reading of it", () => {
    const blocks = parseMarkdown("hello world");
    expect(markdownPlainText(blocks)).toBe("hello world");
    const [first] = block(blocks[0], "paragraph").children;
    if (first?.type !== "text") {
      throw new Error("expected a text node");
    }
    first.text = "changed";
    expect(markdownPlainText(blocks)).toBe("changed");
  });

  it("separates hard and soft breaks", () => {
    for (const id of ["hard-break-spaces", "hard-break-backslash"]) {
      const paragraph = block(only(blocksOf(id)), "paragraph");
      expect(paragraph.children.map((inline) => inline.type)).toEqual([
        "text",
        "hardBreak",
        "text",
      ]);
    }
    const soft = block(only(blocksOf("soft-break")), "paragraph");
    expect(soft.children.map((inline) => inline.type)).toEqual(["text", "softBreak", "text"]);
  });

  it("keeps link labels and drops destinations", () => {
    const paragraph = block(only(blocksOf("link-nested")), "paragraph");
    const link = only(paragraph.children);
    expect(link.type).toBe("link");
    expect(link && "children" in link ? link.children[0]?.type : undefined).toBe("strong");
    expect(JSON.stringify(blocksOf("link-nested"))).not.toContain("example.test");
    expect(JSON.stringify(blocksOf("link-nested"))).not.toContain("title");
    for (const id of ["reference-full", "reference-collapsed", "reference-shortcut"]) {
      const resolved = only(blocksOf(id));
      expect(block(resolved, "paragraph").children[0]?.type).toBe("link");
      expect(JSON.stringify(resolved)).not.toContain("example.test");
    }
    const unresolved = block(only(blocksOf("reference-unresolved")), "paragraph");
    expect(flatten(unresolved.children).some((inline) => inline.type === "link")).toBe(false);
  });

  it("labels autolinks with their own address", () => {
    for (const id of ["autolink", "bare-url"]) {
      const paragraph = block(only(blocksOf(id)), "paragraph");
      expect(paragraph.children).toEqual([
        { type: "link", children: [{ type: "text", text: "https://example.test" }] },
      ]);
    }
  });

  it("turns images into labels without a source", () => {
    const withAlt = block(only(blocksOf("image-alt")), "paragraph");
    expect(withAlt.children).toEqual([{ type: "image", alt: "diagram" }]);
    const empty = block(only(blocksOf("image-empty")), "paragraph");
    expect(empty.children).toEqual([{ type: "image", alt: "" }]);
  });

  it("keeps list structure: start, looseness, empty items, nesting, tasks", () => {
    const started = block(only(blocksOf("list-start")), "list");
    expect(started.ordered).toBe(true);
    expect(started.start).toBe(7);
    const plus = block(only(blocksOf("list-plus")), "list");
    expect(plus.ordered).toBe(false);
    expect(plus.loose).toBe(false);
    const empty = block(only(blocksOf("list-empty")), "list");
    expect(empty.items).toHaveLength(2);
    expect(empty.items[0]?.children).toEqual([]);
    const loose = block(only(blocksOf("list-loose")), "list");
    expect(loose.loose).toBe(true);
    expect(loose.items[0]?.children.map((child) => child.type)).toEqual(["paragraph", "paragraph"]);
    const nested = block(only(blocksOf("list-nested")), "list");
    expect(nested.items[0]?.children.map((child) => child.type)).toEqual(["paragraph", "list"]);
    const tasks = block(only(blocksOf("task-list")), "list");
    expect(tasks.items.map((item) => item.task)).toEqual(["unchecked", "checked"]);
    expect(markdownPlainText([tasks])).toBe("todo\ndone");
  });

  it("nests quotes as containers of blocks", () => {
    const quote = block(only(blocksOf("quote-nested")), "quote");
    expect(quote.children.map((child) => child.type)).toEqual(["paragraph", "quote"]);
  });

  it("reads code fences and indented code", () => {
    expect(only(blocksOf("tilde-fence"))).toEqual({
      type: "code",
      language: "ts",
      text: "const ready = true;",
    });
    expect(block(only(blocksOf("unclosed-fence")), "code").text).toBe("one\ntwo");
    expect(only(blocksOf("indented-code"))).toEqual({
      type: "code",
      language: "text",
      text: "one\ntwo",
    });
    expect(only(blocksOf("rule"))).toEqual({ type: "rule" });
  });

  it("keeps table columns, alignment, and padded rows", () => {
    const basic = block(only(blocksOf("table-basic")), "table");
    expect(basic.align).toEqual(["left", "right"]);
    expect(basic.header).toHaveLength(2);
    expect(block(only(blocksOf("table-no-outer")), "table").align).toEqual([null, "center"]);
    const headOnly = block(only(blocksOf("table-head-only")), "table");
    expect(headOnly.rows).toEqual([]);
    const ragged = block(only(blocksOf("table-row-width")), "table");
    expect(ragged.rows.map((row) => row.length)).toEqual([2, 2]);
    expect(block(only(blocksOf("table-header-mismatch")), "paragraph").type).toBe("paragraph");
    const escaped = block(only(blocksOf("table-escape-code")), "table");
    expect(escaped.rows[0]?.[1]).toEqual([{ type: "code", text: "c|d" }]);
    const quoted = block(only(blocksOf("table-in-quote")), "quote");
    expect(quoted.children.map((child) => child.type)).toEqual(["table"]);
    const listed = block(only(blocksOf("table-in-list")), "list");
    expect(listed.items[0]?.children.map((child) => child.type)).toEqual(["paragraph", "table"]);
  });

  it("shows raw HTML as literal text", () => {
    const inline = block(only(blocksOf("html-inline")), "paragraph");
    expect(inline.children.filter((child) => child.type === "literal")).toHaveLength(2);
    expect(only(blocksOf("html-block"))).toEqual({
      type: "literal",
      text: "<script>\nexample()\n</script>",
    });
  });

  it("keeps footnotes as text rather than links or hidden definitions", () => {
    const [reference, definition] = blocksOf("footnote-literal");
    expect(
      flatten(block(reference, "paragraph").children).some((inline) => inline.type === "link"),
    ).toBe(false);
    expect(block(definition, "literal").text).toBe("[^1]: Note");
    const [, continued] = blocksOf("footnote-continuation");
    expect(block(continued, "literal").text).toBe("[^1]: Note\n    continued");
    expect(only(blocksOf("footnote-in-code"))).toEqual({
      type: "code",
      language: "text",
      text: "[^1]: Note",
    });
  });

  it("leaves unsupported extensions as ordinary content", () => {
    const [math, alert, diagram] = blocksOf("non-goals");
    expect(block(math, "paragraph").children).toEqual([{ type: "text", text: "$x$" }]);
    expect(block(alert, "quote").children[0]?.type).toBe("paragraph");
    expect(block(diagram, "code").language).toBe("mermaid");
  });

  it("returns a new tree per call, with no parser tokens in it", () => {
    const first = parseMarkdown("| A |\n| --- |\n| x |");
    const second = parseMarkdown("| A |\n| --- |\n| x |");
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    const serialized = JSON.stringify(first);
    for (const tokenField of ['"raw"', '"tokens"', '"href"', '"lang"', '"depth"']) {
      expect(serialized).not.toContain(tokenField);
    }
  });
});
