/**
 * The line being written stays in view.
 *
 * A terminal scrolls up a row the moment output is written past its last
 * row, and a chat view stays pinned to the bottom while a reply streams, so
 * the newest characters are never below the visible area. These tests sample
 * the settled animation of long streamed replies and check the ink of every
 * cluster that has just appeared against the transcript's clip.
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
  buildTimeline,
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  FONT_ALIAS,
  type SessionMessage,
  type SvgentProject,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VISIBLE_OPACITY = 0.01;
/** Instants sampled across each streamed reply, evenly spaced. */
const SAMPLES_PER_REPLY = 24;
/** App messages rise into place over their entrance; the view follows the settled line. */
const APP_ENTRANCE_MS = 380;
const SLACK_PX = 1;

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

type Box = InspectionBBox["visualBBox"];
type UnitSample = { opacity?: number; bbox?: Box };

type Writing = { text: string; bottom: number; clipBottom: number };

/**
 * A text node that is partly revealed — the line being written — as the
 * bottom of its newest cluster's ink, or `null` for text that is not.
 */
function writingOf(
  node: IRNode,
  bbox: InspectionBBox,
  paint: { opacity: number; clipBottom: number },
): Writing | null {
  const samples = (node as { unitAnimationSamples?: UnitSample[] }).unitAnimationSamples;
  if (node.type !== "text" || samples === undefined) {
    return null;
  }
  const inked = samples.filter((sample) => sample.bbox !== undefined);
  const shown = inked.filter((sample) => (sample.opacity ?? 0) * paint.opacity > VISIBLE_OPACITY);
  const newest = shown.at(-1)?.bbox;
  if (newest === undefined || shown.length === inked.length) {
    return null;
  }
  // Unit boxes are laid out where layout put the node; move them with it.
  const layout = (node as { bbox?: Box }).bbox ?? bbox.visualBBox;
  return {
    text: node.lines.map((line) => line.text).join(" "),
    bottom: newest.y + (bbox.visualBBox.y - layout.y) + newest.h,
    clipBottom: paint.clipBottom,
  };
}

/** Every line being written at `timeMs`, against the bottom of the clip it sits in. */
function writingAgainstClip(scene: ReturnType<typeof buildSvgentScene>, timeMs: number): Writing[] {
  const inspection = inspectScene(engine, scene.vnode, { skipValidation: true, timeMs });
  const boxes = new Map(
    inspection.bboxes.map((bbox) => [`${bbox.nodeId}\u0000${bbox.type}`, bbox] as const),
  );
  const found: Writing[] = [];
  const walk = (node: IRNode, opacity: number, clipBottom: number): void => {
    const own = opacity * (node.type === "group" ? (node.opacity ?? 1) : 1);
    const bbox = boxes.get(`${node.nodeId}\u0000${node.type}`);
    if (node.type === "group") {
      const clip =
        node.clipPath && bbox
          ? Math.min(clipBottom, bbox.visualBBox.y + bbox.visualBBox.h)
          : clipBottom;
      for (const child of node.children ?? []) {
        walk(child, own, clip);
      }
      return;
    }
    const writing = bbox ? writingOf(node, bbox, { opacity: own, clipBottom }) : null;
    if (writing !== null) {
      found.push(writing);
    }
  };
  walk(inspection.ir.root, 1, Number.POSITIVE_INFINITY);
  return found;
}

const QUOTE_AND_BREAK = [
  "> Before publishing, check the tables at a narrow width too.",
  ">",
  "> > A table whose columns do not fit is rearranged into one column.",
  "",
  "The steps are in the [release guide](https://example.com/release).  ",
  "It takes about ten minutes.",
].join("\n");

const TABLE_AND_LISTS = [
  "## CI results",
  "",
  "| Check | Result | Time |",
  "| :--- | :---: | ---: |",
  "| lint | **pass** | 1.2s |",
  "| Unit tests | ~~fail~~ pass | 34.0s |",
  "",
  "- [x] Write the changelog",
  "- [ ] Publish the release notes",
  "  - Japanese",
  "  - English",
  "",
  "1. Create the tag",
  "2. Check the build",
].join("\n");

const PROSE = Array.from(
  { length: 24 },
  (_unused, index) => `Paragraph ${index + 1} of plain prose, long enough to fill a line or so.`,
).join("\n\n");

function conversation(replies: string[]): SessionMessage[] {
  return [
    { id: "ask", role: "user", content: "Summarize where the release stands." },
    ...replies.map((content, index) => ({
      id: `reply-${index}`,
      role: "assistant" as const,
      content,
    })),
  ];
}

const CASES: Array<[string, SessionMessage[]]> = [
  [
    "Markdown replies that outgrow the view",
    conversation([TABLE_AND_LISTS, TABLE_AND_LISTS, QUOTE_AND_BREAK]),
  ],
  ["a long prose reply", conversation([PROSE])],
];

describe.each(["app", "tui"] as const)("auto-follow on %s", (surface) => {
  it.each(CASES)(
    "keeps the line being written in view: %s",
    (_label, messages) => {
      const project: SvgentProject = { ...DEFAULT_PROJECT, surface, messages };
      const scene = buildSvgentScene(project, 0, { engine });
      const timings = buildTimeline(project, project.messages).messages.filter(
        (timing) => timing.message.role === "assistant",
      );
      let samples = 0;
      for (const timing of timings) {
        const from = timing.startMs + (surface === "app" ? APP_ENTRANCE_MS : 0);
        const span = timing.revealEndMs - from;
        for (let sample = 0; sample <= SAMPLES_PER_REPLY; sample += 1) {
          const timeMs = from + (span * sample) / SAMPLES_PER_REPLY;
          for (const writing of writingAgainstClip(scene, timeMs)) {
            samples += 1;
            expect(
              writing.bottom,
              `${Math.round(timeMs)}ms: "${writing.text.slice(0, 40)}"`,
            ).toBeLessThanOrEqual(writing.clipBottom + SLACK_PX);
          }
        }
      }
      // The check has to have seen lines being written to mean anything.
      expect(samples).toBeGreaterThan(20);
    },
    60_000,
  );
});
