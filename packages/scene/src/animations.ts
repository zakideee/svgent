import {
  type AnimationEasing,
  type AnimationSpec,
  type AnyVNode,
  Box,
  Flex,
  Text,
  type TextUnitAnimation,
} from "@boundsvg/core";
import { MONO_FALLBACK, MONO_FONT, type SceneEnv, sizeLeft } from "./env.js";
import type { MarkdownRenderContext } from "./markdown-render.js";

const APP_ENTRANCE_EASE: AnimationEasing = [0.16, 1, 0.3, 1];
export const APP_SCROLL_EASE: AnimationEasing = [0.4, 0, 0.2, 1];

/** One revolution of the app spinner ring. */
const APP_SPINNER_CYCLE_MS = 900;

export const TUI_SPINNER_FRAMES = ["|", "/", "-", "\\"];
export const TUI_PULSE_FRAMES = ["◌", "○", "●", "○"];

// ————————————————————————————————————————————————————————————————————————————
// Motion primitives. App motion is smooth and physical; TUI motion is a
// repaint — values snap, nothing glides.
// ————————————————————————————————————————————————————————————————————————————

/** Last offset a cue may take, leaving room for the resting frame at 1. */
const KEYFRAME_CEILING = 0.999;

/**
 * Hand-built keyframe timeline. Cues retain their scene time until
 * `close`, which sorts them and lets the last state at a coincident instant
 * win. Normalizing during `push` used to move a cue by 48ms on a 120s scene
 * merely because another caller inserted an equal or later cue first.
 *
 * A cue with no room left is dropped rather than stacked on the ceiling.
 * The terminal frame at 1 owns the final resting value; piling late cues on
 * that same offset produces equal `at` values and an invalid animation.
 */
export function keyframeTrack<Payload>(options: { durationMs: number; first: Payload }): {
  push: (atMs: number, payload: Payload) => void;
  close: (payload: Payload) => Array<{ at: number } & Payload>;
} {
  const { durationMs, first } = options;
  const cues: Array<{ atMs: number; payload: Payload; order: number }> = [];
  let order = 0;
  return {
    push: (atMs, payload) => {
      cues.push({ atMs, payload, order });
      order += 1;
    },
    close: (payload) => {
      const frames: Array<{ at: number } & Payload> = [{ at: 0, ...first }];
      const ordered = [...cues].sort(
        (left, right) => left.atMs - right.atMs || left.order - right.order,
      );
      for (const cue of ordered) {
        if (cue.atMs <= 0) {
          frames[0] = { at: 0, ...cue.payload };
          continue;
        }
        const at = cue.atMs / durationMs;
        if (at > KEYFRAME_CEILING) {
          continue;
        }
        const previous = frames.at(-1);
        if (previous?.at === at) {
          frames[frames.length - 1] = { at, ...cue.payload };
        } else {
          frames.push({ at, ...cue.payload });
        }
      }
      frames.push({ at: 1, ...payload });
      return frames;
    },
  };
}

export function appEntrance(startMs: number): AnimationSpec {
  return {
    keyframes: [
      { at: 0, opacity: 0, transform: { translateY: 14 } },
      { at: 1, opacity: 1, transform: { translateY: 0 } },
    ],
    durationMs: 380,
    delayMs: startMs,
    easing: APP_ENTRANCE_EASE,
    fill: "both",
  };
}

export function appBubbleFade(startMs: number): AnimationSpec {
  return {
    keyframes: [
      { at: 0, opacity: 0 },
      { at: 1, opacity: 1 },
    ],
    durationMs: 220,
    delayMs: startMs,
    easing: "ease-out",
    fill: "both",
  };
}

/**
 * The landing used to ride a spring easing (stiffness 300, damping 22), but a
 * spring has no closed cubic form, so the animated SVG's document timeline —
 * the mode that lets the file loop — cannot compile it. These keyframes are
 * that spring's own solved trajectory sampled at its turning points: fall from
 * 26px, cross about 1.6px past rest near a third of the way in, and settle.
 * Ease-out between them keeps each leg decelerating the way the curve does.
 */
export function appBubbleSpring(startMs: number): AnimationSpec {
  return {
    keyframes: [
      { at: 0, transform: { translateY: 26, scaleX: 0.96, scaleY: 0.96 } },
      { at: 0.32, transform: { translateY: -1.6, scaleX: 1, scaleY: 1 } },
      { at: 0.65, transform: { translateY: 0, scaleX: 1, scaleY: 1 } },
      { at: 1, transform: { translateY: 0, scaleX: 1, scaleY: 1 } },
    ],
    durationMs: 620,
    delayMs: startMs,
    easing: "ease-out",
    fill: "both",
  };
}

export function tuiPop(startMs: number): AnimationSpec {
  return {
    keyframes: [
      { at: 0, opacity: 0 },
      { at: 1, opacity: 1 },
    ],
    durationMs: 32,
    delayMs: startMs,
    easing: "step-start",
    fill: "both",
  };
}

/**
 * Visibility gate for pending/settled layers. `fadeMs` ~16 reads as a
 * terminal repaint; ~160-200 reads as an app cross-fade.
 */
export function visibilityWindow(
  startMs: number,
  endMs: number | null,
  fadeMs: number,
): AnimationSpec {
  if (endMs === null) {
    return {
      keyframes: [
        { at: 0, opacity: 0 },
        { at: 1, opacity: 1 },
      ],
      durationMs: Math.max(fadeMs, 1),
      delayMs: startMs,
      easing: fadeMs <= 32 ? "step-start" : "ease-out",
      fill: "both",
    };
  }
  const total = Math.max(endMs - startMs + fadeMs, fadeMs * 2 + 1);
  const inAt = Math.min(0.45, fadeMs / total);
  const outAt = Math.min(0.99, Math.max(inAt + 0.01, (endMs - startMs) / total));
  return {
    keyframes: [
      { at: 0, opacity: 0 },
      { at: inAt, opacity: 1 },
      { at: outAt, opacity: 1 },
      { at: 1, opacity: 0 },
    ],
    durationMs: total,
    delayMs: startMs,
    easing: "linear",
    fill: "both",
  };
}

/** Mutually exclusive layer window: state changes on one exact scene millisecond. */
export function stepVisibilityWindow(
  startMs: number,
  endMs: number | null,
  durationMs: number,
): AnimationSpec {
  const track = keyframeTrack({ durationMs, first: { opacity: startMs <= 0 ? 1 : 0 } });
  if (startMs > 0) {
    track.push(startMs - 1, { opacity: 0 });
    track.push(startMs, { opacity: 1 });
  }
  if (endMs !== null) {
    track.push(endMs - 1, { opacity: 1 });
    track.push(endMs, { opacity: 0 });
  }
  return {
    keyframes: track.close({ opacity: endMs === null ? 1 : 0 }),
    durationMs,
    easing: "step-end",
    fill: "both",
  };
}

/**
 * How long the last revealed cluster keeps animating after its turn comes
 * up. The timeline adds it to a text message's duration so the next step
 * cannot start while the final characters are still fading in.
 */
export const CLUSTER_REVEAL_MS = 180;

/** App token stream: clusters fade in with a soft rise, like SSE chunks. */
export function streamedUnits(
  startMs: number,
  charsPerSecond: number,
  offsetCharacters: number,
): TextUnitAnimation {
  return {
    by: "cluster",
    animation: {
      keyframes: [
        { at: 0, opacity: 0, transform: { translateY: 3 } },
        { at: 1, opacity: 1, transform: { translateY: 0 } },
      ],
      durationMs: CLUSTER_REVEAL_MS,
      delayMs: startMs + (offsetCharacters / charsPerSecond) * 1_000,
      easing: "ease-out",
      fill: "both",
    },
    delayStepMs: 1_000 / charsPerSecond,
    order: "logical",
  };
}

/** TUI output: cells snap on with zero fade, like a terminal repaint. */
export function typedUnits(
  startMs: number,
  charsPerSecond: number,
  offsetCharacters: number,
): TextUnitAnimation {
  return {
    by: "cluster",
    animation: {
      keyframes: [
        { at: 0, opacity: 0 },
        { at: 1, opacity: 1 },
      ],
      durationMs: 24,
      delayMs: startMs + (offsetCharacters / charsPerSecond) * 1_000,
      easing: "step-start",
      fill: "both",
    },
    delayStepMs: 1_000 / charsPerSecond,
    order: "logical",
  };
}

export function revealUnitsFor(
  context: MarkdownRenderContext,
  offsetCharacters: number,
): TextUnitAnimation | undefined {
  if (context.reveal === "instant") {
    return undefined;
  }
  const { messageTiming, surface } = context;
  const { timing } = context.env.project;
  const charsPerSecond =
    messageTiming.message.role === "user" ? timing.userTypingCps : timing.agentTypingCps;
  return surface === "tui"
    ? typedUnits(messageTiming.startMs, charsPerSecond, offsetCharacters)
    : streamedUnits(messageTiming.startMs, charsPerSecond, offsetCharacters);
}

/**
 * Reveal a Markdown decoration when the stream reaches the text it belongs
 * to. Structural glyphs live in separate SVG nodes, so text-unit animation
 * cannot hide them by itself.
 */
export function structureRevealAnimation(
  context: MarkdownRenderContext,
  offsetCharacters: number,
): AnimationSpec | undefined {
  if (context.reveal === "instant") {
    return undefined;
  }
  const { messageTiming, surface } = context;
  const { timing } = context.env.project;
  const charsPerSecond =
    messageTiming.message.role === "user" ? timing.userTypingCps : timing.agentTypingCps;
  const revealMs = messageTiming.startMs + (offsetCharacters / charsPerSecond) * 1_000;
  return visibilityWindow(revealMs, null, surface === "tui" ? 24 : CLUSTER_REVEAL_MS);
}

/**
 * Entrance for an inline-code chip's decoration, timed to the reveal of its
 * first character so the background box never appears ahead of the text it
 * wraps. Mirrors the cluster motion: soft rise on app, hard snap on TUI.
 */
export function chipRevealAnimation(
  context: MarkdownRenderContext,
  chipOffsetCharacters: number,
): AnimationSpec | undefined {
  const reveal = structureRevealAnimation(context, chipOffsetCharacters);
  if (reveal === undefined || context.surface === "tui") {
    return reveal;
  }
  return {
    ...reveal,
    keyframes: [
      { at: 0, opacity: 0, transform: { translateY: 3 } },
      { at: 1, opacity: 1, transform: { translateY: 0 } },
    ],
  };
}

/**
 * Message and composer surfaces follow "Panel opacity" but keep more body
 * than the window itself, so text stays readable over busy backdrops while
 * still letting them shine through.
 */

export function blink(style: "hard" | "soft"): AnimationSpec {
  return style === "hard"
    ? {
        keyframes: [
          { at: 0, opacity: 1 },
          { at: 0.5, opacity: 0 },
          { at: 1, opacity: 1 },
        ],
        durationMs: 1_000,
        iterations: "infinite",
        easing: "step-end",
        fill: "both",
      }
    : {
        keyframes: [
          { at: 0, opacity: 1 },
          { at: 0.5, opacity: 0.1 },
          { at: 1, opacity: 1 },
        ],
        durationMs: 1_150,
        iterations: "infinite",
        easing: "ease-in-out",
        fill: "both",
      };
}

function frameLoop(index: number, count: number, cycleMs: number): AnimationSpec {
  const from = index / count;
  const to = (index + 1) / count;
  const keyframes: AnimationSpec["keyframes"] =
    index === 0
      ? [
          { at: 0, opacity: 1 },
          { at: to, opacity: 0 },
          { at: 1, opacity: 0 },
        ]
      : to >= 1
        ? [
            { at: 0, opacity: 0 },
            { at: from, opacity: 1 },
            { at: 1, opacity: 0 },
          ]
        : [
            { at: 0, opacity: 0 },
            { at: from, opacity: 1 },
            { at: to, opacity: 0 },
            { at: 1, opacity: 0 },
          ];
  return {
    keyframes,
    durationMs: cycleMs,
    iterations: "infinite",
    easing: "step-end",
    fill: "both",
  };
}

/** Terminal spinner: one character cell cycling through frames, no easing. */
export function tuiSpinner(
  env: SceneEnv,
  { frames, color, cycleMs }: { frames: string[]; color: string; cycleMs: number },
): AnyVNode {
  const { tuiFontPx, tuiLinePx, tuiCharPx } = env.metrics;
  return Box(
    { position: "relative", width: Math.ceil(tuiCharPx) + 2, height: tuiLinePx },
    ...frames.map((frame, index) =>
      Text(
        {
          position: "absolute",
          left: 0,
          top: 0,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: tuiFontPx,
          lineHeightPx: tuiLinePx,
          color,
          wrap: "none",
          animate: frameLoop(index, frames.length, cycleMs),
        },
        frame,
      ),
    ),
  );
}

/**
 * App spinner: a smoothly rotating dashed ring. Sized by the caller so it
 * tracks the text beside it — a fixed ring shrinks to a speck once the
 * transcript is scaled up for a header image. `spinUntilMs` is when the
 * caller stops showing it: the spin is one track that runs from the scene's
 * start to that moment and no further.
 */
export function appSpinnerRing(accent: string, sizePx: number, spinUntilMs: number): AnyVNode {
  const inset = Math.max(1, Math.round(sizePx / 16));
  const strokePx = Math.max(2, Math.round(sizePx / 8));
  const durationMs = Math.max(1, spinUntilMs);
  return Box(
    { position: "relative", width: sizePx, height: sizePx },
    Box({
      position: "absolute",
      left: inset,
      top: inset,
      width: sizeLeft(sizePx, inset * 2),
      height: sizeLeft(sizePx, inset * 2),
      borderRadius: 999,
      borderWidth: strokePx,
      borderColor: accent,
      // The gap-to-dash proportion is what reads as a spinner, so the
      // pattern scales with the ring instead of repeating more often on a
      // larger circumference.
      strokeDasharray: `${((sizePx - inset * 2) / 14) * 30} ${((sizePx - inset * 2) / 14) * 14}`,
      strokeLinecap: "round",
      // One even spin over the whole window, instead of an infinite 900ms
      // cycle. Every other repeating track here returns to its starting
      // value, but a rotation ends 360 away from where it began — identical
      // to the eye, a jump to the compiler — and the animated SVG's document
      // timeline refuses that jump at each cycle boundary. A single track at
      // the same angular speed has no boundary to jump at, and ending it
      // where the spinner is hidden keeps it inside the scene it plays in.
      animate: {
        keyframes: [
          { at: 0, transform: { rotateDeg: 0 } },
          { at: 1, transform: { rotateDeg: (360 * durationMs) / APP_SPINNER_CYCLE_MS } },
        ],
        durationMs,
        easing: "linear",
        fill: "both",
      },
    }),
  );
}

/**
 * Per-bar peak heights for the voice level meter, as fractions of the row
 * height. A fixed pattern instead of randomness keeps renders reproducible.
 */
const VOICE_BAR_PEAKS = [
  0.42, 0.85, 0.6, 1, 0.5, 0.9, 0.38, 0.72, 0.95, 0.55, 0.8, 0.45, 0.68, 1, 0.58, 0.88,
];

/**
 * Voice-input level bars: speech reads as phase-shifted undulation, and
 * before each bar's cycle begins it rests at the uniform silence height —
 * the capture visibly starts from quiet.
 */
export function voiceWaveformBars(options: {
  color: string;
  heightPx: number;
  barWidthPx: number;
  gapPx: number;
  barCount: number;
}): AnyVNode {
  const { color, heightPx, barWidthPx, gapPx, barCount } = options;
  const restPx = Math.max(3, heightPx * 0.18);
  return Flex(
    { direction: "row", gap: gapPx, alignItems: "center", height: heightPx },
    ...Array.from({ length: barCount }, (_unused, index) => {
      const peakPx = Math.max(
        restPx,
        (VOICE_BAR_PEAKS[index % VOICE_BAR_PEAKS.length] ?? 0.6) * heightPx,
      );
      const restScale = restPx / peakPx;
      return Box({
        width: barWidthPx,
        height: peakPx,
        borderRadius: barWidthPx / 2,
        background: color,
        animate: {
          keyframes: [
            { at: 0, transform: { scaleY: restScale } },
            { at: 0.5, transform: { scaleY: 1 } },
            { at: 1, transform: { scaleY: restScale } },
          ],
          durationMs: 620 + (index % 5) * 110,
          delayMs: 180 + (index % 7) * 90,
          iterations: "infinite",
          easing: "ease-in-out",
          fill: "both",
        },
      });
    }),
  );
}

/**
 * App thinking indicator: three dots pulsing in phase offsets. `sizePx` is
 * the row height the dots sit in, matched to the text beside them.
 */
export function appThinkingDots(color: string, sizePx = 16): AnyVNode {
  const dotPx = Math.max(4, Math.round(sizePx * 0.31));
  const gapPx = Math.max(3, Math.round(sizePx * 0.25));
  return Flex(
    { direction: "row", gap: gapPx, alignItems: "center", height: sizePx },
    ...[0, 1, 2].map((index) =>
      Box({
        width: dotPx,
        height: dotPx,
        borderRadius: 999,
        background: color,
        animate: {
          keyframes: [
            { at: 0, opacity: 0.25 },
            { at: 0.35, opacity: 1 },
            { at: 0.7, opacity: 0.25 },
            { at: 1, opacity: 0.25 },
          ],
          durationMs: 1_050,
          delayMs: index * 170,
          iterations: "infinite",
          easing: "ease-in-out",
          fill: "both",
        },
      }),
    ),
  );
}

/**
 * Blur-free drop shadow for the floating window: a few stacked translucent
 * rounded layers. Real gaussian box-shadows cost ~13s per rasterized frame,
 * which is what made video export crawl.
 */
/** Approximate luminance of what sits behind the window. */
