import type { AnimationSpec } from "@boundsvg/core";
import type { SvgentProject } from "./model.js";
import { type HighlightWindow, highlightWindow, type SessionTimeline } from "./timeline.js";

// ————————————————————————————————————————————————————————————————————————————
// Highlight beats on the App transcript. A replayed transcript is append-only:
// when a highlighted thinking row settles, nothing has landed below it yet, so
// there are no rows to push aside — the note opens into empty column space.
// What can hide it is the viewport: a conversation that has already scrolled
// pins its latest row near the bottom edge, and the note would open under the
// clip. The beat therefore lifts the whole scrolled column just far enough to
// keep the opened note inside the viewport, and lets it back down on close —
// the same one-layer-one-job shape the composer stand-off uses.
//
// Known limitation, deferred to camera planning: with camera.follow on, the
// shot anchored at the highlighted row frames the row's own ink and holds
// through the beat, so a zoomed camera can crop the opened note — and the
// lift moves the framed row while the camera aims at its unlifted place.
// Follow defaults off; widening the beat's camera target belongs with
// planCameraTrack.
// ————————————————————————————————————————————————————————————————————————————

/** Gap between the settled row and the note that opens beneath it. */
const HIGHLIGHT_NOTE_GAP_PX = 8;

/** Viewport breathing room kept under the opened note while lifted. */
const LIFT_MARGIN_PX = 10;

export type AppHighlightBeat = {
  /** Timeline index of the highlighted thinking row. */
  index: number;
  window: HighlightWindow;
  /** Height of the opened note, excluding the gap above it. */
  notePx: number;
  /** Y of the note's top edge inside the content column. */
  noteTopPx: number;
};

/** Measure each highlighted row's note once with the caller's measurer. */
export function collectHighlightNoteHeights(
  timeline: SessionTimeline,
  measure: (content: string) => number,
): Map<number, number> {
  const noteHeights = new Map<number, number>();
  for (const [index, timing] of timeline.messages.entries()) {
    if (timing.message.role === "thinking" && timing.message.highlight === true) {
      noteHeights.set(index, measure(timing.message.content));
    }
  }
  return noteHeights;
}

/**
 * Where each beat's note sits in the column. Beats whose window would run
 * past the clamped project duration are skipped rather than left straddling
 * the cut — a truncated beat would freeze the note open in the final frame.
 */
export function planAppHighlights(options: {
  project: SvgentProject;
  timeline: SessionTimeline;
  heights: number[];
  gap: number;
  noteHeights: Map<number, number>;
  /** Stills lay their notes out in flow, so they have no beat to play. */
  openNotes?: boolean;
}): AppHighlightBeat[] {
  const { project, timeline, heights, gap, noteHeights } = options;
  const beats: AppHighlightBeat[] = [];
  if (project.surface !== "app" || options.openNotes === true) {
    return beats;
  }
  timeline.messages.forEach((timing, index) => {
    const window = highlightWindow(timing, project);
    const notePx = noteHeights.get(index);
    if (window === null || notePx === undefined || notePx <= 0) {
      return;
    }
    if (window.returnMs > timeline.durationMs) {
      return;
    }
    const blockTop = heights.slice(0, index).reduce((sum, height) => sum + height + gap, 0);
    beats.push({
      index,
      window,
      notePx,
      noteTopPx: blockTop + (heights[index] ?? 0) + HIGHLIGHT_NOTE_GAP_PX,
    });
  });
  return beats;
}

/**
 * How far the column must rise for one beat's note to clear the viewport
 * clip. Zero when the conversation has not scrolled the row near the bottom —
 * the common case for a beat early in a session.
 */
export function beatLiftPx(options: {
  beat: AppHighlightBeat;
  contentOffsetY: number;
  scrollOffsetPx: number;
  viewportPx: number;
}): number {
  const noteBottomInViewport =
    options.contentOffsetY + options.beat.noteTopPx + options.beat.notePx - options.scrollOffsetPx;
  return Math.max(0, noteBottomInViewport - (options.viewportPx - LIFT_MARGIN_PX));
}

/**
 * The lift every beat needs, as one track. The scroll offset in effect
 * during a beat is the one after that row's own follow move; the last row
 * holds the plan's final offset.
 */
export function planBeatLift(options: {
  beats: AppHighlightBeat[];
  contentOffsetY: number;
  scrollOffsets: { offsets: number[]; finalY: number } | null | undefined;
  viewportPx: number;
  durationMs: number;
}): AnimationSpec | null {
  const { beats, contentOffsetY, scrollOffsets, viewportPx, durationMs } = options;
  return beatLiftTrack(
    beats.map((beat) => ({
      window: beat.window,
      liftPx: beatLiftPx({
        beat,
        contentOffsetY,
        scrollOffsetPx: scrollOffsets?.offsets[beat.index + 1] ?? scrollOffsets?.finalY ?? 0,
        viewportPx,
      }),
    })),
    durationMs,
  );
}

/**
 * All beats' lifts on one track: level between windows, risen through each
 * hold. Beats own disjoint slices of the timeline, so segments concatenate.
 */
function beatLiftTrack(
  lifts: Array<{ window: HighlightWindow; liftPx: number }>,
  durationMs: number,
): AnimationSpec | null {
  const moving = lifts.filter((lift) => lift.liftPx > 0.5);
  if (moving.length === 0) {
    return null;
  }
  const at = (timeMs: number) => Math.min(1, Math.max(0, timeMs / durationMs));
  const up = (px: number) => ({ transform: { translateY: px === 0 ? 0 : -px } });
  const keyframes = [{ at: 0, ...up(0) }];
  for (const { window, liftPx } of [...moving].sort(
    (a, b) => a.window.startMs - b.window.startMs,
  )) {
    keyframes.push(
      { at: at(window.startMs), ...up(0) },
      { at: at(window.arriveMs), ...up(liftPx) },
      { at: at(window.holdEndMs), ...up(liftPx) },
      { at: at(window.returnMs), ...up(0) },
    );
  }
  keyframes.push({ at: 1, ...up(0) });
  return {
    keyframes: keyframes.filter(
      (keyframe, index, all) => index === 0 || keyframe.at > (all[index - 1]?.at ?? -1),
    ),
    durationMs,
    easing: "ease-in-out",
    fill: "both",
  };
}
