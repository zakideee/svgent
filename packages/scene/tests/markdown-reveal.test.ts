/**
 * What a streamed Markdown table and its neighbours actually paint, instant by
 * instant.
 *
 * A table is several nodes per row — rules, fills, cells — and every one of
 * them is on the canvas from the first frame; what matters is when each one
 * shows. These checks resolve the animation with `inspectScene` and read the
 * opacity every leaf paints at, with its ancestors composed, so a rule or a
 * fill that shows ahead of the text it belongs to fails here.
 */

import { readFile } from "node:fs/promises";
import {
  createEngineAsync,
  type Engine,
  type InspectionBBox,
  type IRNode,
  inspectScene,
  type SceneInspection,
} from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  buildTimeline,
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  FONT_ALIAS,
  type SvgentProject,
  userLandingMs,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VISIBLE_OPACITY = 0.01;
/** Reveal moments are fractional milliseconds; sample either side of them. */
const EDGE_MS = 1;

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

type Leaf = {
  type: IRNode["type"];
  text: string;
  bbox: InspectionBBox["visualBBox"];
  /** Composed group opacity times, for text, the most visible unit. */
  opacity: number;
  /** For text: how many units paint; `null` for text without unit reveal. */
  visibleUnits: number | null;
  /** For unit-revealed text: each unit's ink box, in canvas coordinates. */
  unitBoxes: Array<InspectionBBox["visualBBox"] | null>;
};

/** Units with no ink of their own (spaces) carry no opacity or box. */
type UnitSample = { opacity?: number; bbox?: InspectionBBox["visualBBox"] };

/** One drawn node as a leaf, painting at `opacity` once its ancestors are composed. */
function leafOf(node: IRNode, bbox: InspectionBBox, opacity: number): Leaf {
  if (node.type !== "text") {
    return {
      type: node.type,
      text: "",
      bbox: bbox.visualBBox,
      opacity,
      visibleUnits: null,
      unitBoxes: [],
    };
  }
  const samples = (node as { unitAnimationSamples?: UnitSample[] }).unitAnimationSamples;
  const visible = samples?.filter((sample) => (sample.opacity ?? 0) * opacity > VISIBLE_OPACITY);
  // Unit boxes are laid out where layout put the node; move them with it.
  const layout = (node as { bbox?: InspectionBBox["visualBBox"] }).bbox ?? bbox.visualBBox;
  const dx = bbox.visualBBox.x - layout.x;
  const dy = bbox.visualBBox.y - layout.y;
  return {
    type: node.type,
    text: node.lines.map((line) => line.text).join("\n"),
    bbox: bbox.visualBBox,
    unitBoxes: (samples ?? []).map((sample) =>
      sample.bbox ? { ...sample.bbox, x: sample.bbox.x + dx, y: sample.bbox.y + dy } : null,
    ),
    opacity:
      samples === undefined
        ? opacity
        : opacity * Math.max(0, ...samples.map((sample) => sample.opacity ?? 0)),
    visibleUnits: visible === undefined ? null : visible.length,
  };
}

/** Every painted leaf inside one message, with composed opacity. */
function messageLeaves(inspection: SceneInspection, messageId: string): Leaf[] {
  const bboxes = new Map(
    inspection.bboxes.map((bbox) => [`${bbox.nodeId}\u0000${bbox.type}`, bbox] as const),
  );
  const leaves: Leaf[] = [];
  const walk = (node: IRNode, inherited: number, inside: boolean): void => {
    const opacity = inherited * (node.type === "group" ? (node.opacity ?? 1) : 1);
    const within = inside || (node.type === "group" && node.meta?.edit === messageId);
    if (node.type === "group") {
      for (const child of node.children ?? []) {
        walk(child, opacity, within);
      }
      return;
    }
    const bbox = bboxes.get(`${node.nodeId}\u0000${node.type}`);
    if (within && bbox !== undefined) {
      leaves.push(leafOf(node, bbox, opacity));
    }
  };
  walk(inspection.ir.root, 1, false);
  return leaves;
}

function painted(leaves: Leaf[]): Leaf[] {
  return leaves.filter((leaf) => leaf.opacity > VISIBLE_OPACITY);
}

function textLeaf(leaves: Leaf[], text: string): Leaf {
  const found = leaves.find((leaf) => leaf.type === "text" && leaf.text === text);
  if (found === undefined) {
    throw new Error(`no text "${text}" in the message`);
  }
  return found;
}

/**
 * Leaves that belong to a horizontal band: they overlap it and do not run far
 * past it, which leaves out the card the whole message sits on.
 */
function inBand(leaves: Leaf[], top: number, bottom: number): Leaf[] {
  const reach = (bottom - top) / 2;
  return leaves.filter(
    (leaf) =>
      leaf.bbox.y < bottom - 0.5 &&
      leaf.bbox.y + leaf.bbox.h > top + 0.5 &&
      leaf.bbox.y > top - reach &&
      leaf.bbox.y + leaf.bbox.h < bottom + reach,
  );
}

const TABLE = ["| Head | Right |", "| --- | ---: |", "| one | 1 |", "| two | 22 |"].join("\n");

function tableProject(surface: "app" | "tui", role: "assistant" | "user"): SvgentProject {
  return {
    ...DEFAULT_PROJECT,
    surface,
    messages: [{ id: "table", role, content: TABLE }],
  };
}

describe.each(["app", "tui"] as const)("streamed table on %s", (surface) => {
  const project = tableProject(surface, "assistant");
  const timing = () => {
    const timeline = buildTimeline(project, project.messages);
    const message = timeline.messages[0];
    if (message === undefined) {
      throw new Error("no message timing");
    }
    return message;
  };
  const cps = project.timing.agentTypingCps;
  /** When the tick at `offset` comes up. */
  const tickMs = (offset: number) => timing().startMs + (offset / cps) * 1_000;
  // Ticks: Head(4)+1, Right(5)+1 | one(3)+1, 1(1)+1 | two(3)+1, 22(2)+1 = 24.
  const FIRST_BODY_ROW = 11;
  const SECOND_BODY_ROW = 15;
  const TOTAL = 24;
  /** Half a tick: past one reveal moment and short of the next. */
  const halfTickMs = () => 500 / cps;
  const leavesAt = (timeMs: number) => {
    const scene = buildSvgentScene(project, 0, { engine });
    return messageLeaves(
      inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
      "table",
    );
  };

  it("budgets the default duration past the last cell", () => {
    const message = timing();
    expect(message.revealEndMs).toBeGreaterThanOrEqual(tickMs(TOTAL - 1));
  });

  it("shows nothing of the table before its first tick", () => {
    expect(painted(leavesAt(tickMs(0) - EDGE_MS))).toEqual([]);
  });

  it("keeps each body row, rules and all, hidden until its first cell", () => {
    const settled = leavesAt(timing().revealEndMs + 1_000);
    const first = textLeaf(settled, "one");
    const second = textLeaf(settled, "two");
    const firstBand = [first.bbox.y, first.bbox.y + first.bbox.h] as const;
    const secondBand = [second.bbox.y, second.bbox.y + second.bbox.h] as const;

    const beforeFirst = painted(leavesAt(tickMs(FIRST_BODY_ROW) - EDGE_MS));
    expect(beforeFirst.some((leaf) => leaf.text === "Head")).toBe(true);
    expect(inBand(beforeFirst, ...firstBand)).toEqual([]);
    expect(inBand(beforeFirst, ...secondBand)).toEqual([]);

    const afterFirst = painted(leavesAt(tickMs(FIRST_BODY_ROW) + halfTickMs()));
    expect(inBand(afterFirst, ...firstBand).length).toBeGreaterThan(0);
    expect(inBand(afterFirst, ...secondBand)).toEqual([]);

    const beforeSecond = painted(leavesAt(tickMs(SECOND_BODY_ROW) - EDGE_MS));
    expect(inBand(beforeSecond, ...secondBand)).toEqual([]);
  });

  it("streams a cell from its own offset", () => {
    // "one" starts at its row's tick: two of its three clusters show a tick later.
    const partway = leavesAt(tickMs(FIRST_BODY_ROW + 1) + halfTickMs());
    const cell = textLeaf(partway, "one");
    expect(cell.visibleUnits).toBe(2);
  });

  it("has every cell fully shown once the message ends", () => {
    const settled = painted(leavesAt(timing().revealEndMs));
    for (const text of ["Head", "Right", "one", "1", "two", "22"]) {
      const cell = textLeaf(settled, text);
      expect(cell.visibleUnits, text).toBe(Array.from(text.replace(/\s/gu, "")).length);
    }
  });
});

describe.each(["app", "tui"] as const)("sent user table on %s", (surface) => {
  it("lands whole rather than streaming", () => {
    const project = tableProject(surface, "user");
    const timeline = buildTimeline(project, project.messages);
    const message = timeline.messages[0];
    if (message === undefined) {
      throw new Error("no message timing");
    }
    const scene = buildSvgentScene(project, 0, { engine });
    const landed = userLandingMs(message) + 1_000;
    const leaves = messageLeaves(
      inspectScene(engine, scene.vnode, { skipValidation: true, timeMs: landed }),
      "table",
    );
    for (const text of ["Head", "Right", "one", "1", "two", "22"]) {
      const cell = textLeaf(painted(leaves), text);
      expect(cell.visibleUnits, text).toBeNull();
    }
  });
});

describe.each(["app", "tui"] as const)("struck text on %s", (surface) => {
  it("draws each stroke with its own cluster", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      messages: [{ id: "strike", role: "assistant", content: "keep ~~gone~~ kept" }],
    };
    const timeline = buildTimeline(project, project.messages);
    const message = timeline.messages[0];
    if (message === undefined) {
      throw new Error("no message timing");
    }
    const cps = project.timing.agentTypingCps;
    const tick = (offset: number) => message.startMs + (offset / cps) * 1_000;
    const scene = buildSvgentScene(project, 0, { engine });
    const strokesAt = (timeMs: number) =>
      painted(
        messageLeaves(
          inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
          "strike",
        ),
      ).filter((leaf) => leaf.type === "rect" && leaf.bbox.h <= 3);
    // "keep " is five ticks; "gone" follows.
    expect(strokesAt(tick(5) - EDGE_MS)).toEqual([]);
    expect(strokesAt(tick(6) + 500 / cps)).toHaveLength(2);
    const settled = strokesAt(message.revealEndMs + 1_000);
    expect(settled).toHaveLength(4);
    const text = textLeaf(
      painted(
        messageLeaves(
          inspectScene(engine, scene.vnode, {
            skipValidation: true,
            timeMs: message.revealEndMs + 1_000,
          }),
          "strike",
        ),
      ),
      "keep gone kept",
    );
    const left = Math.min(...settled.map((stroke) => stroke.bbox.x));
    const right = Math.max(...settled.map((stroke) => stroke.bbox.x + stroke.bbox.w));
    // The strokes cover the struck word and stay inside the line's box.
    expect(left).toBeGreaterThan(text.bbox.x);
    expect(right).toBeLessThan(text.bbox.x + text.bbox.w);
    for (const stroke of settled) {
      expect(stroke.bbox.y).toBeGreaterThan(text.bbox.y);
      expect(stroke.bbox.y).toBeLessThan(text.bbox.y + text.bbox.h);
    }
  });
});

/**
 * Struck text after units the source counts differently from the engine:
 * joined clusters (several code points, one unit) and collapsed blanks
 * (several spaces, one unit). In both, "a" is the fifth unit.
 */
const STRUCK_AFTER = [
  ["joined clusters", "😀 e\u0301 ~~ab~~ cd", "😀 e\u0301 ab cd"],
  ["collapsed blanks", "x  y   ~~ab~~ cd", "x y ab cd"],
] as const;

describe.each(
  (["app", "tui"] as const).flatMap((surface) =>
    STRUCK_AFTER.map(([label, content, shown]) => [surface, label, content, shown] as const),
  ),
)("struck text on %s after %s", (surface, _label, content, shown) => {
  it("puts each stroke on its own cluster, shown with it", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      messages: [{ id: "strike", role: "assistant", content }],
    };
    const message = buildTimeline(project, project.messages).messages[0];
    if (message === undefined) {
      throw new Error("no message timing");
    }
    const cps = project.timing.agentTypingCps;
    const tick = (cluster: number) => message.startMs + (cluster / cps) * 1_000;
    const scene = buildSvgentScene(project, 0, { engine });
    const leavesAt = (timeMs: number) =>
      painted(
        messageLeaves(
          inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
          "strike",
        ),
      );
    const strokes = (leaves: Leaf[]) =>
      leaves.filter((leaf) => leaf.type === "rect" && leaf.bbox.h <= 3);
    const settled = leavesAt(message.revealEndMs + 1_000);
    const line = textLeaf(settled, shown);
    const [a, b] = [line.unitBoxes[4], line.unitBoxes[5]];
    if (!a || !b) {
      throw new Error("no ink for the struck clusters");
    }
    const drawn = strokes(settled).sort((left, right) => left.bbox.x - right.bbox.x);
    expect(drawn).toHaveLength(2);
    for (const [stroke, glyph] of [
      [drawn[0], a],
      [drawn[1], b],
    ] as const) {
      const overlap =
        Math.min(right(stroke?.bbox), glyph.x + glyph.w) - Math.max(stroke?.bbox.x ?? 0, glyph.x);
      expect(overlap).toBeGreaterThan(glyph.w * 0.5);
    }
    // "a" is the fifth cluster: its stroke shows with it, and "b"'s after.
    expect(strokes(leavesAt(tick(4) - EDGE_MS))).toHaveLength(0);
    expect(strokes(leavesAt(tick(4) + 500 / cps))).toHaveLength(1);
  });
});

function right(box: InspectionBBox["visualBBox"] | undefined): number {
  return box === undefined ? 0 : box.x + box.w;
}

describe.each(["app", "tui"] as const)("stacked table on %s", (surface) => {
  it("closes the header only once its last cell comes up", () => {
    // Nine columns on a narrow canvas: stacked into one column.
    const content = [
      `| |${" Dup |".repeat(8)}`,
      `|${" --- |".repeat(9)}`,
      `| lead |${" word |".repeat(7)} last |`,
    ].join("\n");
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      appearance: { ...DEFAULT_PROJECT.appearance, canvasWidth: 640, fontScale: 1.4 },
      messages: [{ id: "stacked", role: "assistant", content }],
    };
    const message = buildTimeline(project, project.messages).messages[0];
    if (message === undefined) {
      throw new Error("no message timing");
    }
    const cps = project.timing.agentTypingCps;
    const tick = (offset: number) => message.startMs + (offset / cps) * 1_000;
    const scene = buildSvgentScene(project, 0, { engine });
    const rulesAt = (timeMs: number) =>
      painted(
        messageLeaves(
          inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
          "stacked",
        ),
      ).filter((leaf) =>
        leaf.type === "text"
          ? /^\+-+\+$/u.test(leaf.text)
          : leaf.bbox.h <= 1.5 && leaf.bbox.w > 100,
      );
    // Header ticks: the empty cell takes 1, each "Dup" 4; the last "Dup"
    // starts at 29 and its last character comes up at 31.
    const HEADER_CLOSES = 31;
    expect(rulesAt(tick(HEADER_CLOSES) - EDGE_MS)).toHaveLength(1);
    expect(rulesAt(tick(HEADER_CLOSES) + 500 / cps)).toHaveLength(2);
    // Body: "lead" from 33, seven "word"s, "last" from 73; its "t" at 76.
    const ROW_CLOSES = 76;
    expect(rulesAt(tick(ROW_CLOSES) - EDGE_MS)).toHaveLength(2);
    expect(rulesAt(tick(ROW_CLOSES) + 500 / cps)).toHaveLength(3);
  });
});

describe.each(["app", "tui"] as const)("inline code after joined clusters on %s", (surface) => {
  it("shows the chip with its first character", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      // Two family emoji (five code points each, one unit each), a space, the chip.
      messages: [{ id: "chip", role: "assistant", content: "👨‍👩‍👧👨‍👩‍👧 `chip`" }],
    };
    const message = buildTimeline(project, project.messages).messages[0];
    if (message === undefined) {
      throw new Error("no message timing");
    }
    const cps = project.timing.agentTypingCps;
    const tick = (cluster: number) => message.startMs + (cluster / cps) * 1_000;
    const scene = buildSvgentScene(project, 0, { engine });
    const chipsAt = (timeMs: number) =>
      painted(
        messageLeaves(inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }), "chip"),
      ).filter((leaf) => leaf.type === "rect" && leaf.bbox.h > 3 && leaf.bbox.w < 200);
    // The chip's first character is the third unit.
    expect(chipsAt(tick(3) - EDGE_MS)).toHaveLength(0);
    expect(chipsAt(tick(3) + 500 / cps).length).toBeGreaterThan(0);
  });
});
