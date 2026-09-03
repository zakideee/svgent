import type { SvgentProject } from "@svgent/scene";
import { buildTimeline, paginateMessages } from "@svgent/scene";

export type TimelineSegment = {
  pageIndex: number;
  messageIds: string[];
  startMs: number;
  endMs: number;
  durationMs: number;
  keyframeTimesMs: [number, number, number];
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function keyframeTimes(startMs: number, endMs: number): [number, number, number] {
  return [startMs, startMs + (endMs - startMs) / 2, endMs];
}

/** Locate only the timeline windows touched by a patch, grouped by slide page. */
export function locateTimelineSegments(
  project: SvgentProject,
  messageIds: readonly string[],
  paddingMs = 420,
): TimelineSegment[] {
  const requested = new Set(messageIds);
  const found = new Set<string>();
  const segments: TimelineSegment[] = [];
  for (const [pageIndex, messages] of paginateMessages(project).entries()) {
    const timeline = buildTimeline(project, messages);
    const affected = timeline.messages.filter((timing) => requested.has(timing.message.id));
    if (affected.length === 0) {
      continue;
    }
    for (const timing of affected) {
      found.add(timing.message.id);
    }
    const first = affected[0];
    const last = affected.at(-1);
    if (!first || !last) {
      continue;
    }
    const startMs = clamp(first.startMs - paddingMs, 0, timeline.durationMs);
    const endMs = clamp(last.settledMs + paddingMs, startMs, timeline.durationMs);
    segments.push({
      pageIndex,
      messageIds: affected.map((timing) => timing.message.id),
      startMs,
      endMs,
      durationMs: endMs - startMs,
      keyframeTimesMs: keyframeTimes(startMs, endMs),
    });
  }
  const missing = messageIds.filter((messageId) => !found.has(messageId));
  if (missing.length > 0) {
    throw new Error(`Unknown messageId: ${missing.join(", ")}`);
  }
  return segments;
}
