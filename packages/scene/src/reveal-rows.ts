/**
 * When each line of a streamed message comes into view, and how far down the
 * message it reaches.
 *
 * A transcript that follows its newest line has to scroll as the text grows,
 * not on a schedule of its own: a terminal moves up one row the moment a
 * character is written past its last row, and a chat view stays pinned to
 * the bottom while a reply streams. The scroll plan reads this frontier to do
 * the same.
 */

import {
  type AnyVNode,
  Canvas,
  type Engine,
  Flex,
  type IRNode,
  inspectScene,
} from "@boundsvg/core";
import { PROBE_CANVAS_HEIGHT_PX, PROBE_CANVAS_MIN_WIDTH_PX } from "./measure.js";
import type { MessageTiming } from "./timeline.js";

/** Growth smaller than this is layout rounding, not a new line. */
const SUBPIXEL_PX = 0.5;

/** From `atMs` on, the message's revealed content reaches `bottom` px below its top. */
export type RevealStep = { atMs: number; bottom: number };

type Box = { x: number; y: number; w: number; h: number };

type UnitAnimation = {
  animation?: { delayMs?: number };
  delayStepMs?: number;
};
type UnitEntry = {
  logicalOrder?: number;
  members?: Array<{ lineIndex: number }>;
};

/** A group animation that fades or pops its content in: when it starts to show. */
function entranceMs(node: IRNode): number | null {
  if (node.type !== "group") {
    return null;
  }
  const animation = (
    node as {
      animation?: { delayMs?: number; keyframes?: Array<{ opacity?: number }> };
    }
  ).animation;
  const first = animation?.keyframes?.[0];
  return first?.opacity === 0 ? (animation?.delayMs ?? 0) : null;
}

type ProbedText = {
  type: "text";
  lineHeightPx?: number;
  layoutBox?: Box;
  unitAnimation?: UnitAnimation;
  unitMap?: { units?: UnitEntry[] };
};

/**
 * When each line of one text node shows, and its bottom. A node revealed a
 * cluster at a time shows each line with its first cluster; anything else
 * shows whole when its container does.
 */
function textEntries(text: ProbedText, layout: Box, shownAtMs: number): RevealStep[] {
  const units = text.unitMap?.units;
  const lineHeight = text.lineHeightPx;
  if (text.unitAnimation === undefined || units === undefined || lineHeight === undefined) {
    return [{ atMs: shownAtMs, bottom: layout.y + layout.h }];
  }
  const top = text.layoutBox?.y ?? layout.y;
  const delay = text.unitAnimation.animation?.delayMs ?? 0;
  const step = text.unitAnimation.delayStepMs ?? 0;
  return units.map((unit) => ({
    atMs: Math.max(shownAtMs, delay + (unit.logicalOrder ?? 0) * step),
    bottom: top + ((unit.members?.[0]?.lineIndex ?? 0) + 1) * lineHeight,
  }));
}

const stepCache = new WeakMap<Engine, Map<string, RevealStep[] | null>>();
/** Reveal frontiers kept per engine before the cache starts over. */
const STEP_CACHE_LIMIT = 500;

/**
 * The reveal frontier of one message node laid out at `width`: sorted by
 * time, each step lower than the last. `null` when the engine cannot lay the
 * node out. `key` names everything the layout and timing depend on.
 */
function measureRevealSteps(
  engine: Engine,
  probe: { node: AnyVNode; width: number; key: string },
): RevealStep[] | null {
  let cache = stepCache.get(engine);
  if (cache === undefined) {
    cache = new Map();
    stepCache.set(engine, cache);
  }
  const cached = cache.get(probe.key);
  if (cached !== undefined) {
    return cached;
  }
  let steps: RevealStep[] | null = null;
  try {
    const inspection = inspectScene(
      engine,
      Canvas(
        {
          width: Math.max(PROBE_CANVAS_MIN_WIDTH_PX, Math.ceil(probe.width)),
          height: PROBE_CANVAS_HEIGHT_PX,
        },
        Flex(
          { position: "absolute", left: 0, top: 0, width: probe.width, direction: "column" },
          probe.node,
        ),
      ),
      { skipValidation: true, timeMs: 0 },
    );
    const layoutBoxes = new Map<string, Box>(
      inspection.bboxes.map((bbox) => [`${bbox.nodeId}\u0000${bbox.type}`, bbox.layoutBBox]),
    );
    const entries: RevealStep[] = [];
    const walk = (node: IRNode, shownAtMs: number): void => {
      const atMs = Math.max(shownAtMs, entranceMs(node) ?? 0);
      if (node.type === "group") {
        for (const child of node.children ?? []) {
          walk(child, atMs);
        }
        return;
      }
      const layout = layoutBoxes.get(`${node.nodeId}\u0000${node.type}`);
      if (layout === undefined || layout.h <= 0) {
        return;
      }
      // Only text counts. Backgrounds and cards are laid out at their final
      // size from the start; following them would scroll to the bottom of a
      // card before a word of it is written.
      if (node.type === "text") {
        entries.push(...textEntries(node as ProbedText, layout, atMs));
      }
    };
    walk(inspection.ir.root, 0);
    entries.sort((left, right) => left.atMs - right.atMs || left.bottom - right.bottom);
    steps = [];
    let reached = 0;
    for (const entry of entries) {
      if (entry.bottom > reached + SUBPIXEL_PX) {
        reached = entry.bottom;
        steps.push({ atMs: entry.atMs, bottom: reached });
      }
    }
  } catch {
    steps = null;
  }
  if (cache.size >= STEP_CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(probe.key, steps);
  return steps;
}

/**
 * The reveal frontier of every streamed reply in a transcript, for the scroll
 * plan; `null` for messages that are not streamed. Without an engine nothing
 * is known, and the plan paces the follow evenly instead.
 */
export function revealStepsForMessages(
  engine: Engine | undefined,
  probe: {
    timings: MessageTiming[];
    nodes: AnyVNode[];
    width: number;
    keyFor: (timing: MessageTiming) => string;
  },
): Array<RevealStep[] | null> | undefined {
  if (engine === undefined) {
    return undefined;
  }
  return probe.timings.map((timing, index) => {
    const node = probe.nodes[index];
    return timing.message.role === "assistant" && node !== undefined
      ? measureRevealSteps(engine, {
          node,
          width: probe.width,
          key: `${probe.keyFor(timing)}|${timing.startMs}`,
        })
      : null;
  });
}
