/**
 * What a choice answered in the user's own words has to look like while it
 * is being answered.
 *
 * The defects this pins were all invisible to the timeline suites and to a
 * serialized-scene grep: the answer was present in the tree the whole time,
 * and what was wrong was which copy of it painted, and when. So the suite
 * asks boundsvg to resolve the animation at an instant and reports what is
 * actually on screen — the same measurement the paint invariants use.
 */

import { readFile } from "node:fs/promises";
import {
  createEngineAsync,
  type Engine,
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
  CHOICE_SEND_BEAT_MS,
  choiceKeyingStartMs,
  DEFAULT_PROJECT,
  FONT_ALIAS,
  type MessageTiming,
  pickerCloseMs,
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
  engine?.dispose();
});

const ANSWER = "Show me the diff first please";
/** Enough transcript that the picker has to borrow rows to open. */
const FILLER =
  "The run compares the rendered output against the committed baseline and reports every byte that moved, so each pass has to end clean before the next one starts.";
const VISIBLE_OPACITY = 0.01;
const SLACK_PX = 1.5;

/** The choice is last, so the geometry after it settles is the final one. */
const SCRIPT: SessionMessage[] = [
  { id: "u1", role: "user", content: "Look into the failure." },
  ...Array.from({ length: 10 }, (_, index): SessionMessage => {
    return { id: `f${index}`, role: "assistant", content: FILLER };
  }),
  {
    id: "c1",
    role: "choice",
    content: "How should we proceed?",
    options: ["Fix it now", "Add tests first"],
    freeform: ANSWER,
  },
];

function projectOn(surface: "app" | "tui"): SvgentProject {
  return { ...DEFAULT_PROJECT, surface, messages: SCRIPT };
}

/**
 * The choice, and the window its answer has to be written in — read off the
 * message itself rather than off the draft plan, so a regression that stops
 * planning a draft at all still gets measured instead of skipped.
 */
function choiceTiming(project: SvgentProject): {
  choice: MessageTiming;
  keyingStartMs: number;
  keyingEndMs: number;
  sendMs: number;
} {
  const timeline = buildTimeline(project, project.messages);
  const choice = timeline.messages.at(-1);
  if (!choice || choice.message.role !== "choice") {
    throw new Error("the fixture must end on a choice");
  }
  return {
    choice,
    // The picker has to clear the frame before the prompt takes over.
    keyingStartMs: choiceKeyingStartMs(choice, project),
    // The message ends on its send; the keying ends a beat before that.
    keyingEndMs: choice.revealEndMs - CHOICE_SEND_BEAT_MS,
    sendMs: choice.revealEndMs,
  };
}

type AnswerPaint = { nodeId: string; opacity: number; keyed: boolean };

/** The brightest any of the picker's own rows paints at an instant. */
function pickerOpacity(inspection: SceneInspection): number {
  const rows = new Set((SCRIPT.at(-1)?.options ?? []).map((option) => option.replace(/\s+/gu, "")));
  let brightest = 0;
  const walk = (node: IRNode, inheritedOpacity: number): void => {
    const opacity = inheritedOpacity * (node.type === "group" ? (node.opacity ?? 1) : 1);
    if (node.type === "text") {
      const text = node.lines
        .map((line) => line.text)
        .join("")
        .replace(/\s+/gu, "");
      if (rows.has(text)) {
        brightest = Math.max(brightest, opacity);
      }
    }
    for (const child of node.type === "group" ? (node.children ?? []) : []) {
      walk(child, opacity);
    }
  };
  walk(inspection.ir.root, 1);
  return brightest;
}

/** Every node carrying the whole answer, with the opacity it paints at. */
function answerPaint(inspection: SceneInspection): AnswerPaint[] {
  const found: AnswerPaint[] = [];
  const wanted = ANSWER.replace(/\s+/gu, "");
  const walk = (node: IRNode, inheritedOpacity: number): void => {
    const opacity = inheritedOpacity * (node.type === "group" ? (node.opacity ?? 1) : 1);
    if (node.type === "text") {
      const text = node.lines
        .map((line) => line.text)
        .join("")
        .replace(/\s+/gu, "");
      if (text.includes(wanted)) {
        found.push({ nodeId: node.nodeId, opacity, keyed: node.unitAnimation !== undefined });
      }
    }
    for (const child of node.type === "group" ? (node.children ?? []) : []) {
      walk(child, opacity);
    }
  };
  walk(inspection.ir.root, 1);
  return found;
}

/** Where a message block sits once every ancestor transform is composed. */
function blockTop(inspection: SceneInspection, edit: string): number {
  const byNode = new Map(
    inspection.bboxes.map((bbox) => [`${bbox.nodeId}\u0000${bbox.type}`, bbox]),
  );
  let top: number | null = null;
  const walk = (node: IRNode): void => {
    if (top === null && node.type === "group" && node.meta?.edit === edit) {
      top = byNode.get(`${node.nodeId}\u0000${node.type}`)?.visualBBox.y ?? null;
    }
    for (const child of node.type === "group" ? (node.children ?? []) : []) {
      walk(child);
    }
  };
  walk(inspection.ir.root);
  if (top === null) {
    throw new Error(`no block tagged ${edit} in the scene`);
  }
  return top;
}

describe.each(["app", "tui"] as const)("a freeform answer on %s", (surface) => {
  const project = projectOn(surface);
  const { choice, keyingStartMs, keyingEndMs, sendMs } = choiceTiming(project);
  const atFraction = (fraction: number): number =>
    keyingStartMs + (keyingEndMs - keyingStartMs) * fraction;
  const scene = buildSvgentScene(project, 0, { engine });
  const inspectAt = (timeMs: number): SceneInspection =>
    inspectScene(engine, scene.vnode, { skipValidation: true, timeMs });

  it("is keyed in rather than appearing whole", () => {
    // Through the whole of the keying, the only copy of the answer allowed
    // to paint is the one being typed. Anything else on screen means the
    // reader was handed the finished sentence before it was written.
    let keyedSamples = 0;
    const steps = 8;
    for (let step = 0; step <= steps; step += 1) {
      const timeMs = atFraction(step / steps);
      const painted = answerPaint(inspectAt(timeMs)).filter(
        (paint) => paint.opacity > VISIBLE_OPACITY,
      );
      expect(
        painted.filter((paint) => !paint.keyed),
        `at ${Math.round(timeMs)}ms`,
      ).toEqual([]);
      keyedSamples += painted.some((paint) => paint.keyed) ? 1 : 0;
    }
    // The draft fades in on the picker's close and out on the send, so the
    // two ends of the window may read empty — the middle may not.
    expect(keyedSamples).toBeGreaterThanOrEqual(steps - 1);
  });

  it("waits for the picker to clear the frame", () => {
    // On the App the card and the composer share the same strip of the
    // window, so a draft that starts on the pick types straight through the
    // fading card. The keyboard is handed over, not shared.
    for (let step = 0; step <= 8; step += 1) {
      const timeMs = atFraction(step / 8);
      const inspection = inspectAt(timeMs);
      const keyed = answerPaint(inspection).some(
        (paint) => paint.keyed && paint.opacity > VISIBLE_OPACITY,
      );
      if (keyed) {
        expect(pickerOpacity(inspection), `at ${Math.round(timeMs)}ms`).toBeLessThanOrEqual(
          VISIBLE_OPACITY,
        );
      }
    }
  });

  it("lands in the transcript once it is sent", () => {
    // The counterpart to the rule above: it does eventually arrive, and as
    // a settled copy rather than the draft that is still in the composer.
    const painted = answerPaint(inspectAt(choice.settledMs)).filter((paint) => paint.opacity > 0.5);
    expect(painted).not.toEqual([]);
  });

  it("hands the borrowed rows back when the picker closes", () => {
    const closeMs = pickerCloseMs(choice, project);
    const whileOpen = blockTop(inspectAt(choice.startMs + 300), "u1");
    const whileTyping = blockTop(inspectAt(atFraction(0.6)), "u1");
    const settled = blockTop(inspectAt(scene.durationMs - 1), "u1");

    // The picker really does displace the transcript here…
    expect(Math.abs(whileOpen - settled)).toBeGreaterThan(SLACK_PX);
    expect(sendMs).toBeGreaterThan(keyingEndMs);
    // …and it gives those rows back at the close, not at the end of the
    // message: by the time the answer is being typed the transcript is
    // already home.
    expect(closeMs).toBeLessThan(choice.revealEndMs);
    expect(Math.abs(whileTyping - settled)).toBeLessThanOrEqual(SLACK_PX);
  });
});
