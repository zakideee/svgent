import {
  type AnimationSpec,
  aimTransform,
  buildAnimationTrack,
  clampAimCenter,
  fitZoom,
  type TrackFrameInput,
} from "@boundsvg/core";
import { APP_SCROLL_EASE } from "./animations.js";
import type { CameraStyle } from "./model.js";
import type { MessageTiming } from "./timeline.js";

// ————————————————————————————————————————————————————————————————————————————
// Deterministic camera work. Screen recorders infer a camera from
// live signals; svgent knows every reveal time and every measured rect
// before rendering, so the camera is planned like the auto-follow scroll:
// timeline + geometry in, one declarative multi-keyframe transform track
// out. Each shot frames the subject's real rect — the typed draft in the
// composer, then the bubble it becomes, at that bubble's own width — and
// the zoom setting only caps how far the lean-in may go: wide subjects
// get a gentle zoom, narrow ones a strong one, and a subject the frame
// cannot hold pulls the camera out to the full view.
// ————————————————————————————————————————————————————————————————————————————

/** How long one camera glide takes. Calm on purpose. */
const CAMERA_GLIDE_MS = 620;
/** Re-aim only when the target center moved at least this far. */
const CAMERA_RETARGET_MIN_PX = 56;
/** …or when the fitted zoom changed at least this much. */
const CAMERA_REZOOM_MIN = 0.12;
/** The pull back to the full view before the final hold. */
const CAMERA_TAIL_MS = 1_100;
/** The fastest a glide may get when the timeline runs dense. */
const CAMERA_GLIDE_MIN_MS = 240;
/** A landed shot dwells at least this long before the next glide. */
const CAMERA_LAND_DWELL_MS = 200;
/** How far the "trail" style lags behind its event, live-recording style. */
const CAMERA_TRAIL_LAG_MS = 350;
/** Breathing room the frame keeps around a subject. */
const CAMERA_FRAME_PAD = 56;
/** Below this fitted zoom a shot is just the full view. */
const CAMERA_ENGAGE_MIN = 1.08;

/** One scroll move, structurally (the scroll plan's own type stays local). */
type ScrollMoveLike = {
  startMs: number;
  toY: number;
};

/** A canvas-space rectangle the camera should frame. */
type CameraTarget = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function planCameraTrack(options: {
  timings: MessageTiming[];
  heights: number[];
  gap: number;
  /** Canvas Y where the transcript content starts (viewport top + inset). */
  contentTop: number;
  /** Canvas X where transcript rows start. */
  rowLeft: number;
  /** Each message's horizontal band inside the row (surface-specific). */
  messageBands: Array<{ offsetX: number; width: number }>;
  /** Content stacked above the first message (page banners and the like). */
  leadingHeight: number;
  /** The typed-draft rect per user message, while its typing runs. */
  typingTargets: Array<{ startMs: number; target: CameraTarget; kind?: string }>;
  /**
   * Close-ups inside messages (a choice's options as the pick commits,
   * an attached-image stack once its banners land). Targets live in
   * content space: the plan applies the scroll offset itself.
   */
  extraShots: Array<{ anchorMs: number; target: CameraTarget; kind: string }>;
  /**
   * Ink width per message — how far the text actually runs inside its
   * band. The camera frames this, not the reserved box.
   */
  contentWidths: number[];
  scrollMoves: readonly ScrollMoveLike[];
  canvasWidth: number;
  canvasHeight: number;
  durationMs: number;
  /** Upper bound for the lean-in; each shot fits its subject under it. */
  zoom: number;
  /** Landing grammar: arrive first, with, or after the event. */
  style: CameraStyle;
  /**
   * Messages that get no aim of their own — a collapsed choice's record,
   * whose live picker is aimed at through another channel; a tiny target
   * here would normalise to a full-frame cut and read as a zoom bounce.
   */
  omitMessageAim?: (timing: MessageTiming) => boolean;
  /** Drop shots that would hold shorter than this (0 keeps every shot). */
  minShotMs?: number;
}): AnimationSpec | null {
  const {
    timings,
    heights,
    gap,
    contentTop,
    rowLeft,
    messageBands,
    leadingHeight,
    typingTargets,
    extraShots,
    contentWidths,
    scrollMoves,
    canvasWidth,
    canvasHeight,
    durationMs,
    zoom,
    style,
  } = options;
  const omitMessageAim = options.omitMessageAim ?? (() => false);
  if (timings.length === 0 || zoom <= 1.05 || durationMs <= CAMERA_TAIL_MS) {
    return null;
  }

  // The scroll offset a message settles at: the last move that has started
  // by then. Both tracks ease over the same window, so aiming at the
  // settled position keeps camera and scroll landing together.
  const scrollYAfter = (atMs: number): number => {
    let y = 0;
    for (const move of scrollMoves) {
      if (move.startMs <= atMs) {
        y = move.toY;
      }
    }
    return y;
  };

  // Fit the frame to the subject: the zoom setting caps the lean-in, the
  // subject's own size caps it harder. A subject too large to frame gets
  // the full view instead of a crop.
  const viewport = { width: canvasWidth, height: canvasHeight };
  const fittedZoom = (target: CameraTarget): number =>
    fitZoom(target, viewport, { maxZoom: zoom, padPx: CAMERA_FRAME_PAD });

  type Shot = { anchorMs: number; cx: number; cy: number; k: number; trackUntilMs?: number };
  const shotFor = (anchorMs: number, target: CameraTarget, k: number): Shot => {
    const center = clampAimCenter(
      { x: target.x + target.width / 2, y: target.y + target.height / 2 },
      viewport,
      k,
    );
    return { anchorMs, cx: center.x, cy: center.y, k };
  };

  const shots: Shot[] = [];
  const pushShot = (shot: Shot): void => {
    if (shot.anchorMs >= durationMs - CAMERA_TAIL_MS) {
      return;
    }
    const engaged = shot.k >= CAMERA_ENGAGE_MIN;
    const normalized = engaged
      ? shot
      : { ...shot, k: 1, cx: canvasWidth / 2, cy: canvasHeight / 2 };
    const previous = shots[shots.length - 1];
    if (
      previous &&
      Math.abs(normalized.cx - previous.cx) < CAMERA_RETARGET_MIN_PX &&
      Math.abs(normalized.cy - previous.cy) < CAMERA_RETARGET_MIN_PX &&
      Math.abs(normalized.k - previous.k) < CAMERA_REZOOM_MIN
    ) {
      return;
    }
    shots.push(normalized);
  };

  // One timed target list: the typed draft (fixed on the canvas), each
  // landed message (content space, at its ink width), and the in-message
  // close-ups. Sorted so the shot merge always compares true neighbours.
  type Entry = {
    anchorMs: number;
    target: CameraTarget;
    space: "fixed" | "content";
    kind: string;
    /**
     * A streamed subject grows while it reveals: gliding to its finished
     * frame and then chasing the scroll reads as a pendulum. Tracking
     * stretches the one glide across the reveal instead, so the camera
     * drifts diagonally with the growth in a single motion.
     */
    trackUntilMs?: number;
  };
  const entries: Entry[] = typingTargets.map(({ startMs, target, kind }) => ({
    anchorMs: startMs,
    target,
    space: "fixed",
    // A picker panel names its own kind: sharing the draft's would drag
    // one zoom down to the other's subject and turn a lean-in into a
    // full-frame cut.
    kind: kind ?? "draft",
  }));
  let contentY = leadingHeight > 0 ? leadingHeight + gap : 0;
  timings.forEach((timing, index) => {
    const height = heights[index] ?? 0;
    if (omitMessageAim(timing)) {
      contentY += height + gap;
      return;
    }
    const anchorMs = timing.message.role === "user" ? timing.revealEndMs : timing.startMs;
    const band = messageBands[index] ?? { offsetX: 0, width: 0 };
    entries.push({
      anchorMs,
      target: {
        x: rowLeft + band.offsetX,
        y: contentTop + contentY,
        width: Math.min(band.width, contentWidths[index] ?? band.width),
        height,
      },
      space: "content",
      kind: timing.message.role,
      ...(timing.message.role === "assistant" ? { trackUntilMs: timing.revealEndMs } : {}),
    });
    contentY += height + gap;
  });
  entries.push(
    ...extraShots.map(({ anchorMs, target, kind }) => ({
      anchorMs,
      target,
      space: "content" as const,
      kind,
    })),
  );
  entries.sort((a, b) => a.anchorMs - b.anchorMs);
  // One zoom per kind: within a script, two tool runs (or two replies)
  // must lean in identically, or the length difference reads as an
  // importance difference. The widest subject of a kind sets its zoom;
  // only image close-ups keep a per-shot fit, because their subjects are
  // visibly different things.
  const kindZoom = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind === "images") {
      continue;
    }
    const fit = fittedZoom(entry.target);
    kindZoom.set(entry.kind, Math.min(kindZoom.get(entry.kind) ?? Number.POSITIVE_INFINITY, fit));
  }
  for (const entry of entries) {
    const scrolled =
      entry.space === "content"
        ? { ...entry.target, y: entry.target.y - scrollYAfter(entry.anchorMs) }
        : entry.target;
    const k = entry.kind === "images" ? fittedZoom(scrolled) : (kindZoom.get(entry.kind) ?? 1);
    const shot = shotFor(entry.anchorMs, scrolled, k);
    pushShot(
      entry.trackUntilMs === undefined ? shot : { ...shot, trackUntilMs: entry.trackUntilMs },
    );
  }
  // Below the authored threshold a shot is a twitch: the camera leans in
  // and is called away before the look registers. Tracked shots ride a
  // reveal for their whole span, so the hold measure does not apply.
  const minShotMs = options.minShotMs ?? 0;
  const heldShots =
    minShotMs <= 0
      ? shots
      : shots.filter((shot, index) => {
          const nextAnchorMs = shots[index + 1]?.anchorMs;
          if (shot.trackUntilMs !== undefined || nextAnchorMs === undefined) {
            return true;
          }
          return nextAnchorMs - shot.anchorMs >= minShotMs;
        });
  if (heldShots.every((shot) => shot.k <= 1)) {
    return null;
  }

  // The aim math (bbox-center scale origin included) lives in boundsvg;
  // the camera only decides where and when.
  const identity = aimTransform({ x: 0, y: 0 }, viewport, 1);
  const aimedAt = (shot: Shot) => aimTransform({ x: shot.cx, y: shot.cy }, viewport, shot.k);

  const frames: TrackFrameInput[] = [{ atMs: 0, transform: identity }];
  const pushFrame = (atMs: number, transform: TrackFrameInput["transform"]): void => {
    frames.push({ atMs, transform });
  };

  let current = identity;
  // Landing grammar. "sync" starts on the event and shortens the glide
  // when the timeline runs dense, so the camera arrives with its subject
  // instead of drifting behind and letting events happen out of frame.
  // "anticipate" starts early to land exactly on the event (staged-
  // lecture confidence); "trail" starts late on purpose (live-recording
  // pursuit). A small dwell floor keeps consecutive glides from
  // overlapping in any style.
  let earliestNextMs = 0;
  heldShots.forEach((shot, index) => {
    const nextAnchorMs = heldShots[index + 1]?.anchorMs ?? Number.POSITIVE_INFINITY;
    const idealStartMs =
      style === "anticipate"
        ? shot.anchorMs - CAMERA_GLIDE_MS
        : style === "trail"
          ? shot.anchorMs + CAMERA_TRAIL_LAG_MS
          : shot.anchorMs;
    const startMs = Math.max(idealStartMs, earliestNextMs, 0);
    if (startMs >= durationMs - CAMERA_TAIL_MS) {
      return;
    }
    const availableMs =
      style === "anticipate"
        ? shot.anchorMs - startMs
        : nextAnchorMs - startMs - CAMERA_LAND_DWELL_MS;
    // A tracked shot rides its subject's whole reveal: one diagonal drift
    // in step with the stream, instead of a glide and a scroll-chase.
    const targetGlideMs =
      shot.trackUntilMs !== undefined
        ? Math.max(CAMERA_GLIDE_MIN_MS, shot.trackUntilMs - startMs)
        : CAMERA_GLIDE_MS;
    const glideMs = Math.min(targetGlideMs, Math.max(CAMERA_GLIDE_MIN_MS, availableMs));
    pushFrame(startMs, current);
    current = aimedAt(shot);
    pushFrame(startMs + glideMs, current);
    earliestNextMs = startMs + glideMs + CAMERA_LAND_DWELL_MS;
  });
  // Pull back out so the final hold reads the whole conversation.
  pushFrame(durationMs - CAMERA_TAIL_MS, current);
  pushFrame(durationMs, identity);

  return buildAnimationTrack({
    durationMs,
    frames,
    easing: APP_SCROLL_EASE,
    fill: "both",
  });
}
