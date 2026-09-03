import {
  buildTimeline,
  MESSAGE_TIMING_LIMITS,
  paginateMessages,
  type SvgentProject,
} from "@svgent/scene";
import { applyScenePatch, type ScenePatchOperation } from "./patches.js";

type FitDurationRequest = {
  pageIndex: number;
  targetMs: number;
  preserveMessageIds?: readonly string[];
};

type FitDurationResult = {
  pageIndex: number;
  targetMs: number;
  beforeMs: number;
  afterMs: number;
  constrained: boolean;
  operations: ScenePatchOperation[];
};

const BINARY_SEARCH_STEPS = 32;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type FactorRequest = {
  pageIndex: number;
  preserved: ReadonlySet<string>;
  factor: number;
};

function operationsForFactor(
  project: SvgentProject,
  request: FactorRequest,
): ScenePatchOperation[] {
  const messages = paginateMessages(project)[request.pageIndex] ?? [];
  const timeline = buildTimeline(project, messages);
  return timeline.messages.flatMap((timing, index): ScenePatchOperation[] => {
    if (request.preserved.has(timing.message.id)) {
      return [];
    }
    const previous = timeline.messages[index - 1];
    const pauseBeforeMs = timing.startMs - (previous?.settledMs ?? 180);
    const durationMs = timing.revealEndMs - timing.startMs;
    const transitionMs = timing.settledMs - timing.revealEndMs;
    // A user turn with no composer has no duration of its own — the bubble
    // lands the moment it starts. Writing one would clamp a zero up to the
    // floor and leave that budget in the script; keeping one an earlier fit
    // wrote (while the composer was visible, when it stood for typing time)
    // would hold a still frame for as long as the sentence used to take. A
    // fit-written hold is indistinguishable from a hand-authored one, so the
    // field is cleared rather than honoured: with no prompt there is nothing
    // for it to time.
    if (timing.message.role === "user" && !project.display.composer) {
      return [
        {
          op: "set-message-timing",
          messageId: timing.message.id,
          changes: {
            durationMs: null,
            pauseBeforeMs: Math.round(
              clamp(
                pauseBeforeMs * request.factor,
                MESSAGE_TIMING_LIMITS.pauseBeforeMs.min,
                MESSAGE_TIMING_LIMITS.pauseBeforeMs.max,
              ),
            ),
            transitionMs: Math.round(
              clamp(
                transitionMs * request.factor,
                MESSAGE_TIMING_LIMITS.transitionMs.min,
                MESSAGE_TIMING_LIMITS.transitionMs.max,
              ),
            ),
          },
        },
      ];
    }
    return [
      {
        op: "set-message-timing",
        messageId: timing.message.id,
        changes: {
          durationMs: Math.round(
            clamp(
              durationMs * request.factor,
              MESSAGE_TIMING_LIMITS.durationMs.min,
              MESSAGE_TIMING_LIMITS.durationMs.max,
            ),
          ),
          pauseBeforeMs: Math.round(
            clamp(
              pauseBeforeMs * request.factor,
              MESSAGE_TIMING_LIMITS.pauseBeforeMs.min,
              MESSAGE_TIMING_LIMITS.pauseBeforeMs.max,
            ),
          ),
          transitionMs: Math.round(
            clamp(
              transitionMs * request.factor,
              MESSAGE_TIMING_LIMITS.transitionMs.min,
              MESSAGE_TIMING_LIMITS.transitionMs.max,
            ),
          ),
        },
      },
    ];
  });
}

function durationAfter(
  project: SvgentProject,
  pageIndex: number,
  operations: ScenePatchOperation[],
) {
  const fitted = applyScenePatch(project, operations).project;
  const messages = paginateMessages(fitted)[pageIndex] ?? [];
  return buildTimeline(fitted, messages).durationMs;
}

function validateRequest(project: SvgentProject, request: FitDurationRequest): Set<string> {
  const pages = paginateMessages(project);
  if (
    !Number.isInteger(request.pageIndex) ||
    request.pageIndex < 0 ||
    request.pageIndex >= pages.length
  ) {
    throw new Error(`pageIndex must be in 0..${Math.max(0, pages.length - 1)}`);
  }
  if (
    !Number.isFinite(request.targetMs) ||
    request.targetMs < 1_000 ||
    request.targetMs > 120_000
  ) {
    throw new Error("targetMs must be in 1000..120000");
  }
  const messageIds = new Set(project.messages.map((message) => message.id));
  const preserved = new Set(request.preserveMessageIds ?? []);
  for (const messageId of preserved) {
    if (!messageIds.has(messageId)) {
      throw new Error(`Unknown preserved messageId "${messageId}"`);
    }
  }
  const editable = (pages[request.pageIndex] ?? []).some((message) => !preserved.has(message.id));
  if (!editable) {
    throw new Error("No editable messages remain on the requested page");
  }
  return preserved;
}

export function fitSceneDuration(
  project: SvgentProject,
  request: FitDurationRequest,
): FitDurationResult {
  const preserved = validateRequest(project, request);
  const pageMessages = paginateMessages(project)[request.pageIndex] ?? [];
  const beforeMs = buildTimeline(project, pageMessages).durationMs;
  let low = 0;
  let high = 64;
  let bestOperations = operationsForFactor(project, {
    pageIndex: request.pageIndex,
    preserved,
    factor: 1,
  });
  let bestDuration = durationAfter(project, request.pageIndex, bestOperations);
  for (let step = 0; step < BINARY_SEARCH_STEPS; step += 1) {
    const factor = (low + high) / 2;
    const operations = operationsForFactor(project, {
      pageIndex: request.pageIndex,
      preserved,
      factor,
    });
    const durationMs = durationAfter(project, request.pageIndex, operations);
    if (Math.abs(durationMs - request.targetMs) < Math.abs(bestDuration - request.targetMs)) {
      bestOperations = operations;
      bestDuration = durationMs;
    }
    if (durationMs < request.targetMs) {
      low = factor;
    } else {
      high = factor;
    }
  }
  return {
    pageIndex: request.pageIndex,
    targetMs: request.targetMs,
    beforeMs,
    afterMs: bestDuration,
    constrained: Math.abs(bestDuration - request.targetMs) > 80,
    operations: bestOperations,
  };
}
