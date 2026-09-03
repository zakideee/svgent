/**
 * Properties of the timeline, checked without an engine.
 *
 * The other half of what kept breaking. A scroll move anchored before the row
 * it follows had been printed; a picker whose only representation stopped
 * being drawn at `revealEndMs`, so every still — poster, transcript, preview
 * snapshot — showed a choice that appeared never to have been offered.
 * Neither is visible to a
 * check on one frame's boxes, and neither needs one: they are statements about
 * when things happen, and the built scene already carries every schedule.
 */

import { readdir, readFile } from "node:fs/promises";
import type { AnyVNode } from "@boundsvg/core";
import {
  buildSvgentScene,
  buildTimeline,
  composerDraftTimings,
  DEFAULT_PROJECT,
  deserializeProject,
  type SvgentProject,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

type Keyframe = { at: number };
type Track = {
  keyframes: Keyframe[];
  durationMs: number;
  delayMs?: number;
};

type Props = {
  meta?: Record<string, string>;
  animate?: Track;
  animateUnits?: { animation: Track };
};

/** Scheduling rounds to whole milliseconds in a few places. */
const SLACK_MS = 2;

function propsOf(node: AnyVNode): Props {
  return (node.props ?? {}) as Props;
}

function walk(node: AnyVNode, visit: (node: AnyVNode) => void): void {
  visit(node);
  for (const child of node.children as readonly unknown[]) {
    if (typeof child === "object" && child !== null && "type" in child) {
      walk(child as AnyVNode, visit);
    }
  }
}

function tracksOf(scene: AnyVNode): Array<{ node: AnyVNode; track: Track }> {
  const found: Array<{ node: AnyVNode; track: Track }> = [];
  walk(scene, (node) => {
    const props = propsOf(node);
    for (const track of [props.animate, props.animateUnits?.animation]) {
      if (track?.keyframes) {
        found.push({ node, track });
      }
    }
  });
  return found;
}

function expectSoundTimeline(project: SvgentProject, label: string): void {
  const scene = buildSvgentScene(project, 0);
  const durationMs = scene.durationMs;
  expect(durationMs, `${label}: scene has no duration`).toBeGreaterThan(0);

  const tracks = tracksOf(scene.vnode);
  expect(tracks.length, `${label}: nothing is animated`).toBeGreaterThan(0);

  for (const { track } of tracks) {
    expect(track.keyframes.length, `${label}: a track with one keyframe`).toBeGreaterThan(1);
    expect(track.durationMs, `${label}: a track with no duration`).toBeGreaterThan(0);
    expect(
      track.delayMs ?? 0,
      `${label}: a track starting before the scene`,
    ).toBeGreaterThanOrEqual(0);

    // A track's own timeline is a fraction of its duration. Out of order or
    // out of range, the renderer has to guess, and it guesses silently.
    let previous = Number.NEGATIVE_INFINITY;
    for (const frame of track.keyframes) {
      expect(Number.isFinite(frame.at), `${label}: a keyframe at ${frame.at}`).toBe(true);
      expect(frame.at, `${label}: a keyframe at ${frame.at}`).toBeGreaterThanOrEqual(0);
      expect(frame.at, `${label}: a keyframe at ${frame.at}`).toBeLessThanOrEqual(1);
      expect(frame.at > previous, `${label}: keyframes out of order at ${frame.at}`).toBe(true);
      previous = frame.at;
    }

    // Nothing may be scheduled past the end: the poster and the transcript
    // are both taken at exactly durationMs.
    expect(
      (track.delayMs ?? 0) + track.durationMs,
      `${label}: a track outliving the scene`,
    ).toBeLessThanOrEqual(durationMs + SLACK_MS);
  }

  // Messages arrive in the order they are authored. A block that appears
  // before the one above it is a schedule the transcript cannot honour, and
  // it is what the scroll plan follows.
  const appearedAt = new Map<string, number>();
  walk(scene.vnode, (node) => {
    const { meta, animate } = propsOf(node);
    const id = meta?.edit;
    if (id !== undefined && !id.startsWith("field:") && animate && !appearedAt.has(id)) {
      appearedAt.set(id, animate.delayMs ?? 0);
    }
  });
  let latest = Number.NEGATIVE_INFINITY;
  for (const timing of scene.messageTimings) {
    const at = appearedAt.get(timing.message.id);
    if (at === undefined) {
      continue;
    }
    expect(
      at >= latest - SLACK_MS,
      `${label}: ${timing.message.id} appears at ${at}, before something above it (${latest})`,
    ).toBe(true);
    latest = Math.max(latest, at);
  }

  // Final picker visibility is deliberately engine-backed. The sampled IR
  // supplies resolved opacity and `inspectScene` supplies transform-composed
  // geometry; `inspection-invariants.test.ts` checks the paint result without
  // reproducing boundsvg's animation semantics here.
}

const PICKER_SCRIPT: SvgentProject["messages"] = [
  { id: "u", role: "user", content: "Straighten these icons" },
  { id: "tool", role: "tool", content: "rg stroke-width src", language: "bash" },
  {
    id: "choice",
    role: "choice",
    content: "How far should this go?",
    options: ["Safe", "Standard", "Aggressive"],
    chosenIndex: 1,
  },
  { id: "permission", role: "permission", content: "Update three snapshots", decision: "deny" },
  { id: "a", role: "assistant", content: "Done" },
];

/** The same picker, answered in the user's own words with staged keying. */
const FREEFORM_SCRIPT: SvgentProject["messages"] = PICKER_SCRIPT.map((message) =>
  message.role === "choice"
    ? { ...message, freeform: "{{Standard|Sta}} でいいけど、{{--dry-run|--dry}} を先に" }
    : message,
);

describe("timeline invariants", () => {
  it.each(["app", "tui"] as const)("hold for a default %s scene", (surface) => {
    expectSoundTimeline({ ...DEFAULT_PROJECT, surface }, `default ${surface}`);
  });

  it.each(["app", "tui"] as const)("hold for pickers on %s", (surface) => {
    expectSoundTimeline(
      { ...DEFAULT_PROJECT, surface, messages: PICKER_SCRIPT },
      `pickers ${surface}`,
    );
  });

  it.each(["app", "tui"] as const)("survive a script paced to its extremes on %s", (surface) => {
    expectSoundTimeline(
      {
        ...DEFAULT_PROJECT,
        surface,
        messages: PICKER_SCRIPT,
        timing: {
          ...DEFAULT_PROJECT.timing,
          userTypingCps: 60,
          agentTypingCps: 120,
          reactionMs: 0,
          thinkingMs: 0,
          toolRunMs: 0,
          permissionMs: 0,
          transitionMs: 0,
          finalHoldMs: 0,
        },
      },
      `${surface} at zero pacing`,
    );
  });

  it.each(["app", "tui"] as const)("hold for a typed freeform answer on %s", (surface) => {
    expectSoundTimeline(
      { ...DEFAULT_PROJECT, surface, messages: FREEFORM_SCRIPT },
      `freeform ${surface}`,
    );
  });

  it("holds when a freeform answer has no prompt to be typed at", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      messages: FREEFORM_SCRIPT,
      display: { ...DEFAULT_PROJECT.display, composer: false },
    };
    expectSoundTimeline(project, "freeform without a composer");
    const timeline = buildTimeline(project, project.messages);
    // Nothing keys the answer, so the picker owns its own settle: the
    // composer is handed the real user turn and nothing else.
    expect(composerDraftTimings(timeline, project).map(({ message }) => message.id)).toEqual(["u"]);
  });

  it("hold for every fixture in the corpus", async () => {
    const dir = new URL("../../../fixtures/scripts/", import.meta.url);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const name of names) {
      const source = await readFile(new URL(name, dir), "utf8");
      const { project } = deserializeProject(source);
      expectSoundTimeline(project, name);
    }
  });
});
