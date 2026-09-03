import type { AnimationSpec } from "@boundsvg/core";
import { keyframeTrack } from "./animations.js";
import { analyzeDraftTyping } from "./draft-typing.js";
import type { MessageTiming } from "./timeline.js";

export { planComposerDraft } from "./draft-layout.js";
export { planDraftTyping } from "./draft-typing.js";

type TimeWindow = { startMs: number; endMs: number; sendMs: number };

/**
 * The beat between the last keystroke and the send itself — real chat UIs
 * pause here before the message leaves the composer. It lives inside the
 * message's transition gap, so the overall timeline length is untouched.
 */
export function sendMomentMs(timing: MessageTiming): number {
  const gap = Math.max(0, timing.settledMs - timing.revealEndMs);
  return timing.revealEndMs + Math.min(420, gap * 0.7);
}

/** When a sent user message lands in the transcript: right after the send fires. */
export function userLandingMs(timing: MessageTiming): number {
  return Math.min(timing.settledMs, sendMomentMs(timing) + 70);
}

export function userTypingWindows(timings: MessageTiming[]): TimeWindow[] {
  return timings
    .filter((timing) => timing.message.role === "user")
    .map((timing) => ({
      startMs: timing.startMs,
      endMs: timing.revealEndMs,
      sendMs: sendMomentMs(timing),
    }));
}

/**
 * When a voice capture stops and the transcript lands. The last ~30% of the
 * input window is reading time — people glance over a transcription to see
 * whether it came out right before sending, in a way typed text never
 * needs — with a floor so even a short capture leaves a visible beat.
 */
export function voiceConfirmMs(timing: MessageTiming): number {
  const windowMs = timing.revealEndMs - timing.startMs;
  const reviewMs = Math.max(700, windowMs * 0.3);
  return Math.max(timing.startMs + 200, timing.revealEndMs - reviewMs);
}

/**
 * Capture windows of voice-input user messages: level bars run from the
 * input start to the confirm moment, where the transcript lands whole,
 * sits for the review beat, and the normal send flow takes over.
 */
export function voiceCaptureWindows(timings: MessageTiming[]): TimeWindow[] {
  return timings
    .filter((timing) => timing.message.role === "user" && timing.message.inputMode === "voice")
    .map((timing) => ({
      startMs: timing.startMs,
      endMs: voiceConfirmMs(timing),
      sendMs: sendMomentMs(timing),
    }));
}

/** Voice drafts land whole at the confirm moment, then leave like a typed draft. */
export function voiceConfirmedDraftAnimation(
  timing: MessageTiming,
  durationMs: number,
): AnimationSpec {
  const confirmMs = voiceConfirmMs(timing);
  const sendMs = sendMomentMs(timing);
  const lift = (opacity: number, translateY: number) => ({ opacity, transform: { translateY } });
  const track = keyframeTrack({ durationMs, first: lift(0, 0) });
  track.push(confirmMs - 8, lift(0, 0));
  track.push(confirmMs, lift(1, 0));
  track.push(sendMs, lift(1, 0));
  track.push(sendMs + 150, lift(0, -12));
  return {
    keyframes: track.close(lift(0, -12)),
    durationMs,
    easing: "ease-in",
    fill: "both",
  };
}

/**
 * Chrome swap for voice capture: the mic yields its spot while a capture
 * is live and the confirm control takes it, matching real voice UIs where
 * the mic icon disappears during recording.
 */
export function voiceChromeAnimation(
  windows: TimeWindow[],
  durationMs: number,
  visibleDuringCapture: boolean,
): AnimationSpec | undefined {
  if (windows.length === 0) {
    return undefined;
  }
  const idle = visibleDuringCapture ? 0 : 1;
  const live = visibleDuringCapture ? 1 : 0;
  const track = keyframeTrack({ durationMs, first: { opacity: idle } });
  for (const window of windows) {
    track.push(window.startMs - 1, { opacity: idle });
    track.push(window.startMs + 120, { opacity: live });
    track.push(window.endMs - 1, { opacity: live });
    track.push(window.endMs + 120, { opacity: idle });
  }
  return {
    keyframes: track.close({ opacity: idle }),
    durationMs,
    easing: "ease-out",
    fill: "both",
  };
}

/**
 * Hides idle composer content (placeholder, resting cursor) while a scripted
 * user message is being typed there, and brings it back after Enter.
 */
export function composerIdleAnimation(
  windows: TimeWindow[],
  durationMs: number,
): AnimationSpec | undefined {
  if (windows.length === 0) {
    return undefined;
  }
  // Windows that touch have to become one. A picker hands the keyboard
  // straight to the answer being typed, so its release keyframe lands after
  // the next window has already hidden the placeholder — and being later, it
  // wins. The placeholder then prints under the sentence being keyed.
  const ordered = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged: TimeWindow[] = [];
  for (const window of ordered) {
    const previous = merged.at(-1);
    if (previous !== undefined && window.startMs - 24 <= previous.sendMs + 190) {
      merged[merged.length - 1] = {
        startMs: previous.startMs,
        endMs: Math.max(previous.endMs, window.endMs),
        sendMs: Math.max(previous.sendMs, window.sendMs),
      };
      continue;
    }
    merged.push(window);
  }
  const track = keyframeTrack({
    durationMs,
    first: { opacity: (merged[0]?.startMs ?? 0) <= 40 ? 0 : 1 },
  });
  for (const window of merged) {
    track.push(window.startMs - 24, { opacity: 1 });
    track.push(window.startMs, { opacity: 0 });
    track.push(window.sendMs + 150, { opacity: 0 });
    track.push(window.sendMs + 190, { opacity: 1 });
  }
  return { keyframes: track.close({ opacity: 1 }), durationMs, easing: "linear", fill: "both" };
}

/**
 * The composer draft: types in during the window, then leaves on Enter.
 * `settleMs` is the surface's own settle — an app lifts the draft off over a
 * beat, a terminal clears it in the repaint that takes the box back down.
 * The panel, the rows and this text read one number so the send is a single
 * state change rather than three that overlap.
 */
export function composerDraftAnimation(
  timing: MessageTiming,
  durationMs: number,
  settleMs: number,
): AnimationSpec {
  const { startMs } = timing;
  // The finished draft sits through the pre-send beat, then leaves.
  const sendMs = sendMomentMs(timing);
  const track = keyframeTrack({ durationMs, first: { opacity: 0, transform: { translateY: 0 } } });
  track.push(startMs - 8, { opacity: 0, transform: { translateY: 0 } });
  track.push(startMs, { opacity: 1, transform: { translateY: 0 } });
  if (settleMs > 0) {
    track.push(sendMs, { opacity: 1, transform: { translateY: 0 } });
    track.push(sendMs + settleMs, { opacity: 0, transform: { translateY: -12 } });
  } else {
    track.push(sendMs - 1, { opacity: 1, transform: { translateY: 0 } });
    track.push(sendMs, { opacity: 0, transform: { translateY: 0 } });
  }
  return {
    keyframes: track.close({ opacity: 0, transform: { translateY: settleMs > 0 ? -12 : 0 } }),
    durationMs,
    easing: settleMs > 0 ? "ease-in" : "step-end",
    fill: "both",
  };
}

/**
 * Send control feedback matching real chat UIs: dimmed while the composer
 * is empty, lit while a draft is being typed, and a press-pulse when the
 * send fires after the pre-send beat.
 */
export function sendButtonAnimation(
  windows: TimeWindow[],
  durationMs: number,
): AnimationSpec | undefined {
  if (windows.length === 0) {
    return undefined;
  }
  const IDLE_OPACITY = 0.55;
  const frame = (opacity: number, scale: number) => ({
    opacity,
    transform: { scaleX: scale, scaleY: scale },
  });
  const track = keyframeTrack({
    durationMs,
    first: frame((windows[0]?.startMs ?? 0) <= 40 ? 1 : IDLE_OPACITY, 1),
  });
  for (const window of windows) {
    track.push(window.startMs - 1, frame(IDLE_OPACITY, 1));
    track.push(window.startMs + 130, frame(1, 1));
    track.push(window.sendMs - 10, frame(1, 1));
    track.push(window.sendMs + 90, frame(1, 1.18));
    track.push(window.sendMs + 250, frame(1, 1));
    track.push(window.sendMs + 430, frame(IDLE_OPACITY, 1));
  }
  return {
    keyframes: track.close(frame(IDLE_OPACITY, 1)),
    durationMs,
    easing: "ease-out",
    fill: "both",
  };
}

export function composerDraftLine(content: string): string {
  return analyzeDraftTyping(content).finalText.replace(/\n+/gu, " ").trim();
}

/** How far either composer grows for multi-line drafts, in extra lines. */
export const COMPOSER_MAX_EXTRA_LINES = 3;
export const COMPOSER_LINE_RISE_MS = 140;
/** App folds a grown composer over a beat; TUI repaints it immediately. */
export const COMPOSER_PANEL_SHRINK_MS = 150;

/**
 * One complete multi-line composer surface. Stages switch on the newline
 * rather than cross-fading: translucent surfaces must never overlap, or the
 * previous rounded rectangle shows through the new one.
 *
 * `settleMs` is how long this surface takes to leave. A chat app folds its
 * composer away over a beat; a terminal repaints, so 0 swaps it out in the
 * same frame the one-line surface comes back. The transcript's stand-off
 * reads the same number — see `planComposerShove` — because a box that has
 * already gone while the rows are still standing off is two states of one
 * thing.
 */
export function composerPanelAnimation(options: {
  showMs: number;
  hideMs: number;
  settleMs: number;
  durationMs: number;
}): AnimationSpec {
  const { showMs, hideMs, settleMs, durationMs } = options;
  const lift = (opacity: number, translateY: number) => ({ opacity, transform: { translateY } });
  const track = keyframeTrack({ durationMs, first: lift(0, 8) });
  track.push(showMs - 1, lift(0, 0));
  track.push(showMs, lift(1, 0));
  if (settleMs > 0) {
    track.push(hideMs, lift(1, 0));
    track.push(hideMs + settleMs, lift(0, 14));
  } else {
    track.push(hideMs - 1, lift(1, 0));
    track.push(hideMs, lift(0, 0));
  }
  return {
    keyframes: track.close(lift(0, settleMs > 0 ? 14 : 0)),
    durationMs,
    easing: settleMs > 0 ? "linear" : "step-end",
    fill: "both",
  };
}

/**
 * The normal one-line surface disappears while a complete expanded surface
 * is active. This keeps the authored panel alpha without compositing one
 * rounded rectangle through another.
 */
export function composerBasePanelAnimation(
  /**
   * `crossFadeMs` is how long whatever takes the panel's place needs to
   * arrive. A surface that steps in wants 0 — the swap is one frame and
   * nothing is ever missing. One that fades in wants its own fade: leaving on
   * a step while the replacement eases in opens a hole at the handover with
   * neither on screen, and a still taken on that instant is an empty window.
   */
  windows: Array<{ startMs: number; endMs: number; crossFadeMs?: number }>,
  durationMs: number,
): AnimationSpec | undefined {
  if (windows.length === 0) {
    return undefined;
  }
  const track = keyframeTrack({ durationMs, first: { opacity: 1 } });
  let crossing = false;
  for (const window of windows) {
    const fadeMs = window.crossFadeMs ?? 0;
    crossing ||= fadeMs > 0;
    track.push(window.startMs - 1, { opacity: 1 });
    if (fadeMs > 0) {
      track.push(window.startMs, { opacity: 1 });
    }
    track.push(window.startMs + fadeMs, { opacity: 0 });
    track.push(window.endMs - 1, { opacity: 0 });
    track.push(window.endMs, { opacity: 1 });
  }
  return {
    keyframes: track.close({ opacity: 1 }),
    durationMs,
    // A track that carries any cross-fade has to interpolate; one that is all
    // instants keeps the step so a grown draft swaps without a dissolve.
    easing: crossing ? "linear" : "step-end",
    fill: "both",
  };
}

/**
 * How far the transcript stands off while the composer is grown.
 *
 * A chat list is not covered by its own input: the input claims the rows and
 * the conversation moves off them, then settles back when the draft is sent.
 * The composer is chrome, so its growth is outside the transcript's height
 * budget — without this the last messages simply disappear under the panel.
 *
 * The stage times are the panel's own, so the two can never drift apart, and
 * each stage carries the distance that stage actually covers: a conversation
 * whose last line sits well above the prompt is not moved at all.
 */
export function planComposerShove(options: {
  drafts: Array<{
    stages: Array<{ atMs: number; shovePx: number }>;
    releaseMs: number;
    /** Overrides the surface default when this draft has its own handoff. */
    settleMs?: number;
  }>;
  durationMs: number;
  /**
   * How long the rows take to come back, matching the surface's own
   * `composerPanelAnimation` settle. 0 returns them in the repaint that
   * removes the grown box.
   */
  settleMs: number;
}): AnimationSpec | null {
  const { drafts, durationMs, settleMs } = options;
  const moving = drafts.filter((draft) => draft.stages.some((stage) => stage.shovePx > 0.5));
  if (moving.length === 0) {
    return null;
  }
  const instantRepaint = moving.every((draft) => (draft.settleMs ?? settleMs) === 0);
  const up = (px: number) => ({ transform: { translateY: px === 0 ? 0 : -px } });
  const track = keyframeTrack({ durationMs, first: up(0) });
  for (const draft of moving) {
    const draftSettleMs = draft.settleMs ?? settleMs;
    let held = 0;
    for (const stage of draft.stages) {
      // The panel switches stages on the newline rather than easing into
      // them, so the transcript steps with it instead of sliding.
      track.push(stage.atMs - 1, up(held));
      track.push(stage.atMs, up(stage.shovePx));
      held = stage.shovePx;
    }
    if (draftSettleMs > 0) {
      track.push(draft.releaseMs, up(held));
      track.push(draft.releaseMs + draftSettleMs, up(0));
    } else if (instantRepaint) {
      track.push(draft.releaseMs - 1, up(held));
      track.push(draft.releaseMs, up(0));
    } else {
      // This track is linear because App picker stand-offs settle smoothly.
      // Put the unavoidable 1ms interpolation *after* an instant-repaint
      // surface has disappeared; putting it before `releaseMs` lets visible
      // chrome cover the rows while they are already returning.
      track.push(draft.releaseMs, up(held));
      track.push(draft.releaseMs + 1, up(0));
    }
  }
  return {
    keyframes: track.close(up(0)),
    durationMs,
    easing: instantRepaint ? "step-end" : "linear",
    fill: "both",
  };
}

/** One frame slot of a text-cell spinner: visible 1/n of every cycle. */
