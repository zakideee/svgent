/**
 * Paint invariants that depend on the sampled animation state.
 *
 * Static allocation belongs to `layout-invariants.test.ts`. This suite asks
 * the engine where nodes actually paint after resolving the animation at a
 * given time and composing every ancestor transform. Keeping that operation
 * in boundsvg avoids duplicating its easing, fill and transform semantics.
 */

import { readFile } from "node:fs/promises";
import {
  type AnimationSpec,
  type AnyVNode,
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
  type BuiltScene,
  buildSvgentScene,
  buildTimeline,
  bundledFallbackFonts,
  choiceDraftTiming,
  DEFAULT_PROJECT,
  deserializeProject,
  FONT_ALIAS,
  type SvgentProject,
  sendMomentMs,
  userLandingMs,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type Rect = { x: number; y: number; width: number; height: number };

type InspectedNode = {
  node: IRNode;
  bbox: InspectionBBox;
  ownMeta: Record<string, string>;
  meta: Record<string, string>;
  effectiveOpacity: number;
  /**
   * Every clip between this node and the root, folded together. A stand-off
   * crops its column before it lifts it, so what a reader sees is the paint
   * inside all of them — not the paint inside the outermost one alone.
   */
  clip: Rect | null;
  children: InspectedNode[];
};

/** Geometry and scheduling both round at sub-pixel/sub-millisecond seams. */
const SLACK_PX = 1.5;
const EDGE_SAMPLE_MS = 1;
const VISIBLE_OPACITY = 0.001;
const DECORATION_BANDS = new Set(["backdrop", "shadow"]);

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

function childrenOf(node: IRNode): IRNode[] {
  return node.type === "group" ? (node.children ?? []) : [];
}

/** Join the semantic IR tree to the engine's positioned bbox facts. */
function inspectionTree(inspection: SceneInspection): InspectedNode {
  const bboxKey = (nodeId: string, type: IRNode["type"]): string => `${nodeId}\u0000${type}`;
  const bboxesByNode = new Map<string, InspectionBBox>();
  for (const bbox of inspection.bboxes) {
    const key = bboxKey(bbox.nodeId, bbox.type);
    if (bboxesByNode.has(key)) {
      throw new Error(`inspection has duplicate ${bbox.type} bbox for ${bbox.nodeId}`);
    }
    bboxesByNode.set(key, bbox);
  }
  let visited = 0;
  const walk = (
    node: IRNode,
    inheritedMeta: Record<string, string>,
    inheritedOpacity: number,
    inheritedClip: Rect | null,
  ): InspectedNode => {
    const bbox = bboxesByNode.get(bboxKey(node.nodeId, node.type));
    if (!bbox) {
      throw new Error(`inspection has no matching bbox for ${node.nodeId}`);
    }
    visited += 1;
    const ownMeta = node.type === "group" ? (node.meta ?? {}) : {};
    const meta = { ...inheritedMeta, ...ownMeta };
    const effectiveOpacity = inheritedOpacity * (node.type === "group" ? (node.opacity ?? 1) : 1);
    const ownClip = node.type === "group" ? node.clipPath : undefined;
    const clip = ownClip
      ? intersectClips(inheritedClip, transformRect(ownClip, bbox))
      : inheritedClip;
    return {
      node,
      bbox,
      ownMeta,
      meta,
      effectiveOpacity,
      clip,
      children: childrenOf(node).map((child) => walk(child, meta, effectiveOpacity, clip)),
    };
  };
  const root = walk(inspection.ir.root, {}, 1, null);
  if (visited !== inspection.bboxes.length) {
    throw new Error(`inspection has ${inspection.bboxes.length - visited} unpaired bboxes`);
  }
  return root;
}

function findBand(root: InspectedNode): InspectedNode {
  let band: InspectedNode | undefined;
  const walk = (node: InspectedNode): void => {
    if (node.ownMeta.band === "transcript") {
      band ??= node;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  if (!band) {
    throw new Error("no transcript band in the inspection");
  }
  return band;
}

function rectOf(bbox: InspectionBBox): Rect {
  return {
    x: bbox.visualBBox.x,
    y: bbox.visualBBox.y,
    width: bbox.visualBBox.w,
    height: bbox.visualBBox.h,
  };
}

/**
 * `clipPath` is stored in pre-transform layout coordinates. Project its four
 * corners through the same composed affine transform that inspectScene used
 * for the owner's `transformBox`; intersecting the raw coordinates would
 * leave a moving clip behind when its stand-off translates.
 */
function transformRect(
  rect: { x: number; y: number; w: number; h: number },
  owner: InspectionBBox,
): Rect {
  const layout = owner.layoutBBox;
  const [topLeft, topRight, , bottomLeft] = owner.transformBox.points;
  const project = (x: number, y: number): { x: number; y: number } => {
    const u = layout.w === 0 ? 0 : (x - layout.x) / layout.w;
    const v = layout.h === 0 ? 0 : (y - layout.y) / layout.h;
    return {
      x: topLeft.x + u * (topRight.x - topLeft.x) + v * (bottomLeft.x - topLeft.x),
      y: topLeft.y + u * (topRight.y - topLeft.y) + v * (bottomLeft.y - topLeft.y),
    };
  };
  const corners = [
    project(rect.x, rect.y),
    project(rect.x + rect.w, rect.y),
    project(rect.x + rect.w, rect.y + rect.h),
    project(rect.x, rect.y + rect.h),
  ];
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  };
}

function right(rect: Rect): number {
  return rect.x + rect.width;
}

function bottom(rect: Rect): number {
  return rect.y + rect.height;
}

function isReal(rect: Rect): boolean {
  return rect.width > 0.5 && rect.height > 0.5;
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x - SLACK_PX &&
    inner.y >= outer.y - SLACK_PX &&
    right(inner) <= right(outer) + SLACK_PX &&
    bottom(inner) <= bottom(outer) + SLACK_PX
  );
}

/** Clips compose by intersection; an empty result is a node that cannot paint. */
function intersectClips(outer: Rect | null, inner: Rect): Rect | null {
  if (outer === null) {
    return inner;
  }
  const x = Math.max(outer.x, inner.x);
  const y = Math.max(outer.y, inner.y);
  const x2 = Math.min(right(outer), right(inner));
  const y2 = Math.min(bottom(outer), bottom(inner));
  return { x, y, width: Math.max(0, x2 - x), height: Math.max(0, y2 - y) };
}

function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(right(a), right(b));
  const y2 = Math.min(bottom(a), bottom(b));
  if (x2 - x <= SLACK_PX || y2 - y <= SLACK_PX) {
    return undefined;
  }
  return { x, y, width: x2 - x, height: y2 - y };
}

function paintedLeaves(node: InspectedNode): InspectedNode[] {
  if (node.effectiveOpacity <= VISIBLE_OPACITY) {
    return [];
  }
  if (node.children.length === 0) {
    return node.bbox.drawIndex !== null && isReal(rectOf(node.bbox)) ? [node] : [];
  }
  return node.children.flatMap(paintedLeaves);
}

/** Visible transcript paint, cropped by every clip standing over it. */
function visibleTranscriptPaint(band: InspectedNode): Array<{ node: InspectedNode; rect: Rect }> {
  const bandClip = rectOf(band.bbox);
  return paintedLeaves(band).flatMap((node) => {
    const clip = node.clip === null ? bandClip : (intersection(node.clip, bandClip) ?? null);
    const rect = clip ? intersection(rectOf(node.bbox), clip) : undefined;
    return rect ? [{ node, rect }] : [];
  });
}

/** Painted chrome leaves, excluding the transcript and canvas/window decoration. */
function visibleChromeLeaf(
  node: InspectedNode,
  bandRect: Rect,
  canvasRect: Rect,
): { node: InspectedNode; rect: Rect } | undefined {
  if (node.children.length > 0 || node.bbox.drawIndex === null) {
    return undefined;
  }
  const rect = rectOf(node.bbox);
  // The window/canvas base legitimately spans the whole transcript.
  if (!isReal(rect) || contains(rect, bandRect) || contains(rect, canvasRect)) {
    return undefined;
  }
  const visibleRect = node.clip === null ? rect : intersection(rect, node.clip);
  return visibleRect && isReal(visibleRect) ? { node, rect: visibleRect } : undefined;
}

function chromePaint(
  root: InspectedNode,
  band: InspectedNode,
): Array<{ node: InspectedNode; rect: Rect }> {
  const found: Array<{ node: InspectedNode; rect: Rect }> = [];
  const bandRect = rectOf(band.bbox);
  const canvasRect = rectOf(root.bbox);
  const walk = (node: InspectedNode): void => {
    if (
      node === band ||
      node.effectiveOpacity <= VISIBLE_OPACITY ||
      DECORATION_BANDS.has(node.ownMeta.band ?? "")
    ) {
      return;
    }
    const leaf = visibleChromeLeaf(node, bandRect, canvasRect);
    if (leaf) {
      found.push(leaf);
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return found;
}

function describeNode(node: InspectedNode): string {
  const rect = rectOf(node.bbox);
  const semantic = node.meta.action ?? node.meta.edit ?? node.meta.part;
  return `${node.node.type}${semantic ? `(${semantic})` : ""} at [${rect.x.toFixed(0)},${rect.y.toFixed(0)} ${rect.width.toFixed(0)}x${rect.height.toFixed(0)}]`;
}

function animationOf(node: AnyVNode): AnimationSpec | undefined {
  return (node.props as { animate?: AnimationSpec } | undefined)?.animate;
}

function walkVNodes(node: AnyVNode, visit: (node: AnyVNode) => void): void {
  visit(node);
  for (const child of node.children as readonly unknown[]) {
    if (typeof child === "object" && child !== null && "type" in child) {
      walkVNodes(child as AnyVNode, visit);
    }
  }
}

/**
 * Sample every transform boundary plus visibility boundaries owned by a
 * transient composer surface, both sides of discontinuities, and interval
 * midpoints. boundsvg still owns interpolation; this only chooses the
 * instants at which the downstream invariant is asked.
 */
/**
 * Hands the event loop back between sampled instants. Each inspection is a
 * synchronous stretch of WASM work, and the runner's own status messages
 * have to get through between them.
 */
function breathe(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sampleTimes(scene: BuiltScene): number[] {
  const anchors = new Set<number>([0, scene.durationMs]);
  walkVNodes(scene.vnode, (node) => {
    const animation = animationOf(node);
    const meta = (node.props as { meta?: Record<string, string> } | undefined)?.meta ?? {};
    const temporalComposer =
      (meta["composer-panel"] !== undefined && meta["composer-panel"] !== "base") ||
      meta["composer-surface"] !== undefined ||
      meta["picker-for"] !== undefined ||
      meta["draft-root"] !== undefined;
    const relevant = animation?.keyframes.some(
      (frame) => frame.transform !== undefined || (temporalComposer && frame.opacity !== undefined),
    );
    if (!animation || !relevant) {
      return;
    }
    for (const frame of animation.keyframes) {
      anchors.add((animation.delayMs ?? 0) + frame.at * animation.durationMs);
    }
  });
  const clampedAnchors = [...anchors]
    .map((timeMs) => Math.max(0, Math.min(scene.durationMs, timeMs)))
    .sort((a, b) => a - b);
  const samples = new Set<number>();
  for (let index = 0; index < clampedAnchors.length; index += 1) {
    const timeMs = clampedAnchors[index];
    if (timeMs === undefined) {
      continue;
    }
    samples.add(timeMs);
    samples.add(Math.max(0, timeMs - EDGE_SAMPLE_MS));
    samples.add(Math.min(scene.durationMs, timeMs + EDGE_SAMPLE_MS));
    const next = clampedAnchors[index + 1];
    if (next !== undefined && next > timeMs) {
      samples.add(timeMs + (next - timeMs) / 2);
    }
  }
  return [...samples].sort((a, b) => a - b);
}

async function expectNoChromeOverContent(project: SvgentProject, label: string): Promise<void> {
  const scene = buildSvgentScene(project, 0, { engine });
  // An empty band satisfies "no chrome over content" by having no content, so
  // the emptiness itself is checked. Frames before the first message lands are
  // legitimately empty; from that instant on, a band with nothing in it is a
  // stand-off that shoved every row out or a surface that swallowed them, and
  // it has to fail while it happens rather than be excused by a tail where
  // every transient surface has already closed. Sampling deliberately lands on
  // both sides of every anchor, so a single empty instant is a cross-fade
  // caught mid-swap; a run of them is a band that was actually cleared.
  const firstLandingMs = Math.min(
    ...buildTimeline(project, project.messages).messages.map((timing) =>
      timing.message.role === "user" ? userLandingMs(timing) : timing.revealEndMs,
    ),
  );
  const empty: string[] = [];
  const run: string[] = [];
  for (const timeMs of sampleTimes(scene)) {
    await breathe();
    const inspection = inspectScene(engine, scene.vnode, { skipValidation: true, timeMs });
    const root = inspectionTree(inspection);
    const band = findBand(root);
    const content = visibleTranscriptPaint(band);
    const intrusions = chromePaint(root, band).flatMap(({ node: chrome, rect: chromeRect }) =>
      content.flatMap(({ node, rect }) =>
        (chrome.bbox.drawIndex ?? -1) > (node.bbox.drawIndex ?? -1) &&
        intersection(chromeRect, rect)
          ? [`${describeNode(chrome)} over ${describeNode(node)}`]
          : [],
      ),
    );
    expect(
      intrusions,
      `${label}: chrome covers visible transcript content at ${timeMs.toFixed(1)}ms`,
    ).toEqual([]);
    // A live selector standing in the band has taken the window on purpose,
    // and an empty band behind it is the picture working. What must never
    // happen is the band emptying with nothing in its place. This does not
    // catch a shove that overshoots while a picker is up — the picker is in
    // the band either way. `bounds a tall picker at the canvas` holds the
    // canvas edge on both surfaces; the row cap that bounds the shove itself
    // is TUI-only (planTuiChoicePanels), so the app has no equivalent.
    const transientInBand = chromePaint(root, band).some(
      ({ node }) =>
        node.meta["composer-surface"] !== undefined || node.meta["draft-root"] !== undefined,
    );
    if (timeMs < firstLandingMs || transientInBand) {
      run.length = 0;
      continue;
    }
    if (content.length === 0) {
      run.push(`${timeMs.toFixed(1)}ms`);
      if (run.length > 1) {
        empty.push(run.join(" → "));
      }
    } else {
      run.length = 0;
    }
  }
  expect(empty.slice(0, 3), `${label}: the transcript band stayed empty`).toEqual([]);
}

function findMessage(root: InspectedNode, id: string): InspectedNode | undefined {
  if (root.ownMeta.edit === id) {
    return root;
  }
  for (const child of root.children) {
    const found = findMessage(child, id);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findOwnMeta(root: InspectedNode, key: string, value: string): InspectedNode | undefined {
  if (root.ownMeta[key] === value) {
    return root;
  }
  for (const child of root.children) {
    const found = findOwnMeta(child, key, value);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function expectFinalPickerVisibility(project: SvgentProject, label: string): void {
  const scene = buildSvgentScene(project, 0, { engine });
  const inspection = inspectScene(engine, scene.vnode, {
    skipValidation: true,
    timeMs: scene.durationMs,
  });
  const root = inspectionTree(inspection);
  const band = findBand(root);
  for (const message of project.messages) {
    if (message.role !== "choice" && message.role !== "permission") {
      continue;
    }
    const node = findMessage(root, message.id);
    expect(node, `${label}: no rendered group for ${message.id}`).toBeDefined();
    expect(
      node?.effectiveOpacity,
      `${label}: ${message.id} vanished from the final frame`,
    ).toBeGreaterThan(VISIBLE_OPACITY);
    const visiblePaint = node
      ? paintedLeaves(node).filter((leaf) => intersection(rectOf(leaf.bbox), rectOf(band.bbox)))
      : [];
    expect(
      visiblePaint.length,
      `${label}: ${message.id} has no visible paint in the final transcript viewport`,
    ).toBeGreaterThan(0);
  }
}

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

const MULTILINE_COMPOSER_SCRIPT: SvgentProject["messages"] = [
  {
    id: "draft",
    role: "user",
    content:
      "Please inspect the icons, keep their silhouettes unchanged, and make every stroke visually consistent across light and dark themes.",
  },
  {
    id: "answer",
    role: "assistant",
    content: "I will compare the authored geometry before changing the shared stroke tokens.",
  },
];

const IME_REFLOW_COMPOSER_SCRIPT: SvgentProject["messages"] = [
  {
    id: "context",
    role: "assistant",
    content: "The current implementation is ready for a focused timing review.",
  },
  {
    id: "draft",
    role: "user",
    content: `${"Please check the wrap timing. ".repeat(10)}[[修正|しゅうせいしゅうせい]]`,
  },
];

describe("time-resolved inspection invariants", () => {
  it.each(["app", "tui"] as const)("keeps chrome off visible content on %s", async (surface) => {
    await expectNoChromeOverContent(
      {
        ...DEFAULT_PROJECT,
        surface,
        messages: PICKER_SCRIPT,
        camera: { ...DEFAULT_PROJECT.camera, follow: true },
      },
      `pickers ${surface}`,
    );
  }, 90_000);

  it.each([
    "start",
    "center",
  ] as const)("moves app content clear of a growing multiline composer aligned %s", async (contentAlign) => {
    await expectNoChromeOverContent(
      {
        ...DEFAULT_PROJECT,
        surface: "app",
        appearance: { ...DEFAULT_PROJECT.appearance, contentAlign },
        messages: MULTILINE_COMPOSER_SCRIPT,
      },
      `multiline app composer (${contentAlign})`,
    );
  }, 90_000);

  it.each([
    "app",
    "tui",
  ] as const)("keeps transient composer surfaces clear without a footer on %s", async (surface) => {
    await expectNoChromeOverContent(
      {
        ...DEFAULT_PROJECT,
        surface,
        display: { ...DEFAULT_PROJECT.display, footer: false },
        messages: MULTILINE_COMPOSER_SCRIPT,
      },
      `footerless composer ${surface}`,
    );
  }, 90_000);

  it.each([
    "app",
    "tui",
  ] as const)("keeps prior content clear through IME reflow on %s", async (surface) => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        canvasWidth: 800,
        canvasHeight: 700,
      },
      messages: IME_REFLOW_COMPOSER_SCRIPT,
    };
    await expectNoChromeOverContent(project, `IME reflow ${surface}`);
    if (surface === "app") {
      const draftTiming = buildTimeline(project, project.messages).messages.find(
        (timing) => timing.message.id === "draft",
      );
      if (!draftTiming) {
        throw new Error("no draft timing for the IME reflow assertion");
      }
      const scene = buildSvgentScene(project, 0, { engine });
      const root = inspectionTree(
        inspectScene(engine, scene.vnode, {
          skipValidation: true,
          timeMs: userLandingMs(draftTiming) + 1,
        }),
      );
      const visibleDraft = visibleTranscriptPaint(findBand(root)).filter(
        ({ node }) => node.meta.edit === "draft",
      );
      expect(visibleDraft.length, "App stand-off clipped away the landed draft").toBeGreaterThan(0);
    }
  }, 45_000);

  it("keeps TUI rows clear while an unbreakable draft grows the prompt", async () => {
    const source = await readFile(
      new URL("../../../fixtures/scripts/long-url-wrapping.json", import.meta.url),
      "utf8",
    );
    const { project } = deserializeProject(source);
    await expectNoChromeOverContent(project, "long URL TUI composer");
  }, 90_000);

  it("lets a tall TUI picker replace the prompt without clipping it to the transcript", async () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface: "tui",
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        canvasWidth: 1200,
        canvasHeight: 630,
        fontScale: 1.9,
        chromeScale: 1.9,
      },
      messages: PICKER_SCRIPT,
    };
    await expectNoChromeOverContent(project, "tall TUI picker");

    const permission = buildTimeline(project, project.messages).messages.find(
      (timing) => timing.message.id === "permission",
    );
    expect(permission).toBeDefined();
    const scene = buildSvgentScene(project, 0, { engine });
    const inspection = inspectScene(engine, scene.vnode, {
      skipValidation: true,
      timeMs: (permission?.startMs ?? 0) + 1,
    });
    const root = inspectionTree(inspection);
    const band = findBand(root);
    const picker = findOwnMeta(root, "picker-for", "permission");
    expect(picker).toBeDefined();
    if (!picker) {
      throw new Error("no permission picker in the inspected frame");
    }
    const pickerRect = rectOf(picker.bbox);
    expect(picker.effectiveOpacity).toBeGreaterThan(VISIBLE_OPACITY);
    // It reaches through the transcript boundary and continues into the
    // prompt rows; being a sibling of the band means neither part is cut.
    expect(pickerRect.y).toBeLessThan(bottom(rectOf(band.bbox)));
    expect(bottom(pickerRect)).toBeGreaterThan(bottom(rectOf(band.bbox)));
    expect(picker.clip === null || contains(picker.clip, pickerRect)).toBe(true);
    expect(
      visibleTranscriptPaint(band).length,
      "the picker should leave the whole terminal rows above it visible",
    ).toBeGreaterThan(0);
  }, 90_000);

  it.each(["app", "tui"] as const)("keeps offered pickers visible at the end on %s", (surface) => {
    expectFinalPickerVisibility(
      { ...DEFAULT_PROJECT, surface, messages: PICKER_SCRIPT },
      `pickers ${surface}`,
    );
  });
});

/**
 * A picker with more options than the window can hold. Anchored by its bottom
 * edge and grown upward, it is the shape that escapes a canvas.
 */
const TALL_PICKER_OPTIONS = [
  "Safe",
  "Standard",
  "Aggressive",
  "Only src",
  "Only tests",
  "Everything",
  "Ask again",
  "Cancel",
];

function tallPickerScript(chosenIndex: number): SvgentProject["messages"] {
  return [
    { id: "u", role: "user", content: "Straighten these icons" },
    {
      id: "choice",
      role: "choice",
      content: "How far should this go, and which of these directories should it touch first?",
      options: TALL_PICKER_OPTIONS,
      chosenIndex,
    },
    { id: "a", role: "assistant", content: "Done." },
  ];
}

const TALL_PICKER_SCRIPT = tallPickerScript(1);

describe("composer surfaces stay in the window", () => {
  it.each(["app", "tui"] as const)("bounds a tall %s picker at the canvas", async (surface) => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      messages: TALL_PICKER_SCRIPT,
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        canvasWidth: 1200,
        canvasHeight: 630,
        fontScale: 2,
        chromeScale: 1.2,
      },
    };
    const scene = buildSvgentScene(project, 0, { engine });
    const escapes: string[] = [];
    for (const timeMs of sampleTimes(scene)) {
      await breathe();
      const root = inspectionTree(
        inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
      );
      for (const node of paintedLeaves(root)) {
        const rect = node.clip ? intersection(rectOf(node.bbox), node.clip) : rectOf(node.bbox);
        if (rect && rect.y < 0) {
          escapes.push(`${describeNode(node)} at ${timeMs.toFixed(1)}ms reaches y=${rect.y}`);
        }
      }
    }
    expect(escapes.slice(0, 4), `${surface}: paint above the canvas`).toEqual([]);
  }, 90_000);

  /*
   * A card taller than the window has to lose rows, and which rows it loses is
   * the whole question. The heading and the question are printed again by the
   * transcript; the chosen option and its mark are not, so they are what has
   * to survive. Pinning the card to either edge loses them from one end.
   */
  /*
   * Both ends of the list: an answer near the top is lost by pinning the card
   * to its bottom, one near the end by pinning it to its top. Only scrolling
   * to the row keeps both.
   */
  const answerCases = [1, TALL_PICKER_OPTIONS.length - 1];
  // The typed answer is keyed at the prompt, not inside the card; what the
  // card marks is its own freeform row, so that label is what must survive.
  const FREEFORM_ROW_LABEL = "Write your own";
  it.each(
    (["app", "tui"] as const).flatMap((surface) =>
      answerCases.map((chosenIndex) => [surface, chosenIndex] as const),
    ),
  )(
    "keeps a clamped %s picker's answer #%i on screen",
    (surface, chosenIndex) => {
      const project: SvgentProject = {
        ...DEFAULT_PROJECT,
        surface,
        messages: tallPickerScript(chosenIndex),
        appearance: {
          ...DEFAULT_PROJECT.appearance,
          canvasWidth: 1200,
          canvasHeight: 630,
          fontScale: 2,
          chromeScale: 1.2,
        },
      };
      const scene = buildSvgentScene(project, 0, { engine });
      const answer = TALL_PICKER_OPTIONS[chosenIndex];
      if (answer === undefined) {
        throw new Error("the fixture must offer the chosen option");
      }
      expect(
        pickerAnswerVisible(scene, answer),
        `${surface}: "${answer}" never reaches the screen`,
      ).toBe(true);
    },
    90_000,
  );

  /*
   * A typed answer moves the mark off the option list and onto the freeform
   * row at the card's foot — and `readChoiceFields` writes `chosenIndex: 0`
   * into every script that offers options, so a deserialized freeform script
   * lands here with an index pointing somewhere else entirely.
   */
  it.each([
    "app",
    "tui",
  ] as const)("keeps a clamped %s picker's typed answer on screen", (surface) => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      messages: tallPickerScript(0).map((message) =>
        message.role === "choice"
          ? { ...message, freeform: "Only the icons under src, please" }
          : message,
      ),
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        canvasWidth: 1200,
        canvasHeight: 630,
        fontScale: 2,
        chromeScale: 1.2,
      },
    };
    const scene = buildSvgentScene(project, 0, { engine });
    expect(
      pickerAnswerVisible(scene, FREEFORM_ROW_LABEL),
      `${surface}: the row the card marks never reaches the screen`,
    ).toBe(true);
  }, 90_000);

  /*
   * The camera is off in every other test here. This one turns it on and asks
   * only that following does not push the answer out of frame. It does NOT
   * pin the shot's anchor: `planCameraTrack` clamps the frame to the canvas,
   * so an anchor error shows up as a badly composed shot rather than as lost
   * content, and a visibility check cannot see it. Pinning the anchor needs an
   * assertion on the frame rect itself — not written yet.
   */
  it.each(["app", "tui"] as const)("frames the %s picker's answer when following", (surface) => {
    const chosenIndex = TALL_PICKER_OPTIONS.length - 1;
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      messages: tallPickerScript(chosenIndex),
      camera: { ...DEFAULT_PROJECT.camera, follow: true, style: "sync" },
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        canvasWidth: 1200,
        canvasHeight: 630,
        fontScale: 2,
        chromeScale: 1.2,
      },
    };
    const scene = buildSvgentScene(project, 0, { engine });
    const answer = TALL_PICKER_OPTIONS[chosenIndex];
    if (answer === undefined) {
      throw new Error("the fixture must offer the chosen option");
    }
    expect(
      pickerAnswerVisible(scene, answer),
      `${surface}: following the picker pushed its answer out of frame`,
    ).toBe(true);
  }, 90_000);
});

/** Whether the chosen option's label is painted, uncropped, at some instant. */
function pickerAnswerVisible(scene: BuiltScene, answer: string): boolean {
  return sampleTimes(scene).some((timeMs) => {
    const root = inspectionTree(
      inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
    );
    return paintedLeaves(root).some((node) => {
      // Inside the picker only: the transcript prints the same option text,
      // and finding it there would say nothing about what the clip left.
      if (node.node.type !== "text" || node.meta["composer-surface"] !== "picker") {
        return false;
      }
      const printed = node.node.lines.map((line) => line.text ?? "").join("");
      if (!printed.includes(answer)) {
        return false;
      }
      const rect = rectOf(node.bbox);
      const shown = node.clip ? intersection(rect, node.clip) : rect;
      return shown !== undefined && shown.height >= rect.height - 0.5;
    });
  });
}

/**
 * The composer hands its place to a picker and takes it back. Both surfaces
 * must have one of the two on screen at every instant of that handover: the
 * app's card eases in while the panel used to leave on a step, which opened a
 * frame with neither of them painted — a still taken there was an empty
 * window. Stepping every millisecond because the hole was one wide.
 */
describe("the composer hands over without a gap", () => {
  const CASES = [
    { name: "picked", chosenIndex: 1, freeform: undefined as string | undefined },
    { name: "typed", chosenIndex: 0, freeform: "Only the icons under src, please" },
  ];

  it.each(
    (["app", "tui"] as const).flatMap((surface) =>
      CASES.map((kase) => [surface, kase.name, kase] as const),
    ),
  )(
    "keeps the %s prompt or its %s picker painted",
    async (surface, _name, kase) => {
      const project: SvgentProject = {
        ...DEFAULT_PROJECT,
        surface,
        messages: tallPickerScript(kase.chosenIndex).map((message) =>
          message.role === "choice" && kase.freeform !== undefined
            ? { ...message, freeform: kase.freeform }
            : message,
        ),
        appearance: {
          ...DEFAULT_PROJECT.appearance,
          canvasWidth: 1200,
          canvasHeight: 630,
          fontScale: 2,
          chromeScale: 1.2,
        },
      };
      const scene = buildSvgentScene(project, 0, { engine });
      const choice = buildTimeline(project, project.messages).messages.find(
        (timing) => timing.message.id === "choice",
      );
      if (choice === undefined) {
        throw new Error("the fixture must offer a choice");
      }
      const gaps: string[] = [];
      // Every millisecond only across the handover itself — the hole was one
      // wide, and stepping the whole window that finely costs more runner
      // time than the suite can carry.
      const sampled: number[] = [];
      for (let timeMs = choice.startMs - 2; timeMs <= choice.startMs + 8; timeMs += 1) {
        sampled.push(timeMs);
      }
      for (let timeMs = choice.startMs + 20; timeMs <= choice.startMs + 320; timeMs += 20) {
        sampled.push(timeMs);
      }
      for (const timeMs of sampled) {
        await breathe();
        const root = inspectionTree(
          inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
        );
        const held = paintedLeaves(root).some(
          (node) =>
            node.meta["composer-surface"] === "picker" ||
            node.meta["composer-panel"] === "base" ||
            node.meta["draft-root"] !== undefined,
        );
        if (!held) {
          gaps.push(`${timeMs.toFixed(0)}ms`);
        }
      }
      expect(gaps.slice(0, 4), `${surface}: neither the prompt nor the picker is painted`).toEqual(
        [],
      );
    },
    30_000,
  );

  /*
   * And the prompt's placeholder must be gone while an answer is keyed into
   * it. The picker hands the keyboard over at its close, so its own release
   * keyframe lands after the typing window has already hidden the hint —
   * later, and therefore winning — and the hint prints under the sentence.
   */
  it("clears the app placeholder while the typed answer is keyed", async () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface: "app",
      messages: tallPickerScript(0).map((message) =>
        message.role === "choice"
          ? { ...message, freeform: "Only the icons under src, please" }
          : message,
      ),
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        canvasWidth: 1200,
        canvasHeight: 630,
        fontScale: 2,
        chromeScale: 1.2,
      },
    };
    const scene = buildSvgentScene(project, 0, { engine });
    const choice = buildTimeline(project, project.messages).messages.find(
      (timing) => timing.message.id === "choice",
    );
    const answer = choice === undefined ? null : choiceDraftTiming(choice, project);
    if (answer === null) {
      throw new Error("the fixture must type its answer");
    }
    const shown: string[] = [];
    for (let timeMs = answer.startMs; timeMs <= sendMomentMs(answer); timeMs += 40) {
      await breathe();
      const root = inspectionTree(
        inspectScene(engine, scene.vnode, { skipValidation: true, timeMs }),
      );
      const hint = paintedLeaves(root).some(
        (node) =>
          node.node.type === "text" &&
          node.node.lines.some((line) => (line.text ?? "").includes("Write a follow-up")),
      );
      if (hint) {
        shown.push(`${timeMs.toFixed(0)}ms`);
      }
    }
    expect(shown.slice(0, 4), "the placeholder prints under the answer").toEqual([]);
  }, 30_000);
});
