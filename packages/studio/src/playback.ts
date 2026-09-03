/**
 * Preview playback: the WAAPI animation clock, the loop watcher, the
 * paused-frame seek, and page visibility. The preview is driven entirely
 * by the SVG's own CSS animations — React holds no playback clock.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

/** Beat on the final frame before a looping preview restarts from the top. */
const LOOP_HOLD_MS = 900;
/** Timeline granularity for the slider and the step buttons — CSS
    animations are continuous, so a "frame" is this authoring grid. */
export const FRAME_STEP_MS = 40;

/** Always one decimal ("12.0s", never "12s") so the playback readout
    keeps a fixed width instead of flickering as tenths pass zero. */
export function formatDuration(durationMs: number): string {
  return `${(Math.round(durationMs / 100) / 10).toFixed(1)}s`;
}

export function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** All CSS animations driving the preview SVG inside the stage. */
function previewAnimations(stage: HTMLElement | null): Animation[] {
  const svg = stage?.querySelector(".svg-preview svg");
  return svg ? svg.getAnimations({ subtree: true }) : [];
}

/**
 * The animations' shared clock in ms — the authoritative playback time.
 * A JS elapsed-time estimate would drift on slow starts and background
 * throttling; currentTime cannot disagree with the pixels. The furthest
 * clock of the set, because animations start as style reaches them and a
 * late starter would report the whole piece behind where it is.
 */
export function readAnimationTimeMs(stage: HTMLElement | null): number | null {
  let furthest: number | null = null;
  for (const animation of previewAnimations(stage)) {
    const time = animation.currentTime;
    if (typeof time === "number" && (furthest === null || time > furthest)) {
      furthest = time;
    }
  }
  return furthest;
}

/**
 * Jump every animation to the same moment; paused frames follow along.
 * This deliberately writes local currentTime where the site pages seek by
 * startTime: the preview mounts in one style pass and only seeks while
 * paused, so the uniform write realigns rather than scatters — and setting
 * startTime would set the animations running and permanently detach them
 * from the animation-play-state rule that .is-paused pauses with.
 */
function seekAnimations(stage: HTMLElement | null, timeMs: number): void {
  for (const animation of previewAnimations(stage)) {
    animation.currentTime = timeMs;
  }
}

// document.hidden as an external store: reading it on mount (instead of
// defaulting to visible) keeps a tab opened in the background paused.
function subscribePageVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function readPageVisible(): boolean {
  return !document.hidden;
}

/** Whether the tab is visible; a hidden tab pauses playback and the loop. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribePageVisibility, readPageVisible);
}

/**
 * Playback is a loop: each pass holds the final frame for a beat, then
 * restarts via `onLoopRestart` (the timeline is one-shot CSS animations,
 * so CSS cannot loop it). The watcher and the slider readout both run on
 * the animations' own clock; the per-frame updates go straight to the
 * DOM through the returned refs so the 60fps tick never re-renders the
 * app. While paused, the frame follows `sampleTimeMs` instead: slider
 * drags, message follow-jumps, and remounts (scene edits rebuild the SVG
 * at t=0) all land on the moment the slider shows.
 */
export function usePlaybackClock(options: {
  playing: boolean;
  pageVisible: boolean;
  staticHoldActive: boolean;
  /** The rendered SVG markup, not a boolean: a scene rebuild remounts the
      animations at t=0, and the paused seek must re-run exactly then. */
  previewSvg: string | null;
  durationMs: number;
  sampleTimeMs: number;
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** Restart the preview after the final-frame hold; must be stable. */
  onLoopRestart: () => void;
}) {
  const {
    playing,
    pageVisible,
    staticHoldActive,
    previewSvg,
    durationMs,
    sampleTimeMs,
    stageRef,
    onLoopRestart,
  } = options;
  const scrubInputRef = useRef<HTMLInputElement>(null);
  const scrubOutputRef = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    if (!playing || !pageVisible || staticHoldActive || previewSvg === null) {
      return;
    }
    let frame = 0;
    let holdTimer = 0;
    const tick = () => {
      const timeMs = readAnimationTimeMs(stageRef.current);
      const clampedMs = Math.min(timeMs ?? 0, durationMs);
      if (scrubInputRef.current) {
        scrubInputRef.current.value = String(clampedMs);
      }
      if (scrubOutputRef.current) {
        scrubOutputRef.current.textContent = formatDuration(clampedMs);
      }
      if (timeMs !== null && timeMs >= durationMs) {
        holdTimer = window.setTimeout(onLoopRestart, LOOP_HOLD_MS);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(holdTimer);
    };
  }, [playing, pageVisible, staticHoldActive, previewSvg, durationMs, stageRef, onLoopRestart]);
  useEffect(() => {
    if (playing || previewSvg === null) {
      return;
    }
    seekAnimations(stageRef.current, sampleTimeMs);
    if (scrubInputRef.current) {
      scrubInputRef.current.value = String(sampleTimeMs);
    }
    if (scrubOutputRef.current) {
      scrubOutputRef.current.textContent = formatDuration(sampleTimeMs);
    }
  }, [playing, sampleTimeMs, previewSvg, stageRef]);
  return { scrubInputRef, scrubOutputRef };
}
