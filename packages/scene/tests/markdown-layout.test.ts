/**
 * Where Markdown tables and containers land once laid out.
 *
 * Column widths are decided from the finished table, so every row has to
 * share them; a table also has to stay inside the card or terminal body it
 * sits in, however narrow the canvas or large the type, by shrinking its
 * columns and, past a readable minimum, stacking into one column. These read
 * the settled frame with `inspectScene` rather than the vnode tree.
 */

import { readFile } from "node:fs/promises";
import {
  createEngineAsync,
  type Engine,
  type InspectionBBox,
  type IRNode,
  inspectScene,
} from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  bundledFallbackFonts,
  collectProjectCharacters,
  DEFAULT_PROJECT,
  FONT_ALIAS,
  metricsFor,
  type SvgentProject,
  spacePx,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SLACK_PX = 1.5;

let engine: Engine;

beforeAll(async () => {
  await initNodeWasm();
  const loadFont = async (file: string) => new Uint8Array(await readFile(bundledFontPath(file)));
  engine = await createEngineAsync({
    fonts: [
      {
        alias: FONT_ALIAS.sans,
        weight: 400,
        style: "normal",
        data: await loadFont("NotoSansJP-Regular.subset.woff2"),
      },
      {
        alias: FONT_ALIAS.mono,
        weight: 400,
        style: "normal",
        data: await loadFont("JetBrainsMono-Regular.woff2"),
      },
      ...(await bundledFallbackFonts((slot) => loadFont(BUNDLED_FONT_FILES[slot]))),
    ],
  });
});

afterAll(() => {
  engine?.dispose();
});

type Box = { x: number; y: number; w: number; h: number };
type Leaf = { type: IRNode["type"]; text: string; bbox: Box };
type Settled = { leaves: Leaf[]; message: Box };

type UnitSample = { bbox?: Box };

/**
 * Where a unit-revealed text actually paints: the union of its units' ink,
 * moved by however far the engine moved the node itself. The node's own box
 * is where layout put it, which is not always where its glyphs are drawn.
 */
function inkBox(node: IRNode, visual: Box): Box | null {
  const samples = (node as { unitAnimationSamples?: UnitSample[] }).unitAnimationSamples;
  const layout = (node as { bbox?: Box }).bbox;
  const inked = (samples ?? []).flatMap((sample) =>
    sample.bbox !== undefined && sample.bbox.w > 0 ? [sample.bbox] : [],
  );
  if (inked.length === 0 || layout === undefined) {
    return null;
  }
  const x = Math.min(...inked.map((box) => box.x));
  const y = Math.min(...inked.map((box) => box.y));
  const w = Math.max(...inked.map((box) => box.x + box.w)) - x;
  const h = Math.max(...inked.map((box) => box.y + box.h)) - y;
  return { x: x + visual.x - layout.x, y: y + visual.y - layout.y, w, h };
}

function leafOf(node: IRNode, box: Box): Leaf {
  return node.type === "text"
    ? {
        type: node.type,
        text: node.lines.map((line) => line.text).join("\n"),
        bbox: inkBox(node, box) ?? box,
      }
    : { type: node.type, text: "", bbox: box };
}

/** The settled frame of one message: its row's box and every leaf inside it. */
function settle(project: SvgentProject, messageId: string): Settled {
  const scene = buildSvgentScene(project, 0, { engine });
  const inspection = inspectScene(engine, scene.vnode, {
    skipValidation: true,
    timeMs: scene.durationMs,
  });
  const bboxes = new Map<string, InspectionBBox>(
    inspection.bboxes.map((bbox) => [`${bbox.nodeId}\u0000${bbox.type}`, bbox] as const),
  );
  const leaves: Leaf[] = [];
  let message: Box | undefined;
  const walk = (node: IRNode, inside: boolean): void => {
    const box = bboxes.get(`${node.nodeId}\u0000${node.type}`)?.visualBBox;
    const opens = node.type === "group" && node.meta?.edit === messageId;
    if (opens && box !== undefined) {
      message = box;
    }
    if (node.type === "group") {
      for (const child of node.children ?? []) {
        walk(child, inside || opens);
      }
    } else if (inside && box !== undefined) {
      leaves.push(leafOf(node, box));
    }
  };
  walk(inspection.ir.root, false);
  if (message === undefined) {
    throw new Error(`message ${messageId} not found`);
  }
  return { leaves, message };
}

function texts(settled: Settled, text: string): Leaf[] {
  return settled.leaves.filter((leaf) => leaf.type === "text" && leaf.text === text);
}

function text(settled: Settled, value: string): Leaf {
  const [found] = texts(settled, value);
  if (found === undefined) {
    throw new Error(`no text "${value}"`);
  }
  return found;
}

function right(box: Box): number {
  return box.x + box.w;
}

function projectWith(
  surface: "app" | "tui",
  content: string,
  appearance: Partial<SvgentProject["appearance"]> = {},
  role: "assistant" | "user" = "assistant",
): SvgentProject {
  return {
    ...DEFAULT_PROJECT,
    surface,
    appearance: { ...DEFAULT_PROJECT.appearance, ...appearance },
    messages: [{ id: "m", role, content }],
  };
}

const ALIGNED = [
  "| Left | Middle | Right |",
  "| :--- | :---: | ---: |",
  "| a | b | c |",
  "| wider text | wider text | wider text |",
].join("\n");

describe.each(["app", "tui"] as const)("table columns on %s", (surface) => {
  it("share one set of column positions across rows, with each column's alignment", () => {
    const settled = settle(projectWith(surface, ALIGNED), "m");
    const [leftWide, middleWide, rightWide] = texts(settled, "wider text");
    if (!leftWide || !middleWide || !rightWide) {
      throw new Error("expected three wide cells");
    }
    const a = text(settled, "a");
    const b = text(settled, "b");
    const c = text(settled, "c");
    // Left: shared start. Right: shared end. Middle: shared centre.
    expect(Math.abs(a.bbox.x - leftWide.bbox.x)).toBeLessThan(SLACK_PX + 1);
    expect(Math.abs(right(c.bbox) - right(rightWide.bbox))).toBeLessThan(SLACK_PX + 1);
    const centre = (box: Box) => box.x + box.w / 2;
    // A terminal centres on whole cells, so an odd remainder leaves half a cell.
    const cellSlack =
      surface === "tui" ? metricsFor(projectWith(surface, ALIGNED)).tuiCharPx / 2 : 0;
    expect(Math.abs(centre(b.bbox) - centre(middleWide.bbox))).toBeLessThan(
      SLACK_PX + 1 + cellSlack,
    );
    // Headers sit over their columns.
    expect(Math.abs(text(settled, "Left").bbox.x - a.bbox.x)).toBeLessThan(SLACK_PX + 1);
    expect(Math.abs(right(text(settled, "Right").bbox) - right(c.bbox))).toBeLessThan(SLACK_PX + 1);
  });
});

const WIDE = [
  "| Package | Description | Status | Owner | 日本語の列 |",
  "| --- | :---: | ---: | --- | --- |",
  "| scene | Timeline and declarative scene construction for both surfaces | **ok** | core | 表示の確認 |",
  "| render | Rasterizes to PNG and ~~GIF~~ WebP | `ok` | io | 絵文字 |",
].join("\n");

const UNBREAKABLE = [
  "| | Dup | Dup |",
  "| --- | --- | ---: |",
  `| ${"averyveryveryverylongunbreakabletoken_".repeat(3)} | x | 12 |`,
].join("\n");

/** Nine columns of words: more than any narrow canvas can give readable columns. */
const STACKED = [
  `| |${" Dup |".repeat(8)}`,
  `|${" --- |".repeat(9)}`,
  `| lead |${" word |".repeat(7)} last |`,
].join("\n");

const NARROW: Partial<SvgentProject["appearance"]> = { canvasWidth: 640, fontScale: 1.4 };
/** The "headline" preset's type and spacing: the card's padding grows with them. */
const HEADLINE: Partial<SvgentProject["appearance"]> = {
  fontScale: 4,
  spacingScale: 1.2,
  contentAlign: "center",
  messageAlign: "center",
};

/**
 * The horizontal room a message's content must stay inside: the app card less
 * its side padding, or the terminal row.
 */
function contentBounds(
  settled: Settled,
  project: SvgentProject,
): { left: number; right: number; isCard: (leaf: Leaf) => boolean } {
  if (project.surface === "tui") {
    return { left: settled.message.x, right: right(settled.message), isCard: () => false };
  }
  const card = settled.leaves
    .filter((leaf) => leaf.type === "rect")
    .reduce<Leaf | undefined>(
      (largest, leaf) =>
        largest === undefined || leaf.bbox.w * leaf.bbox.h > largest.bbox.w * largest.bbox.h
          ? leaf
          : largest,
      undefined,
    );
  if (card === undefined) {
    throw new Error("no card behind the message");
  }
  // The card's own side padding, which scales with the spacing.
  const inset = spacePx(metricsFor(project), 15);
  return {
    left: card.bbox.x + inset,
    right: right(card.bbox) - inset,
    // The card's fill and its outline share its box.
    isCard: (leaf) =>
      Math.abs(leaf.bbox.x - card.bbox.x) < SLACK_PX &&
      Math.abs(leaf.bbox.w - card.bbox.w) < SLACK_PX,
  };
}

const PLACEMENTS: Array<[string, string]> = [
  ["a wide table", WIDE],
  ["a table in a list", `- item\n\n  ${WIDE.replaceAll("\n", "\n  ")}`],
  ["a table in a quote", `> ${WIDE.replaceAll("\n", "\n> ")}`],
  ["a table in a list in a quote", `> - item\n>\n>   ${UNBREAKABLE.replaceAll("\n", "\n>   ")}`],
  [
    "a table five lists deep",
    `- one\n  - two\n    - three\n      - four\n        - five\n\n          ${WIDE.replaceAll("\n", "\n          ")}`,
  ],
];

/** Every drawn leaf but the card itself stays between the bounds. */
function expectInside(
  settled: Settled,
  bounds: ReturnType<typeof contentBounds>,
  label: string,
): void {
  for (const leaf of settled.leaves) {
    if (leaf.bbox.w === 0 || bounds.isCard(leaf)) {
      continue;
    }
    const name = `${label}: ${leaf.text || leaf.type}`;
    expect(leaf.bbox.x, name).toBeGreaterThanOrEqual(bounds.left - SLACK_PX);
    expect(right(leaf.bbox), name).toBeLessThanOrEqual(bounds.right + SLACK_PX);
  }
}

describe.each(["app", "tui"] as const)("tables on a narrow %s canvas", (surface) => {
  it.each(PLACEMENTS)("keeps %s inside the message", (_label, content) => {
    for (const appearance of [NARROW, HEADLINE]) {
      for (const role of ["assistant", "user"] as const) {
        const project = projectWith(surface, content, appearance, role);
        const settled = settle(project, "m");
        const bounds = contentBounds(settled, project);
        const label = `${role} @${appearance.fontScale}`;
        expectInside(settled, bounds, label);
        // Nothing is cut: every header and cell still shows.
        const shown = settled.leaves.map((leaf) => leaf.text.replaceAll("\n", "")).join(" ");
        for (const word of ["Package", "Owner", "core"]) {
          if (content.includes(word)) {
            expect(shown, `${label}: ${word}`).toContain(word);
          }
        }
      }
    }
  });

  it.each([
    [
      "emoji and joined clusters",
      "👍🏽 ok 👨‍👩‍👧 family status and many more words that wrap across lines 🎉 end",
      NARROW,
    ],
    ["collapsed blanks", "First.  Second sentence runs on   and on and then the end", NARROW],
    [
      "small terminal type",
      "Status of the nightly build and the many more words that follow it here",
      { canvasWidth: 640, fontScale: 1 },
    ],
    [
      "large terminal type",
      "Status of the nightly build and the many more words that follow it here",
      { canvasWidth: 640, fontScale: 2.6 },
    ],
    [
      "a chip across lines",
      "mixed text with a `long inline code chip that wraps over the line end` after",
      NARROW,
    ],
  ] as const)("keeps a streamed right-aligned cell with %s whole, one line per piece", (_label, cell, appearance) => {
    const settled = settle(
      projectWith(surface, `| A | B |\n| --- | ---: |\n| x | ${cell} |`, appearance),
      "m",
    );
    const pieces = settled.leaves.filter(
      (leaf) => leaf.type === "text" && leaf.text.length > 0 && !/^[|+\-\n]+$/u.test(leaf.text),
    );
    // Each piece is one visual line: nothing wraps a second time.
    for (const piece of pieces) {
      expect(piece.text, piece.text).not.toContain("\n");
    }
    const shown = pieces.map((piece) => piece.text).join("");
    const expected = cell.replaceAll("`", "").replace(/\s+/gu, "");
    expect(shown.replace(/\s+/gu, "")).toContain(expected);
  });

  it("stacks a table that cannot keep readable columns, labelling an empty header", () => {
    const settled = settle(projectWith(surface, STACKED, NARROW), "m");
    // Stacked: each header once, then each body cell under its column's label.
    const label = text(settled, "Column 1");
    expect(texts(settled, "Dup")).toHaveLength(16);
    const lead = text(settled, "lead");
    const last = text(settled, "last");
    expect(lead.bbox.y).toBeGreaterThan(label.bbox.y);
    expect(last.bbox.y).toBeGreaterThan(lead.bbox.y);
    // One column: the cells share a left edge.
    expect(Math.abs(last.bbox.x - lead.bbox.x)).toBeLessThan(SLACK_PX + 1);
  });
});

describe("TUI table rules", () => {
  it("draw each row's | rule exactly as tall as its tallest cell", () => {
    const project = projectWith("tui", WIDE, NARROW);
    const settled = settle(project, "m");
    const linePx = metricsFor(project).tuiLinePx;
    const rules = settled.leaves.filter(
      (leaf) => leaf.type === "text" && /^\|(\n\|)*$/u.test(leaf.text),
    );
    expect(rules.length).toBeGreaterThan(0);
    const cells = settled.leaves.filter(
      (leaf) => leaf.type === "text" && leaf.text.length > 0 && !/^[|+\-\n]+$/u.test(leaf.text),
    );
    // Rows wrap here, so every row closes with a border: top, one under the
    // header, and one under each of the two body rows.
    expect(rules.some((rule) => rule.text.includes("\n"))).toBe(true);
    const borders = settled.leaves.filter(
      (leaf) => leaf.type === "text" && /^\+[-+]+\+$/u.test(leaf.text),
    );
    expect(borders).toHaveLength(4);
    for (const rule of rules) {
      const lines = rule.text.split("\n").length;
      expect(Math.abs(rule.bbox.h - lines * linePx)).toBeLessThan(SLACK_PX);
      // No cell in this row runs below its rule.
      for (const cell of cells) {
        if (cell.bbox.y >= rule.bbox.y - SLACK_PX && cell.bbox.y < rule.bbox.y + rule.bbox.h) {
          expect(cell.bbox.y + cell.bbox.h).toBeLessThanOrEqual(
            rule.bbox.y + rule.bbox.h + SLACK_PX,
          );
        }
      }
    }
  });
});

describe.each(["app", "tui"] as const)("nested containers on %s", (surface) => {
  it("indents list and quote content and keeps a nested list inside its item", () => {
    const settled = settle(
      projectWith(surface, "- parent\n  - child\n\n> first\n>\n> > second", NARROW),
      "m",
    );
    const parent = text(settled, "parent");
    const child = text(settled, "child");
    expect(child.bbox.x).toBeGreaterThan(parent.bbox.x + SLACK_PX);
    expect(child.bbox.y).toBeGreaterThan(parent.bbox.y);
    const first = text(settled, "first");
    const second = text(settled, "second");
    expect(second.bbox.x).toBeGreaterThan(first.bbox.x + SLACK_PX);
  });
});

describe("glyph collection without an engine", () => {
  it("requests every character Markdown puts on screen, in both table layouts", () => {
    const content = [
      "&copy; &#x2603; ![図](https://example.test/a.png) ~~消~~",
      "",
      "- [x] 済",
      "",
      STACKED,
      "",
      "| 表 | ☃ |",
      "| --- | --- |",
      "| 字 | 👍 |",
    ].join("\n");
    for (const surface of ["app", "tui"] as const) {
      const requested = collectProjectCharacters(projectWith(surface, content, NARROW));
      for (const character of ["©", "☃", "図", "消", "済", "表", "字", "👍"]) {
        expect(requested, `${surface}: ${character}`).toContain(character);
      }
      // Generated labels are plain ASCII, which is always requested.
      for (const character of "[image]Column 1|+-x") {
        expect(requested).toContain(character);
      }
    }
  });
});

describe("bubble width beside a table", () => {
  it("still counts a code block's piped line", () => {
    const code = "```sh\nrg -n TODO src | sort | uniq -c | sort -rn | head -n 20 | cut -c1-80\n```";
    const table = "| A | B |\n| --- | --- |\n| x | y |";
    const withTable = projectWith("app", `${table}\n\n${code}`, {}, "user");
    const without = projectWith("app", code, {}, "user");
    const width = (project: SvgentProject) => {
      const bounds = contentBounds(settle(project, "m"), project);
      return bounds.right - bounds.left;
    };
    expect(width(withTable)).toBeGreaterThanOrEqual(width(without) - SLACK_PX);
  });

  it.each([
    [
      "indented code that looks like a table",
      "    left side of a long pipeline | right side of a long pipeline\n    --- | ---",
    ],
    [
      "rows whose cell counts do not match",
      "a long first row of prose that is not a table | b\n--- | --- | ---",
    ],
  ])("does not mistake %s for one", (_label, body) => {
    const table = "| A | B |\n| --- | --- |\n| x | y |";
    const withTable = projectWith("app", `${table}\n\n${body}`, {}, "user");
    const without = projectWith("app", body, {}, "user");
    const width = (project: SvgentProject) => {
      const bounds = contentBounds(settle(project, "m"), project);
      return bounds.right - bounds.left;
    };
    expect(width(withTable)).toBeGreaterThanOrEqual(width(without) - SLACK_PX);
  });
});
