import { type AnimationSpec, type AnyVNode, Box, Path, Text } from "@boundsvg/core";
import { blink, stepVisibilityWindow, typedUnits } from "./animations.js";
import {
  COMPOSER_MAX_EXTRA_LINES,
  composerBasePanelAnimation,
  composerDraftAnimation,
  composerPanelAnimation,
  sendMomentMs,
} from "./composer.js";
import {
  DRAFT_FONT_FEATURES,
  type DraftLayoutSnapshot,
  type DraftWrapOptions,
  draftClusterVisibleMs,
  planDraftLayoutSequence,
} from "./draft-layout.js";
import type { DraftPhase } from "./draft-typing.js";
import {
  hexToRgba,
  MONO_FALLBACK,
  MONO_FONT,
  messageSurfaceAlpha,
  type SceneEnv,
  type ScenePalette,
  sizeLeft,
  spacePx,
  TUI_CHAR_RATIO,
  TUI_FRAME_STROKE_PX,
} from "./env.js";
import { draftGraphemes } from "./graphemes.js";
import { sceneActionMeta } from "./interaction.js";
import { measureLineWidthPx } from "./measure.js";
import type { MessageTiming, SessionTimeline } from "./timeline.js";

/**
 * Where a draft grows the prompt box, measured on what is on screen at that
 * moment: a reading still being converted is shorter than the kanji it becomes,
 * so the settled line plan would grow the box a beat early.
 */
type TuiDraftGrowthStep = { atMs: number; extraLines: number };
type TuiDraftLine = {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  sourceLine: number;
  slot: number;
};
type TuiImeUnderline = {
  cluster: number;
  slot: number;
  leftPx: number;
  widthPx: number;
  showMs: number;
  settled: boolean;
};
type TuiDraftSnapshot = {
  showMs: number;
  hideMs: number | null;
  phase: DraftPhase;
  lines: TuiDraftLine[];
  underlines: TuiImeUnderline[];
};
type TuiDraftPlan = {
  steps: TuiDraftGrowthStep[];
  maxExtraLines: number;
  snapshots: TuiDraftSnapshot[];
};
export type TuiDraftGrowth = Map<string, TuiDraftPlan>;

function sourceLineFor(plan: DraftLayoutSnapshot["plan"], cluster: number): number {
  let sourceLine = 0;
  for (let candidate = 0; candidate < plan.lineStartOffsets.length; candidate += 1) {
    if (cluster >= (plan.lineStartOffsets[candidate] ?? 0)) {
      sourceLine = candidate;
    }
  }
  return sourceLine;
}

function placeTuiSnapshot(options: {
  snapshot: DraftLayoutSnapshot;
  maxExtraLines: number;
  charsPerSecond: number;
  lineWidth: (text: string) => number;
}): TuiDraftSnapshot {
  const { snapshot, maxExtraLines, charsPerSecond, lineWidth } = options;
  const capacity = maxExtraLines + 1;
  const firstVisibleLine = Math.max(0, snapshot.plan.lines.length - capacity);
  const visibleCount = snapshot.plan.lines.length - firstVisibleLine;
  const firstSlot = maxExtraLines - (visibleCount - 1);
  const lines = snapshot.plan.lines.slice(firstVisibleLine).map((text, visibleIndex) => {
    const sourceLine = firstVisibleLine + visibleIndex;
    return {
      text,
      sourceStart: snapshot.plan.lineStartOffsets[sourceLine] ?? 0,
      sourceEnd: snapshot.plan.lineEndOffsets[sourceLine] ?? 0,
      sourceLine,
      slot: firstSlot + visibleIndex,
    };
  });
  const underlines: TuiImeUnderline[] = [];
  if (snapshot.phase.composing !== undefined) {
    const clusters = draftGraphemes(snapshot.text);
    for (
      let cluster = snapshot.phase.composing.from;
      cluster < Math.min(snapshot.phase.composing.to, clusters.length);
      cluster += 1
    ) {
      const sourceLine = sourceLineFor(snapshot.plan, cluster);
      const line = lines.find((candidate) => candidate.sourceLine === sourceLine);
      if (line === undefined) {
        continue;
      }
      const before = clusters.slice(line.sourceStart, cluster).join("");
      const through = clusters.slice(line.sourceStart, cluster + 1).join("");
      const leftPx = lineWidth(before);
      underlines.push({
        cluster,
        slot: line.slot,
        leftPx,
        widthPx: Math.max(2, lineWidth(through) - leftPx),
        showMs: snapshot.phase.composing.settled
          ? snapshot.showMs
          : draftClusterVisibleMs(snapshot.phase, cluster, charsPerSecond),
        settled: snapshot.phase.composing.settled,
      });
    }
  }
  return {
    showMs: snapshot.showMs,
    hideMs: snapshot.hideMs,
    phase: snapshot.phase,
    lines,
    underlines,
  };
}

export function planTuiDraftGrowth(options: {
  env: SceneEnv;
  userTimings: SessionTimeline["messages"];
  draftWidth: number;
  promptFontPx: number;
  promptLinePx: number;
}): TuiDraftGrowth {
  const { env, userTimings, draftWidth, promptFontPx, promptLinePx } = options;
  const { engine } = env;
  const wrap: DraftWrapOptions = {
    widthPx: draftWidth,
    fontPx: promptFontPx,
    lineHeightPx: promptLinePx,
    font: MONO_FONT,
    fallback: MONO_FALLBACK,
    fallbackRatio: TUI_CHAR_RATIO,
    engine,
  };
  const growth: TuiDraftGrowth = new Map();
  for (const timing of userTimings) {
    const draft = timing.draft;
    if (draft === undefined) {
      continue;
    }
    const sequence = planDraftLayoutSequence({ draft, wrap });
    const steps: TuiDraftGrowthStep[] = [];
    let currentExtraLines = 0;
    const push = (atMs: number, extraLines: number): void => {
      if (extraLines === currentExtraLines) {
        return;
      }
      const last = steps.at(-1);
      if (last?.atMs === atMs) {
        last.extraLines = extraLines;
      } else {
        steps.push({ atMs, extraLines });
      }
      currentExtraLines = extraLines;
    };
    for (const state of sequence.lineStates) {
      push(state.atMs, Math.min(Math.max(0, state.lineCount - 1), COMPOSER_MAX_EXTRA_LINES));
    }
    const maxExtraLines = sequence.lineStates.reduce(
      (maximum, state) =>
        Math.max(maximum, Math.min(state.lineCount - 1, COMPOSER_MAX_EXTRA_LINES)),
      0,
    );
    const lineWidth = (text: string): number =>
      measureLineWidthPx(engine, {
        text,
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: promptFontPx,
        fontFeatureSettings: DRAFT_FONT_FEATURES,
        fallbackRatio: TUI_CHAR_RATIO,
      });
    growth.set(timing.message.id, {
      steps,
      maxExtraLines,
      snapshots: sequence.snapshots.map((snapshot) =>
        placeTuiSnapshot({
          snapshot,
          maxExtraLines,
          charsPerSecond: draft.charsPerSecond,
          lineWidth,
        }),
      ),
    });
  }
  return growth;
}

/**
 * The one-line surface hides for two reasons — a picker printing in its place
 * and a grown draft replacing it — and an element carries one animation, so
 * the two opacity tracks are multiplied into one.
 */
function mergeHolds(
  picker: AnimationSpec | undefined,
  grown: AnimationSpec | undefined,
  durationMs: number,
): AnimationSpec | undefined {
  if (picker === undefined) {
    return grown;
  }
  if (grown === undefined) {
    return picker;
  }
  const valueAt = (spec: AnimationSpec, offsetMs: number): number => {
    let value = 1;
    for (const frame of spec.keyframes) {
      if (frame.at * durationMs <= offsetMs) {
        value = typeof frame.opacity === "number" ? frame.opacity : value;
      }
    }
    return value;
  };
  const offsets = new Set<number>();
  for (const spec of [picker, grown]) {
    for (const frame of spec.keyframes) {
      offsets.add(frame.at);
    }
  }
  return {
    keyframes: [...offsets]
      .sort((a, b) => a - b)
      .map((offset) => ({
        at: offset,
        opacity: Math.min(
          valueAt(picker, offset * durationMs),
          valueAt(grown, offset * durationMs),
        ),
      })),
    durationMs,
    easing: "step-end",
    fill: "both",
  };
}

/** A terminal has no size transition: chrome and rows repaint together. */
export const TUI_CHROME_SETTLE_MS = 0;

const TUI_COMPOSITION_WAVE_CREST_PX = 1.25;
const TUI_COMPOSITION_WAVE_STROKE_PX = 1.2;

function pathCoordinate(value: number): string {
  return String(Math.round(value * 1_000) / 1_000);
}

/** One wave per terminal cell; a full-width grapheme therefore gets two. */
function tuiCompositionWave(
  widthPx: number,
  cellWidthPx: number,
): {
  d: string;
  height: number;
} {
  const height = TUI_COMPOSITION_WAVE_CREST_PX * 2 + TUI_COMPOSITION_WAVE_STROKE_PX;
  const mid = height / 2;
  const cycleCount = Math.max(1, Math.round(widthPx / Math.max(1, cellWidthPx)));
  const cycleWidth = widthPx / cycleCount;
  const controlOffset = TUI_COMPOSITION_WAVE_CREST_PX * 2;
  const commands = [`M0 ${pathCoordinate(mid)}`];
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    const start = cycle * cycleWidth;
    commands.push(
      `Q${pathCoordinate(start + cycleWidth / 4)} ${pathCoordinate(mid - controlOffset)} ${pathCoordinate(start + cycleWidth / 2)} ${pathCoordinate(mid)}`,
      `T${pathCoordinate(start + cycleWidth)} ${pathCoordinate(mid)}`,
    );
  }
  return { d: commands.join(" "), height };
}

export function tuiComposerNodes(layout: {
  env: SceneEnv;
  timeline: SessionTimeline;
  userTimings: SessionTimeline["messages"];
  composerIdle: AnimationSpec | undefined;
  /** Hides the prompt box while a picker prints in its place. */
  pickerHold: AnimationSpec | undefined;
  /** Transient selectors that replace the prompt and grow from its bottom edge. */
  choicePanels: Array<{
    node: AnyVNode;
    height: number;
    contentHeight: number;
    cutTop: number;
    clipped: boolean;
  }>;
  composerGrowth: TuiDraftGrowth;
  readablePalette: ScenePalette;
  chromeMuted: string;
  chromePx: (px: number) => number;
  width: number;
  height: number;
  inset: number;
  composerHeight: number;
  footerHeight: number;
  promptFontPx: number;
  promptLinePx: number;
  promptCharPx: number;
  promptLeft: number;
  draftWidth: number;
  hintFontPx: number;
  modeHint: string;
  modeHintWidth: number;
  statusHint: string;
}): AnyVNode[] {
  const {
    env,
    timeline,
    userTimings,
    composerIdle,
    pickerHold,
    choicePanels,
    composerGrowth,
    readablePalette,
    chromeMuted,
    chromePx,
    width,
    inset,
    composerHeight,
    footerHeight,
    promptFontPx,
    promptLinePx,
    promptCharPx,
    promptLeft,
    draftWidth,
    hintFontPx,
    modeHint,
    modeHintWidth,
    statusHint,
  } = layout;
  const { project, palette, engine } = env;
  // The prompt box shares the grid's own inset, so it lines up with the text
  // above it rather than sitting on a chrome constant of its own.
  const promptPadX = spacePx(env.metrics, project.appearance.windowPaddingX);
  /** Where every composer surface sits its bottom edge. */
  const promptBottomInset = inset + footerHeight + chromePx(10);
  const display = project.display;
  if (!display.composer) {
    return [];
  }
  const draftStages = (timing: MessageTiming): number =>
    composerGrowth.get(timing.message.id)?.maxExtraLines ?? 0;
  const panelFrame = {
    position: "absolute" as const,
    left: inset + promptPadX,
    bottom: promptBottomInset,
    width: sizeLeft(width, inset * 2, promptPadX * 2),
    padding: [chromePx(13), chromePx(14), chromePx(13), chromePx(14)] as [
      number,
      number,
      number,
      number,
    ],
    borderRadius: chromePx(6),
    borderWidth: TUI_FRAME_STROKE_PX,
    strokeScaling: "canvas" as const,
    borderColor: palette.accent,
    background: hexToRgba(palette.panel, messageSurfaceAlpha(project)),
  };
  const baseFrameHeight = sizeLeft(composerHeight, chromePx(22));
  // A grown surface replaces the one-line one outright. Two translucent
  // rounded rectangles must never overlap, or the smaller shows through.
  const grownWindows = userTimings.flatMap((timing) => {
    const steps = composerGrowth.get(timing.message.id)?.steps ?? [];
    const windows: Array<{ startMs: number; endMs: number }> = [];
    let startMs: number | undefined;
    let previousExtraLines = 0;
    for (const step of steps) {
      if (previousExtraLines === 0 && step.extraLines > 0) {
        startMs = step.atMs;
      } else if (previousExtraLines > 0 && step.extraLines === 0 && startMs !== undefined) {
        windows.push({ startMs, endMs: step.atMs });
        startMs = undefined;
      }
      previousExtraLines = step.extraLines;
    }
    if (startMs !== undefined) {
      windows.push({ startMs, endMs: sendMomentMs(timing) });
    }
    return windows;
  });
  const baseHold = composerBasePanelAnimation(grownWindows, timeline.durationMs);
  return [
    ...userTimings.flatMap((timing) => {
      const steps = composerGrowth.get(timing.message.id)?.steps ?? [];
      return steps.flatMap((step, stepIndex) => {
        if (step.extraLines === 0) {
          return [];
        }
        const next = steps[stepIndex + 1];
        return Box({
          ...panelFrame,
          height: baseFrameHeight + step.extraLines * promptLinePx,
          meta: { "composer-panel": `${timing.message.id}:${stepIndex}` },
          animate: composerPanelAnimation({
            showMs: step.atMs,
            hideMs: next?.atMs ?? sendMomentMs(timing),
            // A terminal repaints: the grown box is gone in the same frame
            // the one-line surface comes back, so nothing overlaps it.
            settleMs: TUI_CHROME_SETTLE_MS,
            durationMs: timeline.durationMs,
          }),
        });
      });
    }),
    Box({
      ...panelFrame,
      height: baseFrameHeight,
      meta: { ...sceneActionMeta("compose-user"), "composer-panel": "base" },
      ...(pickerHold || baseHold
        ? { animate: mergeHolds(pickerHold, baseHold, timeline.durationMs) }
        : {}),
    }),
    // A terminal selector owns the prompt while it is live. Anchoring its
    // bottom to the prompt frame lets it spend that space first and borrow
    // only the rows by which it actually reaches into the transcript.
    ...choicePanels.map((panel) =>
      Box(
        {
          position: "absolute",
          left: inset + promptPadX,
          bottom: promptBottomInset,
          width: sizeLeft(width, inset * 2, promptPadX * 2),
          height: panel.height,
          // Only a clamped panel is cut. Painting past the title bar and the
          // canvas edge is not the option.
          ...(panel.clipped ? { overflow: "clip" as const } : {}),
          meta: { "composer-surface": "picker" },
        },
        // A panel too tall for the window scrolls to its answer: the clip
        // takes the head, and stops at the row carrying the mark.
        Box(
          {
            position: "absolute",
            left: 0,
            top: -panel.cutTop,
            width: sizeLeft(width, inset * 2, promptPadX * 2),
            height: panel.contentHeight,
          },
          panel.node,
        ),
      ),
    ),
    Box(
      {
        position: "absolute",
        left: inset + promptPadX,
        bottom: promptBottomInset,
        width: sizeLeft(width, inset * 2, promptPadX * 2),
        height: sizeLeft(composerHeight, chromePx(22)),
        padding: [chromePx(13), chromePx(14), chromePx(13), chromePx(14)],
        // The prompt, the draft and the hints ride above whichever surface is
        // showing, so a grown box swaps underneath them without taking the
        // text with it.
        // A real terminal's consent prompt replaces the input box; while a
        // picker owns this strip, the normal prompt is simply not there.
        ...(pickerHold ? { animate: pickerHold } : {}),
      },
      Text(
        {
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: promptFontPx,
          lineHeightPx: promptLinePx,
          color: readablePalette.accent,
          wrap: "none",
          // The mark belongs to the draft's first line, so it steps aside for
          // the copy that rides at the top of a grown box.
          ...(baseHold ? { animate: baseHold } : {}),
        },
        "❯ ",
      ),
      ...userTimings.flatMap((timing) => {
        const steps = composerGrowth.get(timing.message.id)?.steps ?? [];
        return steps.flatMap((step, stepIndex) => {
          if (step.extraLines === 0) {
            return [];
          }
          return Box(
            {
              position: "absolute",
              left: 0,
              top: chromePx(13) - step.extraLines * promptLinePx,
              width: promptLeft,
              height: promptLinePx,
              meta: { "composer-surface": "draft" },
              animate: stepVisibilityWindow(
                step.atMs,
                steps[stepIndex + 1]?.atMs ?? sendMomentMs(timing),
                timeline.durationMs,
              ),
            },
            Text(
              {
                font: MONO_FONT,
                fallback: MONO_FALLBACK,
                fontSizePx: promptFontPx,
                lineHeightPx: promptLinePx,
                color: readablePalette.accent,
                wrap: "none",
              },
              "❯ ",
            ),
          );
        });
      }),
      Box(
        {
          position: "absolute",
          left: promptLeft,
          top: chromePx(13),
          width: Math.ceil(promptCharPx) + 2,
          height: promptLinePx,
          ...(composerIdle ? { animate: composerIdle } : {}),
        },
        // A thin beam caret — drawn as a
        // box so its width never depends on glyph metrics.
        Box({
          position: "absolute",
          left: 0,
          top: Math.round(promptLinePx * 0.08),
          width: Math.max(2, Math.round(promptFontPx * 0.14)),
          height: Math.round(promptLinePx * 0.84),
          background: palette.text,
          animate: blink("hard"),
        }),
      ),
      ...userTimings.map((timing) => {
        const draftPlan = composerGrowth.get(timing.message.id);
        const draft = timing.draft;
        const stages = draftStages(timing);
        const lineWidth = (text: string): number =>
          measureLineWidthPx(engine, {
            text,
            font: MONO_FONT,
            fallback: MONO_FALLBACK,
            fontSizePx: promptFontPx,
            fontFeatureSettings: DRAFT_FONT_FEATURES,
            fallbackRatio: TUI_CHAR_RATIO,
          });
        return Box(
          {
            position: "absolute",
            left: promptLeft,
            // Lines stack upward out of the base slot, so the box is as tall
            // as this draft ever grows and its last line sits where the
            // one-line draft would have been.
            top: chromePx(13) - stages * promptLinePx,
            width: draftWidth,
            height: (stages + 1) * promptLinePx,
            overflow: "clip",
            animate: composerDraftAnimation(timing, timeline.durationMs, TUI_CHROME_SETTLE_MS),
            meta: { "draft-root": timing.message.id },
          },

          ...(draftPlan?.snapshots ?? []).map((snapshot, snapshotIndex) =>
            Box(
              {
                position: "absolute",
                left: 0,
                top: 0,
                width: draftWidth,
                height: (stages + 1) * promptLinePx,
                animate: stepVisibilityWindow(
                  snapshot.showMs,
                  snapshot.hideMs,
                  timeline.durationMs,
                ),
                meta: {
                  draft: timing.message.id,
                  phase: String(draft?.phases.indexOf(snapshot.phase) ?? -1),
                  snapshot: String(snapshotIndex),
                },
              },
              ...snapshot.lines.flatMap((line): AnyVNode[] => {
                const clusters = draftGraphemes(line.text);
                const typed = snapshot.phase.typed;
                const staticCount =
                  typed === undefined
                    ? clusters.length
                    : Math.max(0, Math.min(clusters.length, typed.from - line.sourceStart));
                const staticText = clusters.slice(0, staticCount).join("");
                const typedText = clusters.slice(staticCount).join("");
                const typedLeft = lineWidth(staticText);
                const textProps = {
                  position: "absolute" as const,
                  top: 0,
                  font: MONO_FONT,
                  fallback: MONO_FALLBACK,
                  fontSizePx: promptFontPx,
                  lineHeightPx: promptLinePx,
                  fontFeatureSettings: DRAFT_FONT_FEATURES,
                  color: palette.text,
                  wrap: "none" as const,
                };
                return [
                  Box(
                    {
                      position: "absolute",
                      left: 0,
                      top: line.slot * promptLinePx,
                      width: draftWidth,
                      height: promptLinePx,
                      overflow: "clip",
                      meta: {
                        "draft-line": timing.message.id,
                        "source-line": String(line.sourceLine),
                        "source-start": String(line.sourceStart),
                      },
                    },
                    ...(staticText.length > 0 || typedText.length === 0
                      ? [
                          Text(
                            {
                              ...textProps,
                              left: 0,
                              width: draftWidth,
                              meta: { "draft-static": timing.message.id },
                            },
                            staticText.length > 0 ? staticText : " ",
                          ),
                        ]
                      : []),
                    ...(typedText.length > 0 && typed !== undefined && draft !== undefined
                      ? [
                          Text(
                            {
                              ...textProps,
                              left: typedLeft,
                              width: Math.max(1, draftWidth - typedLeft),
                              animateUnits: typedUnits(
                                typed.startMs,
                                draft.charsPerSecond,
                                Math.max(0, line.sourceStart + staticCount - typed.from),
                              ),
                              meta: { "draft-typed": timing.message.id },
                            },
                            typedText,
                          ),
                        ]
                      : []),
                  ),
                ];
              }),
              ...snapshot.underlines.flatMap((underline): AnyVNode[] => {
                const baseTop = underline.slot * promptLinePx + promptLinePx - 3;
                const animate = stepVisibilityWindow(
                  underline.showMs,
                  snapshot.hideMs,
                  timeline.durationMs,
                );
                const rule = (top: number) =>
                  Box({
                    position: "absolute",
                    left: underline.leftPx,
                    top,
                    width: underline.widthPx,
                    height: 1,
                    background: palette.muted,
                    animate,
                    meta: {
                      "draft-mark": timing.message.id,
                      cluster: String(underline.cluster),
                      state: underline.settled ? "settled" : "composing",
                    },
                  });
                if (underline.settled) {
                  return [rule(baseTop - 1), rule(baseTop + 2)];
                }
                const width = underline.widthPx;
                const wave = tuiCompositionWave(width, promptCharPx);
                return [
                  Path({
                    position: "absolute",
                    left: underline.leftPx,
                    top: baseTop - wave.height / 2 + 1,
                    width,
                    height: wave.height,
                    d: wave.d,
                    fill: "none",
                    stroke: palette.muted,
                    strokeWidth: TUI_COMPOSITION_WAVE_STROKE_PX,
                    animate,
                    meta: {
                      "draft-mark": timing.message.id,
                      cluster: String(underline.cluster),
                      state: "composing",
                    },
                  }),
                ];
              }),
            ),
          ),
        );
      }),
      Text(
        {
          position: "absolute",
          left: chromePx(14),
          bottom: chromePx(9),
          width: modeHintWidth,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: hintFontPx,
          color: palette.warning,
          wrap: "char",
          maxLines: 1,
          ellipsis: true,
        },
        modeHint,
      ),
      Text(
        {
          position: "absolute",
          right: chromePx(14),
          bottom: chromePx(9),
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: hintFontPx,
          color: chromeMuted,
          wrap: "none",
        },
        statusHint,
      ),
    ),
  ];
}
