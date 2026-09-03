import { type AnimationSpec, type AnyVNode, Box } from "@boundsvg/core";
import { APP_SCROLL_EASE } from "./animations.js";
import type { SceneEnv, ScenePalette } from "./env.js";
import { sizeLeft } from "./env.js";
import type { MessageTiming } from "./timeline.js";

// ————————————————————————————————————————————————————————————————————————————
// Auto-follow scrolling. A real transcript stays pinned to the bottom: every
// time a message pushes content past the viewport the view follows it — the
// app glides, the terminal jumps one row at a time as lines stream in.
// Slide pages get the same treatment: a page whose content fits produces no
// moves (and thus no plan), but an overflowing page follows to its end
// instead of clipping the tail below the viewport.
// ————————————————————————————————————————————————————————————————————————————

type ScrollMove = {
  startMs: number;
  endMs: number;
  fromY: number;
  toY: number;
  /**
   * Whether the block that caused this move printed a line at a time. Only
   * streamed text does; everything else lands in one repaint.
   */
  streamed: boolean;
};

type ScrollPlan = {
  track: AnimationSpec;
  moves: ScrollMove[];
  finalY: number;
  /**
   * Scroll offset in effect when each message starts, before its own follow
   * move. Anything that has to know where the transcript actually sits at a
   * given moment reads it from here rather than recomputing the targets.
   */
  offsets: number[];
} | null;

export function planAutoFollowScroll(options: {
  env: SceneEnv;
  timings: MessageTiming[];
  heights: number[];
  gap: number;
  leadingHeight: number;
  viewportHeight: number;
  durationMs: number;
  surface: "app" | "tui";
}): ScrollPlan {
  const { env, timings, heights, gap, leadingHeight, viewportHeight, durationMs, surface } =
    options;
  // 0 means unlimited: follow the conversation to its end. A positive
  // value is an authored stylistic cap on total scroll travel.
  const capPx =
    env.project.pagination.scrollDistancePx > 0
      ? env.project.pagination.scrollDistancePx
      : Number.POSITIVE_INFINITY;

  const moves: ScrollMove[] = [];
  const offsets: number[] = [];
  // Gaps are between elements, so one is added before each block that has a
  // neighbour above it — never after the last. A trailing gap was a bottom
  // pad the viewport never declared, on top of the one the transcript keeps
  // for itself, and the two together stopped the newest message well short
  // of the space it had.
  let cumulative = leadingHeight;
  let currentY = 0;
  timings.forEach((timing, index) => {
    offsets.push(currentY);
    if (index > 0 || leadingHeight > 0) {
      cumulative += gap;
    }
    cumulative += heights[index] ?? 0;
    const rawTarget = Math.min(capPx, Math.max(0, cumulative - viewportHeight));
    // A terminal scrolls in whole rows — quantize so clipped lines never
    // straddle the viewport edge. The app scrolls to arbitrary pixels.
    const target =
      surface === "tui"
        ? Math.ceil(rawTarget / env.metrics.tuiLinePx) * env.metrics.tuiLinePx
        : rawTarget;
    if (target <= currentY + 1) {
      return;
    }
    // User messages are typed in the composer and land on Enter; everything
    // else scrolls while it reveals. Instant rows settle fast.
    const revealSpanMs = Math.max(120, timing.revealEndMs - timing.startMs);
    const anchorMs = timing.message.role === "user" ? timing.revealEndMs : timing.startMs;
    // Agent output is written a cell at a time, so its rows arrive one by one.
    // Everything else — a picker, an echoed command, a landed user line — is
    // printed whole, and the view follows it in that same repaint.
    const streamed = timing.message.role === "assistant";
    const followMs =
      timing.message.role === "user" ? 360 : streamed ? revealSpanMs : Math.min(revealSpanMs, 420);
    moves.push({
      startMs: anchorMs,
      endMs: Math.min(anchorMs + followMs, durationMs - 40),
      fromY: currentY,
      toY: target,
      streamed,
    });
    currentY = target;
  });
  if (moves.length === 0) {
    return null;
  }

  const progressAt = (atMs: number): number => Math.max(0, Math.min(1, atMs / durationMs));
  const keyframes: Array<{ at: number; transform: { translateY: number } }> = [
    { at: 0, transform: { translateY: 0 } },
  ];
  let lastAt = 0;
  const pushFrame = (atValue: number, y: number): void => {
    const clamped = Math.max(atValue, lastAt + 0.0004);
    if (clamped >= 1) {
      return;
    }
    keyframes.push({ at: clamped, transform: { translateY: -y } });
    lastAt = clamped;
  };

  for (const move of moves) {
    pushFrame(progressAt(move.startMs), move.fromY);
    if (surface === "tui" && !move.streamed) {
      // One repaint printed the whole block, so one repaint scrolls past it.
      // Rolling those rows past the reader instead reads as a stutter, and
      // under a following camera the two motions visibly fight.
      pushFrame(progressAt(move.startMs), move.toY);
    } else if (surface === "tui") {
      // Row-by-row jumps: the terminal repaints a whole line at a time.
      const rowPx = env.metrics.tuiLinePx;
      const rows = Math.max(1, Math.ceil((move.toY - move.fromY) / rowPx));
      for (let row = 1; row <= rows; row += 1) {
        const rowTimeMs = move.startMs + ((move.endMs - move.startMs) * row) / rows;
        const rowY = Math.min(move.fromY + row * rowPx, move.toY);
        pushFrame(progressAt(rowTimeMs - 34), Math.min(move.fromY + (row - 1) * rowPx, move.toY));
        pushFrame(progressAt(rowTimeMs), rowY);
      }
    } else {
      pushFrame(progressAt(move.endMs), move.toY);
    }
  }
  keyframes.push({ at: 1, transform: { translateY: -currentY } });

  return {
    track: {
      keyframes,
      durationMs,
      easing: surface === "tui" ? "linear" : APP_SCROLL_EASE,
      fill: "both",
    },
    moves,
    finalY: currentY,
    offsets,
  };
}

/** App scrollbar thumb mirroring the transcript's auto-follow track. */
export function appScrollbarThumb(options: {
  palette: ScenePalette;
  plan: ScrollPlan | undefined;
  viewportHeight: number;
  contentHeight: number;
  durationMs: number;
}): AnyVNode | null {
  const { palette, plan, viewportHeight, contentHeight, durationMs } = options;
  if (!plan || contentHeight <= viewportHeight) {
    return null;
  }
  const trackInset = 6;
  const trackHeight = sizeLeft(viewportHeight, trackInset * 2);
  const thumbHeight = Math.max(
    36,
    Math.round((trackHeight * viewportHeight) / Math.max(contentHeight, viewportHeight)),
  );
  const travel = Math.max(0, trackHeight - thumbHeight);
  const maxY = Math.max(plan.finalY, 1);
  const factor = travel / maxY;
  const keyframes = plan.track.keyframes.map((frame) => ({
    at: frame.at,
    transform: { translateY: -(frame.transform?.translateY ?? 0) * factor },
  }));
  return Box({
    position: "absolute",
    right: 4,
    top: trackInset,
    width: 5,
    height: thumbHeight,
    borderRadius: 3,
    background: palette.faint,
    opacity: 0.55,
    // A viewport short enough that the minimum thumb fills its own track
    // leaves the thumb no travel; the mirrored keyframes all collapse to
    // zero, and a track that never moves is not worth carrying.
    ...(travel > 0
      ? { animate: { keyframes, durationMs, easing: APP_SCROLL_EASE, fill: "both" } }
      : {}),
  });
}
