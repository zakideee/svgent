/**
 * Geometry the scene has to satisfy however it is authored.
 *
 * The suite could already tell that a node existed, that its metadata was
 * right and that the bytes were reproducible. What kept breaking was none of
 * those: a picker landing on the lines above it, a composer growing over its
 * own conversation, a padding that moved content instead of reserving room,
 * a bubble that ignored what it held. Those are properties of the laid-out
 * result, and nothing here could see the laid-out result.
 *
 * `renderToLayoutTree` gives every node its computed box, so these are checks
 * on the real layout rather than on the tree that asks for it.
 */

import { readdir, readFile } from "node:fs/promises";
import { Canvas, createEngineAsync, type Engine, type LayoutNode, Text } from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  buildTimeline,
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  DRAFT_FONT_FEATURES,
  deserializeProject,
  FONT_ALIAS,
  MONO_FALLBACK,
  MONO_FONT,
  metricsFor,
  planComposerDraft,
  SANS_FALLBACK,
  SANS_FONT,
  type SvgentProject,
  TUI_CHAR_RATIO,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Rect = { x: number; y: number; width: number; height: number };

/** Layout rounds; a box may sit a fraction outside its parent and be fine. */
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

function metaOf(node: LayoutNode): Record<string, string> {
  return ((node.vnode as { props?: { meta?: Record<string, string> } }).props?.meta ??
    {}) as Record<string, string>;
}

function bottom(rect: Rect): number {
  return rect.y + rect.height;
}

function right(rect: Rect): number {
  return rect.x + rect.width;
}

function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < right(b) - SLACK_PX &&
    b.x < right(a) - SLACK_PX &&
    a.y < bottom(b) - SLACK_PX &&
    b.y < bottom(a) - SLACK_PX
  );
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - SLACK_PX &&
    inner.y >= outer.y - SLACK_PX &&
    right(inner) <= right(outer) + SLACK_PX &&
    bottom(inner) <= bottom(outer) + SLACK_PX
  );
}

/** Bands that decorate the window instead of holding any of its content. */
const DECORATION_BANDS = new Set(["backdrop", "shadow"]);

/** An empty box has no geometry to be wrong about. */
function isReal(rect: Rect): boolean {
  return rect.width > 0.5 && rect.height > 0.5;
}

function layoutOf(project: SvgentProject, pageIndex = 0, fullHeight = false): LayoutNode {
  const scene = buildSvgentScene(project, pageIndex, { engine, fullHeight });
  return engine.renderToLayoutTree(scene.vnode, { skipValidation: true }).root;
}

function findBand(root: LayoutNode): LayoutNode {
  let band: LayoutNode | undefined;
  const walk = (node: LayoutNode): void => {
    if (metaOf(node).band === "transcript") {
      band ??= node;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  if (!band) {
    throw new Error("no transcript band in the layout");
  }
  return band;
}

/** Message blocks in transcript order, with every node under each of them. */
function blocksIn(band: LayoutNode): Array<{ id: string; rect: Rect; descendants: LayoutNode[] }> {
  const blocks: Array<{ id: string; rect: Rect; descendants: LayoutNode[] }> = [];
  const collect = (node: LayoutNode, into: LayoutNode[]): void => {
    into.push(node);
    for (const child of node.children) {
      collect(child, into);
    }
  };
  const walk = (node: LayoutNode): void => {
    const meta = metaOf(node);
    const id = meta.edit;
    // Chrome fields carry edit keys too; only messages own a block. Timed
    // overlays (an opened highlight note) share column space with rows that
    // enter only after they fold — their safety is temporal, checked by the
    // composed-motion suite, not by one frame's boxes.
    if (id !== undefined && !id.startsWith("field:") && meta.overlay === undefined) {
      const descendants: LayoutNode[] = [];
      for (const child of node.children) {
        collect(child, descendants);
      }
      blocks.push({ id, rect: node.bbox, descendants });
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(band);
  return blocks;
}

/**
 * Leaves outside the band that paint into it. Containers are skipped — the
 * window and the backdrop legitimately span the whole canvas — as is anything
 * that swallows the band whole, which is what a background looks like.
 */
function intrudersInto(root: LayoutNode, band: LayoutNode): LayoutNode[] {
  const found: LayoutNode[] = [];
  const walk = (node: LayoutNode): void => {
    const meta = metaOf(node);
    const composerPanel = meta["composer-panel"];
    // A transient surface and everything under it is out of scope here: what
    // it paints at a given instant belongs to inspection-invariants, which
    // resolves the animation first. The subtree stops at the surface itself,
    // so there is nothing to carry down.
    const transient =
      (composerPanel !== undefined && composerPanel !== "base") ||
      meta["composer-surface"] === "picker" ||
      meta["composer-surface"] === "draft" ||
      meta["draft-root"] !== undefined;
    // The band itself, and the decoration around and behind the window: a
    // wallpaper and a drop shadow are not content that has escaped a band.
    if (node === band || DECORATION_BANDS.has(meta.band ?? "") || transient) {
      return;
    }
    if (node.children.length === 0) {
      if (isReal(node.bbox) && overlaps(node.bbox, band.bbox) && !contains(node.bbox, band.bbox)) {
        found.push(node);
      }
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

function describeNode(node: LayoutNode): string {
  const meta = metaOf(node);
  const box = node.bbox;
  return `${node.vnode.type}${meta.action ? `(${meta.action})` : ""} at [${box.x.toFixed(0)},${box.y.toFixed(0)} ${box.width.toFixed(0)}x${box.height.toFixed(0)}]`;
}

/** Every geometric rule, applied to one built scene. */
function expectSoundLayout(project: SvgentProject, label: string, fullHeight = false): void {
  const root = layoutOf(project, 0, fullHeight);
  const band = findBand(root);
  const blocks = blocksIn(band);
  expect(blocks.length, `${label}: no message blocks found`).toBeGreaterThan(0);
  const windowBottom = bottom(root.bbox) - Math.round(project.appearance.windowMargin);
  expect(
    bottom(band.bbox),
    `${label}: transcript band crosses the window's bottom edge`,
  ).toBeLessThanOrEqual(windowBottom + SLACK_PX);

  // A block that paints outside its own box runs into whatever comes next,
  // and its reserved height is what the scroll plan and the camera believe.
  for (const block of blocks) {
    for (const node of block.descendants) {
      if (!isReal(node.bbox)) {
        continue;
      }
      expect(
        contains(block.rect, node.bbox),
        `${label}: ${block.id} paints outside its block — ${describeNode(node)} vs block [${block.rect.x.toFixed(0)},${block.rect.y.toFixed(0)} ${block.rect.width.toFixed(0)}x${block.rect.height.toFixed(0)}]`,
      ).toBe(true);
    }
  }

  // The transcript is a stack. Two messages sharing rows means one of them is
  // drawn over the other.
  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    if (!previous || !current) {
      continue;
    }
    expect(
      current.rect.y >= bottom(previous.rect) - SLACK_PX,
      `${label}: ${current.id} starts at ${current.rect.y.toFixed(0)} inside ${previous.id} (ends ${bottom(previous.rect).toFixed(0)})`,
    ).toBe(true);
  }

  if (fullHeight) {
    const tail = blocks.at(-1);
    if (!tail) {
      throw new Error(`${label}: full-height layout has no tail block`);
    }
    const tailSlack = Math.abs(bottom(band.bbox) - bottom(tail.rect));
    const allowedTailSlack =
      project.surface === "tui" ? metricsFor(project).tuiLinePx + SLACK_PX : SLACK_PX;
    expect(
      tailSlack,
      `${label}: full-height band leaves more than row quantization after its tail`,
    ).toBeLessThanOrEqual(allowedTailSlack);
  }

  // Permanent chrome bands may never claim transcript rows. Expanded drafts
  // and pickers are deliberately excluded here: their VNodes contain every
  // mutually-exclusive state at once, while their actual collision contract
  // is checked after animation resolution in `inspection-invariants.test.ts`.
  // Keeping base chrome here preserves the allocation check without treating
  // a timeline as a static maximum envelope.
  //
  // App and TUI both resolve transient composer growth in time. Their
  // permanent header, base composer and footer still have a static allocation
  // contract, so keep that half of the invariant on both surfaces.
  const intruders = intrudersInto(root, band);
  expect(
    intruders.map(describeNode),
    `${label}: permanent chrome painting inside the transcript band`,
  ).toEqual([]);
}

/** The authored bounds, at both ends — where the constants stop holding. */
const EXTREMES: Array<{ name: string; appearance: Partial<SvgentProject["appearance"]> }> = [
  {
    name: "tight",
    appearance: { windowPaddingY: 0, windowPaddingX: 0, windowMargin: 0, spacingScale: 0.6 },
  },
  {
    name: "loose",
    appearance: { windowPaddingY: 80, windowPaddingX: 80, windowMargin: 140, spacingScale: 1.6 },
  },
  { name: "big type", appearance: { fontScale: 3.2, chromeScale: 1 } },
  { name: "big chrome", appearance: { fontScale: 1, chromeScale: 3 } },
  { name: "both large", appearance: { fontScale: 2.4, chromeScale: 2, windowPaddingY: 60 } },
  { name: "centred", appearance: { contentAlign: "center", windowPaddingY: 40 } },
];

const PICKER_SCRIPT: SvgentProject["messages"] = [
  { id: "u", role: "user", content: "Straighten these icons" },
  {
    id: "tool",
    role: "tool",
    content: "rg stroke-width src\nnpm test -- --runInBand",
    language: "bash",
  },
  {
    id: "choice",
    role: "choice",
    content: "How far should this go?",
    options: ["Safe", "Standard", "Aggressive"],
    chosenIndex: 1,
  },
  {
    id: "permission",
    role: "permission",
    content: "Update three snapshots and make them the baseline",
  },
  {
    id: "a",
    role: "assistant",
    content: "## Done\n\n- `stroke-width` unified\n- shapes untouched",
  },
];

describe("layout invariants", () => {
  it.each(["app", "tui"] as const)("holds for a default %s scene", (surface) => {
    expectSoundLayout({ ...DEFAULT_PROJECT, surface }, `default ${surface}`);
  });

  it.each(["app", "tui"] as const)("holds for pickers and tool output on %s", (surface) => {
    expectSoundLayout(
      { ...DEFAULT_PROJECT, surface, messages: PICKER_SCRIPT },
      `pickers ${surface}`,
    );
  });

  it.each(["app", "tui"] as const)("ends a full-height %s band at its last block", (surface) => {
    expectSoundLayout(
      { ...DEFAULT_PROJECT, surface, messages: PICKER_SCRIPT },
      `full-height ${surface}`,
      true,
    );
  });

  describe.each(["app", "tui"] as const)("%s optional lower bands", (surface) => {
    it.each([
      ["without composer", { composer: false }, {}],
      ["without footer", { footer: false }, {}],
      ["without composer or footer", { composer: false, footer: false }, { windowPaddingY: 0 }],
    ] as const)("holds %s", (name, display, appearance) => {
      expectSoundLayout(
        {
          ...DEFAULT_PROJECT,
          surface,
          messages: PICKER_SCRIPT,
          display: { ...DEFAULT_PROJECT.display, ...display },
          appearance: { ...DEFAULT_PROJECT.appearance, ...appearance },
        },
        `${surface} ${name}`,
      );
    });
  });

  // The axis the fixture corpus barely moves, and the one that produced the
  // padding-is-a-shove and picker-collision bugs.
  describe.each(["app", "tui"] as const)("%s at the authored bounds", (surface) => {
    it.each(
      EXTREMES.map((entry) => [entry.name, entry.appearance] as const),
    )("holds with %s", (name, appearance) => {
      expectSoundLayout(
        {
          ...DEFAULT_PROJECT,
          surface,
          messages: PICKER_SCRIPT,
          appearance: { ...DEFAULT_PROJECT.appearance, ...appearance },
        },
        `${surface} ${name}`,
      );
    });
  });

  it("holds for every fixture in the corpus", async () => {
    const dir = new URL("../../../fixtures/scripts/", import.meta.url);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of names) {
      const source = await readFile(new URL(name, dir), "utf8");
      const { project } = deserializeProject(source);
      expectSoundLayout(project, name);
    }
  });
});

describe("composer draft wrap planning", () => {
  it("uses the TUI paint font and does not reuse a sans-font cache entry", () => {
    const content = "Fix TOPIC. While you're in there, check DETAIL too. ".repeat(6).trimEnd();
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface: "tui",
      messages: [{ id: "wrap-font", role: "user", content }],
    };
    const timing = buildTimeline(project, project.messages).messages[0];
    if (!timing) {
      throw new Error("missing draft timing");
    }

    const geometry = { widthPx: 600, fontPx: 20, lineHeightPx: 31, engine };
    const sansPlan = planComposerDraft(timing, {
      ...geometry,
      font: SANS_FONT,
      fallback: SANS_FALLBACK,
      fallbackRatio: 0.62,
    });
    const tuiPlan = planComposerDraft(timing, {
      ...geometry,
      font: MONO_FONT,
      fallback: MONO_FALLBACK,
      fallbackRatio: TUI_CHAR_RATIO,
    });

    const probe = Canvas(
      { width: geometry.widthPx, height: 1_000 },
      Text(
        {
          width: geometry.widthPx,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: geometry.fontPx,
          lineHeightPx: geometry.lineHeightPx,
          fontFeatureSettings: DRAFT_FONT_FEATURES,
          wrap: "char",
          meta: { edit: "painted-tui-draft" },
        },
        content,
      ),
    );
    const root = engine.renderToLayoutTree(probe, { skipValidation: true }).root;
    let paintedLines: string[] | undefined;
    const walk = (node: LayoutNode): void => {
      if (metaOf(node).edit === "painted-tui-draft") {
        paintedLines = node.textLayout?.resolvedTextLayout?.lines.map((line) => line.text);
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(root);

    expect(paintedLines).toBeDefined();
    expect(sansPlan.lines).not.toEqual(paintedLines);
    expect(tuiPlan.lines).toEqual(paintedLines);
  });
});
