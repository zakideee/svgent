/**
 * Highlight beats. A replayed transcript is append-only, so when a
 * highlighted thinking row settles nothing has landed below it — the note
 * opens into empty column space, and the only motion a beat may need is a
 * lift of the scrolled column to keep the note clear of the viewport clip.
 * The suite pins the timeline accounting, the App/TUI asymmetry, and both
 * the unscrolled and scrolled geometries.
 */

import { readFile } from "node:fs/promises";
import { createEngineAsync, type Engine } from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  buildTimeline,
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  FONT_ALIAS,
  highlightWindow,
  planAppHighlights,
  type SessionMessage,
  type SvgentProject,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  engine.dispose();
});

const NOTE = "Tracing the failing assertion back through the fixture that pins the old schema.";

function scriptedMessages(highlight: boolean, filler = 0): SessionMessage[] {
  const fillers: SessionMessage[] = Array.from({ length: filler }, (_, index) => ({
    id: `filler-${index}`,
    role: "assistant",
    content:
      "The run compares the rendered output against the committed baseline and reports every byte that moved, so each pass has to end clean before the next starts.",
  }));
  return [
    { id: "ask", role: "user", content: "Why does the conformance run fail?" },
    ...fillers,
    { id: "think", role: "thinking", content: NOTE, ...(highlight ? { highlight: true } : {}) },
    { id: "run", role: "tool", content: "pnpm exec vitest run tests/conformance" },
  ];
}

function project(highlight: boolean, surface: "app" | "tui" = "app", filler = 0): SvgentProject {
  return { ...DEFAULT_PROJECT, surface, messages: scriptedMessages(highlight, filler) };
}

type ProbeNode = {
  bbox: { x: number; y: number; width: number; height: number };
  vnode: { props?: { meta?: Record<string, string> } };
  children: ProbeNode[];
};

/**
 * The transcript band and its message blocks, collected the way the layout
 * invariants collect them: the outermost tagged node wins, so an open note's
 * wrapper stands for its message rather than adding a block.
 */
function transcriptGeometry(root: ProbeNode): {
  bandBottom: number;
  blocks: string[];
  lastBlockBottom: number;
} {
  let bandBottom = 0;
  const blocks: string[] = [];
  let lastBlockBottom = 0;
  const walk = (node: ProbeNode): void => {
    const meta = node.vnode.props?.meta ?? {};
    if (meta.band === "transcript") {
      bandBottom = node.bbox.y + node.bbox.height;
    }
    if (meta.edit !== undefined && !meta.edit.startsWith("field:")) {
      blocks.push(meta.edit);
      lastBlockBottom = Math.max(lastBlockBottom, node.bbox.y + node.bbox.height);
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(root);
  return { bandBottom, blocks, lastBlockBottom };
}

describe("highlight timeline", () => {
  it("charges the beat on the App surface and exposes its window", () => {
    const plain = buildTimeline(project(false), scriptedMessages(false));
    const highlighted = buildTimeline(project(true), scriptedMessages(true));

    expect(highlighted.durationMs).toBeGreaterThan(plain.durationMs);
    const timing = highlighted.messages[1];
    if (!timing) {
      throw new Error("missing thinking timing");
    }
    const window = highlightWindow(timing, project(true));
    expect(window).not.toBeNull();
    expect(window?.startMs).toBeGreaterThanOrEqual(timing.revealEndMs);
    expect(window?.returnMs).toBe(timing.settledMs);
    expect(highlighted.messages[2]?.startMs).toBeGreaterThanOrEqual(window?.returnMs ?? 0);
  });

  it("stays inert on the TUI surface", () => {
    const plain = buildTimeline(project(false, "tui"), scriptedMessages(false));
    const highlighted = buildTimeline(project(true, "tui"), scriptedMessages(true));

    expect(highlighted.durationMs).toBe(plain.durationMs);
    const timing = highlighted.messages[1];
    if (!timing) {
      throw new Error("missing thinking timing");
    }
    expect(highlightWindow(timing, project(true, "tui"))).toBeNull();
  });

  it("skips beats that would straddle the clamped project duration", () => {
    const timeline = buildTimeline(project(true), scriptedMessages(true));
    const truncated = { ...timeline, durationMs: (timeline.messages[1]?.settledMs ?? 0) - 1 };
    const beats = planAppHighlights({
      project: project(true),
      timeline: truncated,
      heights: timeline.messages.map(() => 40),
      gap: 10,
      noteHeights: new Map([[1, 60]]),
    });
    expect(beats).toEqual([]);
  });
});

describe("highlight scene", () => {
  it("draws the editable note into empty column space with no lift when unscrolled", () => {
    const scene = buildSvgentScene(project(true), 0, { engine });
    const serialized = JSON.stringify(scene.vnode);
    const withoutBeat = JSON.stringify(buildSvgentScene(project(false), 0, { engine }).vnode);

    const countIn = (value: string) => value.split(NOTE.slice(0, 24)).length - 1;
    expect(countIn(serialized)).toBeGreaterThan(countIn(withoutBeat));
    expect(serialized).toContain('"edit":"think"');
    // A two-message conversation has not scrolled; nothing may move.
    const lifted = [...serialized.matchAll(/"translateY":-(\d+(?:\.\d+)?)/gu)]
      .map((match) => Number(match[1]))
      .filter((value) => value > 20);
    expect(lifted).toEqual([]);
  });

  it("lifts the scrolled column just far enough to keep the note visible", () => {
    const scene = buildSvgentScene(project(true, "app", 8), 0, { engine });
    const serialized = JSON.stringify(scene.vnode);

    // With eight filler paragraphs the transcript has scrolled well past the
    // viewport, so the beat must carry a real lift.
    const lifted = [...serialized.matchAll(/"translateY":-(\d+(?:\.\d+)?)/gu)]
      .map((match) => Number(match[1]))
      .filter((value) => value > 20);
    expect(lifted.length).toBeGreaterThan(0);
  });

  it("renders report stills with the note open in flow", () => {
    const openScene = buildSvgentScene(project(true), 0, {
      engine,
      fullHeight: true,
      openNotes: true,
    });
    const serialized = JSON.stringify(openScene.vnode);
    const closed = JSON.stringify(
      buildSvgentScene(project(true), 0, { engine, fullHeight: true }).vnode,
    );

    // In flow, not a timed overlay: the note is real content in the still.
    expect(serialized).not.toContain('"overlay":"highlight-note"');
    // The canvas must grow by the note's real extent, or the transcript tail
    // is pushed past the clip — the measured heights include the wrapper.
    const heightOf = (value: string) => {
      const match = value.match(/"type":"Canvas","props":\{[^{]*?"height":(\d+(?:\.\d+)?)/u);
      return Number(match?.[1] ?? 0);
    };
    expect(heightOf(serialized)).toBeGreaterThan(heightOf(closed) + 40);
    // …and the grown canvas has to actually hold the tail: with the notes in
    // flow, the last block must still sit inside the clipped transcript band.
    const layout = engine.renderToLayoutTree(openScene.vnode, { skipValidation: true });
    const geometry = transcriptGeometry(layout.root as unknown as ProbeNode);
    expect(geometry.blocks.length).toBeGreaterThan(0);
    expect(geometry.lastBlockBottom).toBeLessThanOrEqual(geometry.bandBottom + 1.5);
  });

  it("keeps the TUI scene identical with and without the flag", () => {
    const flagged = JSON.stringify(buildSvgentScene(project(true, "tui"), 0, { engine }).vnode);
    const plain = JSON.stringify(buildSvgentScene(project(false, "tui"), 0, { engine }).vnode);
    expect(flagged).toBe(plain);
  });
});
