import {
  type AnimationSpec,
  type AnyVNode,
  Box,
  Canvas,
  type Engine,
  Flex,
  Path,
  Text,
} from "@boundsvg/core";
import {
  blink,
  stepVisibilityWindow,
  typedUnits,
  visibilityWindow,
  voiceWaveformBars,
} from "./animations.js";
import { backdropNodes, windowShadowNodes } from "./backdrop.js";
import { planCameraTrack } from "./camera.js";
import {
  COMPOSER_LINE_RISE_MS,
  COMPOSER_MAX_EXTRA_LINES,
  COMPOSER_PANEL_SHRINK_MS,
  composerBasePanelAnimation,
  composerDraftAnimation,
  composerDraftLine,
  composerIdleAnimation,
  composerPanelAnimation,
  planComposerShove,
  sendButtonAnimation,
  sendMomentMs,
  userLandingMs,
  userTypingWindows,
  voiceCaptureWindows,
  voiceChromeAnimation,
  voiceConfirmedDraftAnimation,
  voiceConfirmMs,
} from "./composer.js";
import {
  DRAFT_FONT_FEATURES,
  type DraftLayoutSnapshot,
  type DraftWrapOptions,
  draftClusterVisibleMs,
  planDraftLayoutSequence,
} from "./draft-layout.js";
import { COMPLETION_ACCEPT_MS, type DraftPhase } from "./draft-typing.js";
import {
  accentInk,
  chromeInk,
  hexToRgba,
  MONO_FALLBACK,
  MONO_FONT,
  messageSurfaceAlpha,
  metricsFor,
  paletteFor,
  SANS_FALLBACK,
  SANS_FONT,
  type SceneEnv,
  sessionClockLabel,
  sizeLeft,
  spacePx,
  TUI_CHAR_RATIO,
} from "./env.js";
import { draftGraphemes } from "./graphemes.js";
import { collectHighlightNoteHeights, planAppHighlights, planBeatLift } from "./highlight.js";
import { sceneActionMeta } from "./interaction.js";
import {
  contentAlignOffset,
  fitChromeScale,
  measureLineWidthPx,
  measureMessageHeights,
  messageHeightCacheKey,
} from "./measure.js";
import {
  appAttachedImagesRegion,
  appChoiceOptionsRegion,
  appHighlightNote,
  appHighlightNoteBlock,
  appHighlightNoteHeight,
  appMessage,
  appMessageBand,
  appMessageInkWidthPx,
  appPickerComposerPanel,
  choiceCollapses,
  PICKER_FADE_MS,
  pickerCloseMs,
  pickerCutTop,
} from "./messages.js";
import {
  disclosureFor,
  resolveSafeModelLabel,
  type SessionMessage,
  type SvgentProject,
} from "./model.js";
import { appScrollbarThumb, planAutoFollowScroll } from "./scroll.js";
import {
  buildTimeline,
  choiceDraftTiming,
  composerDraftTimings,
  type SessionTimeline,
} from "./timeline.js";

// ————————————————————————————————————————————————————————————————————————————
// Scenes
// ————————————————————————————————————————————————————————————————————————————

// Geometry shared between the layout and the camera plan: the camera can
// only frame what it can locate, so these carry names instead of living
// as scattered literals.
/** Sans width per em for draft estimates when no engine can measure. */
const DRAFT_MEASURE_FALLBACK_RATIO = 0.62;
/** Breathing room the camera keeps around a measured draft (chrome px). */
const CAMERA_DRAFT_PAD_PX = 64;
/** Attached banners land one beat after the bubble; the close-up waits. */
const CAMERA_IMAGE_SHOT_DELAY_MS = 500;

/** Bottom edge of the permanent transcript slot, expressed as a canvas reserve. */
function appTranscriptBottomReserve(options: {
  composer: boolean;
  footer: boolean;
  windowMargin: number;
  composerBottom: number;
  composerBoxHeight: number;
  footerHeight: number;
}): number {
  const { composer, footer, windowMargin, composerBottom, composerBoxHeight, footerHeight } =
    options;
  if (composer) {
    return composerBottom + composerBoxHeight;
  }
  return windowMargin + (footer ? footerHeight : 0);
}

/** The status bar under the composer, plus the page counter when slides split the script. */
function appFooterNodes(layout: {
  env: SceneEnv;
  pageIndex: number;
  pageCount: number;
  chromeMuted: string;
  chromePx: (px: number) => number;
  chromeFontPx: (base: number) => number;
  win: number;
  composerWidth: number;
  /** Frame padding the composer shares with the transcript. */
  composerPadX: number;
}): AnyVNode[] {
  const {
    env,
    pageIndex,
    pageCount,
    chromeMuted,
    chromePx,
    chromeFontPx,
    win,
    composerWidth,
    composerPadX,
  } = layout;
  const { project } = env;
  const display = project.display;
  return [
    ...(display.footer
      ? [
          Text(
            {
              position: "absolute",
              left: win + composerPadX,
              bottom: win + chromePx(7),
              width: composerWidth,
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx: chromeFontPx(13),
              color: chromeMuted,
              wrap: "none",
              // Long model labels or a wide context line would overrun the
              // footer; let the engine shrink the type instead of clipping.
              fit: "shrink",
              minFontSizePx: 8,
              meta: { edit: "field:footer" },
            },
            [
              display.productMark
                ? display.productVersion && env.product.version.length > 0
                  ? `${env.product.name} v${env.product.version}`
                  : env.product.name
                : "",
              resolveSafeModelLabel(project.modelLabel),
              `context ${project.chrome.contextPercent}%`,
              pageCount > 1 ? `page ${pageIndex + 1}/${pageCount}` : "",
            ]
              .filter((part) => part.length > 0)
              .join("   ·   "),
          ),
        ]
      : []),
  ];
}

type AppDraftGrowthStep = { atMs: number; extraLines: number };
type AppDraftLine = {
  text: string;
  sourceStart: number;
  sourceEnd: number;
  sourceLine: number;
  slot: number;
};
type AppDraftSnapshot = {
  showMs: number;
  hideMs: number | null;
  phase: DraftPhase;
  text: string;
  lines: AppDraftLine[];
};
type AppDraftPlan = {
  steps: AppDraftGrowthStep[];
  maxExtraLines: number;
  snapshots: AppDraftSnapshot[];
};
type AppDraftPlans = Map<string, AppDraftPlan>;

function placeAppSnapshot(snapshot: DraftLayoutSnapshot, maxExtraLines: number): AppDraftSnapshot {
  const capacity = maxExtraLines + 1;
  const firstVisibleLine = Math.max(0, snapshot.plan.lines.length - capacity);
  const visibleCount = snapshot.plan.lines.length - firstVisibleLine;
  const firstSlot = maxExtraLines - (visibleCount - 1);
  return {
    showMs: snapshot.showMs,
    hideMs: snapshot.hideMs,
    phase: snapshot.phase,
    text: snapshot.text,
    lines: snapshot.plan.lines.slice(firstVisibleLine).map((text, visibleIndex) => {
      const sourceLine = firstVisibleLine + visibleIndex;
      return {
        text,
        sourceStart: snapshot.plan.lineStartOffsets[sourceLine] ?? 0,
        sourceEnd: snapshot.plan.lineEndOffsets[sourceLine] ?? 0,
        sourceLine,
        slot: firstSlot + visibleIndex,
      };
    }),
  };
}

function planAppDrafts(options: {
  userTimings: SessionTimeline["messages"];
  wrap: DraftWrapOptions;
}): AppDraftPlans {
  const { userTimings, wrap } = options;
  const plans: AppDraftPlans = new Map();
  for (const timing of userTimings) {
    const draft = timing.draft;
    if (draft === undefined) {
      continue;
    }
    const sequence = planDraftLayoutSequence({ draft, wrap });
    const steps: AppDraftGrowthStep[] = [];
    let currentExtraLines = 0;
    if (timing.message.inputMode !== "voice") {
      for (const state of sequence.lineStates) {
        const extraLines = Math.min(Math.max(0, state.lineCount - 1), COMPOSER_MAX_EXTRA_LINES);
        if (extraLines === currentExtraLines) {
          continue;
        }
        const last = steps.at(-1);
        if (last?.atMs === state.atMs) {
          last.extraLines = extraLines;
        } else {
          steps.push({ atMs: state.atMs, extraLines });
        }
        currentExtraLines = extraLines;
      }
    }
    const maxExtraLines = steps.reduce((maximum, step) => Math.max(maximum, step.extraLines), 0);
    plans.set(timing.message.id, {
      steps,
      maxExtraLines,
      snapshots: sequence.snapshots.map((snapshot) => placeAppSnapshot(snapshot, maxExtraLines)),
    });
  }
  return plans;
}

function appComposerExpansionWindows(options: {
  userTimings: SessionTimeline["messages"];
  draftPlans: AppDraftPlans;
  collapsedChoiceTimings: SessionTimeline["messages"];
  project: SvgentProject;
}): Array<{ startMs: number; endMs: number; crossFadeMs?: number }> {
  const { userTimings, draftPlans, collapsedChoiceTimings, project } = options;
  return [
    ...userTimings.flatMap((timing) => {
      const steps = draftPlans.get(timing.message.id)?.steps ?? [];
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
        windows.push({
          startMs,
          endMs: sendMomentMs(timing) + COMPOSER_PANEL_SHRINK_MS,
        });
      }
      return windows;
    }),
    ...collapsedChoiceTimings.map((timing) => ({
      startMs: timing.startMs,
      // The panel comes back with the prompt: a freeform answer needs it.
      endMs: pickerCloseMs(timing, project) + COMPOSER_PANEL_SHRINK_MS,
      // The card eases in over this window, so the two cross rather than hand
      // over through a frame with neither of them on screen.
      crossFadeMs: PICKER_FADE_MS,
    })),
  ];
}

/**
 * The transcript's stand-off from the grown composer, as one animation.
 *
 * The composer is chrome: its growth is not in the transcript's height
 * budget, so without this the last messages are simply covered by the panel.
 * A chat list answers the same problem by moving off the rows the input
 * claims, and coming back when the draft is sent. Each stage carries only the
 * distance that stage would actually cover, so a conversation whose last line
 * sits well above the prompt never moves at all.
 */
function planTranscriptStandoff(options: {
  fullHeight: boolean;
  userTimings: SessionTimeline["messages"];
  allTimings: SessionTimeline["messages"];
  draftPlans: AppDraftPlans;
  messageHeights: number[];
  messageGap: number;
  contentOffsetY: number;
  scrollPlan: ReturnType<typeof planAutoFollowScroll> | undefined;
  transcriptViewport: number;
  composerLinePx: number;
  clipBottom: number;
  composerTop: number;
  durationMs: number;
  /** Pickers grown out of the composer's frame: one stage, then release. */
  pickerPanels: Array<{
    timing: SessionTimeline["messages"][number];
    extraPx: number;
  }>;
  /** When each picker hands the rows it borrowed back to the transcript. */
  pickerReleaseMs: (timing: SessionTimeline["messages"][number]) => number;
}): AnimationSpec | null {
  const {
    fullHeight,
    userTimings,
    allTimings,
    draftPlans,
    messageHeights,
    messageGap,
    contentOffsetY,
    scrollPlan,
    transcriptViewport,
    composerLinePx,
    clipBottom,
    composerTop,
    durationMs,
    pickerPanels,
    pickerReleaseMs,
  } = options;
  if (fullHeight) {
    // A full-height transcript has no scroll viewport to protect.
    return null;
  }
  const intrusionPx = (extraLines: number): number =>
    Math.max(0, clipBottom - (composerTop - extraLines * composerLinePx));
  // A freeform answer's draft is derived, not one of the timeline's own
  // entries, so its block is found by message id rather than by identity.
  const blockIndexOf = (timing: SessionTimeline["messages"][number]): number =>
    allTimings.findIndex((candidate) => candidate.message.id === timing.message.id);
  const priorBottomAt = (index: number): number => {
    if (index <= 0) {
      return 0;
    }
    const priorFlowHeight = messageHeights
      .slice(0, index)
      .reduce(
        (sum: number, blockHeight, priorIndex) =>
          sum + blockHeight + (priorIndex > 0 ? messageGap : 0),
        0,
      );
    return contentOffsetY + priorFlowHeight - (scrollPlan?.offsets[index] ?? 0);
  };
  const messageTopAt = (index: number): number =>
    priorBottomAt(index) + (index > 0 ? messageGap : contentOffsetY);
  const pickerDrafts = pickerPanels.map(({ timing, extraPx }) => {
    const index = blockIndexOf(timing);
    const visibleBottom = priorBottomAt(index);
    const intrusion = Math.max(0, clipBottom - (composerTop - extraPx));
    return {
      releaseMs: pickerReleaseMs(timing),
      stages: [
        {
          atMs: timing.startMs,
          shovePx: Math.max(
            0,
            // Never more than the viewport itself, the same bound the TUI row
            // shove carries: a surface reaching past the whole band would
            // otherwise push every row out of it and leave the transcript
            // empty, which reads as a bug rather than as room made.
            Math.min(
              intrusion,
              transcriptViewport,
              visibleBottom - (transcriptViewport - intrusion),
            ),
          ),
        },
      ],
    };
  });
  return planComposerShove({
    durationMs,
    // The rows come back over the same beat the panel folds away.
    settleMs: COMPOSER_PANEL_SHRINK_MS,
    drafts: [
      ...pickerDrafts,
      ...userTimings.map((timing) => {
        const index = blockIndexOf(timing);
        const plan = draftPlans.get(timing.message.id);
        // What the reader can see above the composer while this draft is
        // typed: the message itself has not landed in the transcript yet.
        const visibleBottom = priorBottomAt(index);
        const landedBottom = messageTopAt(index) + (messageHeights[index] ?? 0);
        const landedIntrusion = intrusionPx(plan?.steps.at(-1)?.extraLines ?? 0);
        return {
          // Once the sent bubble lands it is part of the visible column too.
          // Keep it clear until the complete grown surface disappears;
          // translucent geometry is still geometry while it fades.
          releaseMs: sendMomentMs(timing) + COMPOSER_PANEL_SHRINK_MS,
          settleMs: 0,
          stages: [
            ...(plan?.steps ?? []).map((step) => {
              const intrusion = intrusionPx(step.extraLines);
              return {
                atMs: step.atMs,
                shovePx: Math.max(
                  0,
                  Math.min(intrusion, visibleBottom - (transcriptViewport - intrusion)),
                ),
              };
            }),
            ...(landedIntrusion > 0
              ? [
                  {
                    atMs: userLandingMs(timing),
                    shovePx: Math.max(
                      0,
                      Math.min(
                        landedIntrusion,
                        landedBottom - (transcriptViewport - landedIntrusion),
                      ),
                    ),
                  },
                ]
              : []),
          ],
        };
      }),
    ],
  });
}

/**
 * Wraps the transcript column only when it actually has a stand-off to carry.
 *
 * `preclip` puts a second box of the same size *inside* the moving one, so the
 * column is cropped in its own coordinates before the stand-off lifts it. A
 * bubble's landing spring paints below its laid-out bottom, and the stand-off
 * moves the whole subtree — without this the overshoot is carried back up into
 * the band and shows under the composer, which is what the shove distance,
 * measured from layout boxes, has no way to know about. Only the composer's
 * stand-off takes it: the highlight's lifts content in from outside the
 * viewport, and cropping there would hide a row before it arrives.
 */
function standoffLayer(
  animate: AnimationSpec | null,
  box: { width: number; height: number; preclip?: boolean },
  children: AnyVNode[],
): AnyVNode[] {
  if (animate === null) {
    return children;
  }
  const frame = {
    position: "absolute" as const,
    left: 0,
    top: 0,
    width: box.width,
    height: box.height,
  };
  return [
    Box(
      { ...frame, animate },
      ...(box.preclip ? [Box({ ...frame, overflow: "clip" as const }, ...children)] : children),
    ),
  ];
}

/** Header actions and the title block, drawn as shapes so no glyph coverage is needed. */
function appHeaderNodes(layout: {
  env: SceneEnv;
  chromeBorder: string;
  chromeMuted: string;
  chromePx: (px: number) => number;
  chromeScale: number;
  win: number;
  /** Where the buttons sit so the band holds them in its middle. */
  headerIconsTop: number;
}): AnyVNode[] {
  const { env, chromeBorder, chromeMuted, chromePx, chromeScale, win, headerIconsTop } = layout;
  const { project } = env;
  const display = project.display;
  return [
    // GUI-only header actions: new chat / search / more. Drawn as vector
    // shapes so no glyph coverage is needed.
    ...(display.header && display.headerIcons
      ? [
          Box(
            {
              position: "absolute",
              right: win + chromePx(92),
              top: win + headerIconsTop,
              width: chromePx(APP_HEADER_ICONS_SIZE),
              height: chromePx(APP_HEADER_ICONS_SIZE),
              borderRadius: chromePx(8),
              borderWidth: 1,
              borderColor: chromeBorder,
            },
            Box({
              position: "absolute",
              left: chromePx(7),
              top: chromePx(7),
              width: chromePx(16),
              height: chromePx(16),
              borderRadius: chromePx(4),
              borderWidth: 1.6 * chromeScale,
              borderColor: chromeMuted,
            }),
            // The plus sits on whole pixels: 1.8-wide bars at x/y 14.1 shared
            // the icon's centre exactly, but their fractional edges antialias
            // unevenly and the glyph reads as pushed off it.
            Box({
              position: "absolute",
              left: chromePx(11),
              top: chromePx(14),
              width: chromePx(8),
              height: chromePx(2),
              borderRadius: chromePx(1),
              background: chromeMuted,
            }),
            Box({
              position: "absolute",
              left: chromePx(14),
              top: chromePx(11),
              width: chromePx(2),
              height: chromePx(8),
              borderRadius: chromePx(1),
              background: chromeMuted,
            }),
          ),
          Box(
            {
              position: "absolute",
              right: win + chromePx(56),
              top: win + headerIconsTop,
              width: chromePx(APP_HEADER_ICONS_SIZE),
              height: chromePx(APP_HEADER_ICONS_SIZE),
              borderRadius: chromePx(8),
              borderWidth: 1,
              borderColor: chromeBorder,
            },
            Box({
              position: "absolute",
              left: chromePx(7),
              top: chromePx(7),
              width: chromePx(12),
              height: chromePx(12),
              borderRadius: 999,
              borderWidth: 1.8 * chromeScale,
              borderColor: chromeMuted,
            }),
            Box({
              position: "absolute",
              left: chromePx(18.4),
              top: chromePx(17.4),
              width: chromePx(2),
              height: chromePx(7),
              borderRadius: chromePx(1),
              background: chromeMuted,
              transform: { rotateDeg: -45 },
            }),
          ),
          Box(
            {
              position: "absolute",
              right: win + chromePx(20),
              top: win + headerIconsTop,
              width: chromePx(APP_HEADER_ICONS_SIZE),
              height: chromePx(APP_HEADER_ICONS_SIZE),
              borderRadius: chromePx(8),
              borderWidth: 1,
              borderColor: chromeBorder,
            },
            ...[8, 13.8, 19.6].map((top) =>
              Box({
                position: "absolute",
                left: chromePx(13.6),
                top: chromePx(top),
                width: chromePx(3),
                height: chromePx(3),
                borderRadius: 999,
                background: chromeMuted,
              }),
            ),
          ),
        ]
      : []),
  ];
}

/** The composer: panel frame, typed draft, cursor, controls, and send button. */

/** One App underline rule per visible grapheme on one wrapped row. */
function appDraftUnderlineNodes(options: {
  messageId: string;
  snapshot: AppDraftSnapshot;
  line: AppDraftLine;
  charsPerSecond: number;
  widthOf: (text: string) => number;
  topPx: number;
  color: string;
}): AnyVNode[] {
  const { messageId, snapshot, line, charsPerSecond, widthOf, topPx, color } = options;
  const composing = snapshot.phase.composing;
  if (composing === undefined) {
    return [];
  }
  const clusters = draftGraphemes(snapshot.text);
  const nodes: AnyVNode[] = [];
  const from = Math.max(composing.from, line.sourceStart);
  const to = Math.min(composing.to, line.sourceEnd, clusters.length);
  for (let cluster = from; cluster < to; cluster += 1) {
    const before = clusters.slice(line.sourceStart, cluster).join("");
    const through = clusters.slice(line.sourceStart, cluster + 1).join("");
    const fromX = widthOf(before);
    const widthPx = Math.max(2, widthOf(through) - fromX);
    const animate = visibilityWindow(
      composing.settled
        ? snapshot.showMs
        : draftClusterVisibleMs(snapshot.phase, cluster, charsPerSecond),
      snapshot.hideMs,
      60,
    );
    const frame = {
      position: "absolute" as const,
      left: fromX,
      top: topPx,
      width: widthPx,
      height: 1.5,
      animate,
      meta: {
        "draft-mark": messageId,
        cluster: String(cluster),
        state: composing.settled ? "settled" : "composing",
      },
    };
    nodes.push(
      composing.settled
        ? Box({ ...frame, background: color })
        : Path({
            ...frame,
            d: `M0 0.75 H${widthPx}`,
            fill: "none",
            stroke: color,
            strokeWidth: 1.5,
            strokeDasharray: "3,2",
          }),
    );
  }
  return nodes;
}

function appDraftLineParts(
  snapshot: AppDraftSnapshot,
  line: AppDraftLine,
): {
  staticText: string;
  staticCount: number;
  typedText: string;
} {
  const clusters = draftGraphemes(line.text);
  const typed = snapshot.phase.typed;
  const staticCount =
    typed === undefined
      ? clusters.length
      : Math.max(0, Math.min(clusters.length, typed.from - line.sourceStart));
  return {
    staticText: clusters.slice(0, staticCount).join(""),
    staticCount,
    typedText: clusters.slice(staticCount).join(""),
  };
}

function appDraftRowAnimation(options: {
  previous: AppDraftSnapshot | undefined;
  snapshot: AppDraftSnapshot;
  line: AppDraftLine;
  linePx: number;
}): AnimationSpec | undefined {
  const { previous, snapshot, line, linePx } = options;
  const previousLine = previous?.lines.find(
    (candidate) => candidate.sourceStart === line.sourceStart,
  );
  const initialShift = previousLine === undefined ? 0 : (previousLine.slot - line.slot) * linePx;
  // Growth lifts an existing row inside the newly expanded surface. A
  // shrink swaps to the smaller complete surface in one state change; easing
  // a row downward after that swap would paint it outside the panel.
  if (initialShift <= 0) {
    return undefined;
  }
  const availableMotionMs =
    snapshot.hideMs === null
      ? COMPOSER_LINE_RISE_MS
      : Math.max(1, snapshot.hideMs - snapshot.showMs);
  return {
    keyframes: [
      { at: 0, transform: { translateY: initialShift } },
      { at: 1, transform: { translateY: 0 } },
    ],
    durationMs: Math.min(COMPOSER_LINE_RISE_MS, availableMotionMs),
    delayMs: snapshot.showMs,
    easing: "ease-out",
    fill: "both",
  };
}

function appDraftLineNode(options: {
  messageId: string;
  snapshot: AppDraftSnapshot;
  previous: AppDraftSnapshot | undefined;
  line: AppDraftLine;
  draft: NonNullable<SessionTimeline["messages"][number]["draft"]>;
  draftWidth: number;
  composerLinePx: number;
  composerTextPx: number;
  textColor: string;
  markColor: string;
  sceneDurationMs: number;
  widthOf: (text: string) => number;
}): AnyVNode {
  const {
    messageId,
    snapshot,
    previous,
    line,
    draft,
    draftWidth,
    composerLinePx,
    composerTextPx,
    textColor,
    markColor,
    sceneDurationMs,
    widthOf,
  } = options;
  const parts = appDraftLineParts(snapshot, line);
  const typed = snapshot.phase.typed;
  const typedLeft = widthOf(parts.staticText);
  const rowAnimation = appDraftRowAnimation({ previous, snapshot, line, linePx: composerLinePx });
  const suggestion =
    line.sourceEnd >= draftGraphemes(snapshot.text).length ? snapshot.phase.suggestion : undefined;
  const textProps = {
    position: "absolute" as const,
    top: 0,
    font: SANS_FONT,
    fallback: SANS_FALLBACK,
    fontSizePx: composerTextPx,
    lineHeightPx: composerLinePx,
    fontFeatureSettings: DRAFT_FONT_FEATURES,
    color: textColor,
    wrap: "none" as const,
  };
  return Box(
    {
      position: "absolute",
      left: 0,
      top: line.slot * composerLinePx,
      width: draftWidth,
      height: composerLinePx + 6,
      overflow: "clip",
      ...(rowAnimation ? { animate: rowAnimation } : {}),
      meta: {
        "draft-line": messageId,
        "source-line": String(line.sourceLine),
        "source-start": String(line.sourceStart),
      },
    },
    // What Tab would take, offered where it would land. Faint, because it is
    // not text yet: the composer is proposing it, and an editor draws the part
    // it is proposing rather than the part already accepted. Only the last
    // line carries it — the suggestion continues the draft, so it sits at the
    // end of what has been keyed.
    ...(suggestion === undefined
      ? []
      : [
          Text(
            {
              ...textProps,
              left: widthOf(line.text),
              width: Math.max(1, draftWidth - widthOf(line.text)),
              color: markColor,
              // No fade. The offer appears on a keystroke and is replaced by
              // the key that takes it; easing either edge turns two states
              // into one blur, which is what a 60ms fade did here.
              animate: stepVisibilityWindow(
                suggestion.atMs,
                snapshot.hideMs ?? suggestion.atMs + COMPLETION_ACCEPT_MS,
                sceneDurationMs,
              ),
              meta: { "draft-suggestion": messageId },
            },
            suggestion.text,
          ),
        ]),
    ...(parts.staticText.length > 0 || parts.typedText.length === 0
      ? [
          Text(
            {
              ...textProps,
              left: 0,
              width: draftWidth,
              meta: { "draft-static": messageId },
            },
            parts.staticText.length > 0 ? parts.staticText : " ",
          ),
        ]
      : []),
    ...(parts.typedText.length > 0 && typed !== undefined
      ? [
          Text(
            {
              ...textProps,
              left: typedLeft,
              width: Math.max(1, draftWidth - typedLeft),
              animateUnits: typedUnits(
                typed.startMs,
                draft.charsPerSecond,
                Math.max(0, line.sourceStart + parts.staticCount - typed.from),
              ),
              meta: { "draft-typed": messageId },
            },
            parts.typedText,
          ),
        ]
      : []),
    ...appDraftUnderlineNodes({
      messageId,
      snapshot,
      line,
      charsPerSecond: draft.charsPerSecond,
      widthOf,
      topPx: composerLinePx - 2,
      color: markColor,
    }),
  );
}

function appComposerNodes(layout: {
  env: SceneEnv;
  timeline: SessionTimeline;
  userTimings: SessionTimeline["messages"];
  draftPlans: AppDraftPlans;
  composerIdle: AnimationSpec | undefined;
  sendPulse: AnimationSpec | undefined;
  composerBasePanel: AnimationSpec | undefined;
  /** Collapsing choices, drawn as the frame's own temporary growth. */
  choicePanels: Array<{
    timing: SessionTimeline["messages"][number];
    panel: {
      node: AnyVNode;
      height: number;
      contentHeight: number;
      cutTop: number;
      clipped: boolean;
    };
  }>;
  chromeBorder: string;
  chromeMuted: string;
  chromePx: (px: number) => number;
  chromeFontPx: (base: number) => number;
  chromeScale: number;
  win: number;
  composerWidth: number;
  /** Frame padding the composer shares with the transcript. */
  composerPadX: number;
  composerBottom: number;
  composerBoxHeight: number;
  composerLinePx: number;
  composerTextPx: number;
  draftWidth: number;
}): AnyVNode[] {
  const {
    env,
    timeline,
    userTimings,
    draftPlans,
    composerIdle,
    sendPulse,
    composerBasePanel,
    choicePanels,
    chromeBorder,
    chromeMuted,
    chromePx,
    chromeFontPx,
    chromeScale,
    win,
    composerWidth,
    composerPadX,
    composerBottom,
    composerBoxHeight,
    composerLinePx,
    composerTextPx,
    draftWidth,
  } = layout;
  const { project, palette, engine } = env;
  const display = project.display;
  if (!display.composer) {
    return [];
  }
  const voiceWindows = voiceCaptureWindows(userTimings);
  const micIdleAnimation = voiceChromeAnimation(voiceWindows, timeline.durationMs, false);
  const confirmLiveAnimation = voiceChromeAnimation(voiceWindows, timeline.durationMs, true);
  // A consent surface offers its own controls: while a picker holds the
  // frame, the draft affordances — plus button, mode chip, model label,
  // mic, send — step aside with the placeholder instead of floating over
  // the card. A grown draft keeps them; only pickers displace them.
  const pickerHold = composerBasePanelAnimation(
    choicePanels.map(({ timing }) => ({
      startMs: timing.startMs,
      // A picker that hands the keyboard back releases the composer's own
      // affordances with it; the draft that follows needs them.
      endMs: pickerCloseMs(timing, env.project) + COMPOSER_PANEL_SHRINK_MS,
      crossFadeMs: PICKER_FADE_MS,
    })),
    timeline.durationMs,
  );
  return [
    ...(display.composer
      ? [
          Box(
            {
              position: "absolute",
              left: win + composerPadX,
              bottom: composerBottom,
              width: composerWidth,
              height: composerBoxHeight,
              padding: [chromePx(13), chromePx(16), chromePx(13), chromePx(16)],
              meta: sceneActionMeta("compose-user"),
            },
            Box({
              position: "absolute",
              left: 0,
              top: 0,
              width: composerWidth,
              height: composerBoxHeight,
              borderRadius: chromePx(16),
              background: hexToRgba(palette.panelStrong, messageSurfaceAlpha(project)),
              borderWidth: 1,
              borderColor: palette.border,
              meta: { "composer-panel": "base" },
              ...(composerBasePanel ? { animate: composerBasePanel } : {}),
            }),
            // Complete, mutually exclusive surfaces for expanded drafts. A
            // semi-transparent stage never sits on top of the one-line box.
            ...userTimings.flatMap((timing) => {
              const plan = draftPlans.get(timing.message.id);
              // Voice input never grows the panel: the level bars live on
              // the one-line surface until the transcript lands.
              if (plan === undefined || timing.message.inputMode === "voice") {
                return [];
              }
              return plan.steps.flatMap((step, stepIndex) => {
                if (step.extraLines === 0) {
                  return [];
                }
                const next = plan.steps[stepIndex + 1];
                return Box({
                  position: "absolute",
                  left: 0,
                  top: -(step.extraLines * composerLinePx),
                  width: composerWidth,
                  height: composerBoxHeight + step.extraLines * composerLinePx,
                  borderRadius: chromePx(16),
                  background: hexToRgba(palette.panelStrong, messageSurfaceAlpha(project)),
                  borderWidth: 1,
                  borderColor: palette.border,
                  meta: {
                    "composer-panel": `${timing.message.id}:${stepIndex}`,
                  },
                  animate: composerPanelAnimation({
                    showMs: step.atMs,
                    hideMs: next?.atMs ?? sendMomentMs(timing),
                    // The app folds its grown surface away; intermediate
                    // stages are replaced outright by the next one.
                    settleMs: next === undefined ? COMPOSER_PANEL_SHRINK_MS : 0,
                    durationMs: timeline.durationMs,
                  }),
                });
              });
            }),
            // The picker as the frame's own growth: the same card the
            // transcript would have held, grown upward out of the composer
            // while the pick is live.
            ...choicePanels.map(({ panel }) =>
              Box(
                {
                  position: "absolute",
                  left: 0,
                  top: -Math.max(0, panel.height - composerBoxHeight),
                  width: composerWidth,
                  height: panel.height,
                  // Only a clamped card is cut. An unclamped one keeps the
                  // slack its estimated height leaves it.
                  ...(panel.clipped ? { overflow: "clip" as const } : {}),
                  meta: { "composer-surface": "picker" },
                },
                // A card too tall for the window scrolls to its answer: the
                // clip takes the head, and stops at the row with the mark.
                Box(
                  {
                    position: "absolute",
                    left: 0,
                    top: -panel.cutTop,
                    width: composerWidth,
                    height: panel.contentHeight,
                  },
                  panel.node,
                ),
              ),
            ),
            Box(
              {
                position: "absolute",
                left: chromePx(18),
                top: chromePx(13),
                width: 2,
                height: Math.max(17, composerTextPx + 4),
                ...(composerIdle ? { animate: composerIdle } : {}),
              },
              Box({
                width: 2,
                height: Math.max(17, composerTextPx + 4),
                borderRadius: 1,
                background: palette.accent,
                animate: blink("soft"),
              }),
            ),
            Text(
              {
                position: "absolute",
                left: chromePx(26),
                top: chromePx(13),
                width: sizeLeft(composerWidth, chromePx(42)),
                font: SANS_FONT,
                fallback: SANS_FALLBACK,
                fontSizePx: composerTextPx,
                color: palette.faint,
                wrap: "none",
                ...(composerIdle ? { animate: composerIdle } : {}),
              },
              "Write a follow-up…",
            ),
            ...userTimings.flatMap((timing) => {
              const plan = draftPlans.get(timing.message.id);
              if (plan === undefined) {
                return [];
              }
              if (timing.message.inputMode === "voice") {
                return [
                  // Level bars while the capture is live.
                  Box(
                    {
                      position: "absolute",
                      left: chromePx(26),
                      top: chromePx(11),
                      width: draftWidth,
                      height: composerLinePx + 6,
                      overflow: "clip",
                      meta: { part: "voice-waveform" },
                      animate: visibilityWindow(timing.startMs, voiceConfirmMs(timing), 140),
                    },
                    voiceWaveformBars({
                      color: palette.accent,
                      heightPx: composerLinePx - 2,
                      barWidthPx: Math.max(2, chromePx(3)),
                      gapPx: chromePx(3),
                      barCount: 24,
                    }),
                  ),
                  // The confirmed transcript lands whole, then leaves on the send.
                  Box(
                    {
                      position: "absolute",
                      left: chromePx(26),
                      top: chromePx(11),
                      width: draftWidth,
                      height: composerLinePx + 6,
                      overflow: "clip",
                      animate: voiceConfirmedDraftAnimation(timing, timeline.durationMs),
                    },
                    Text(
                      {
                        width: draftWidth,
                        font: SANS_FONT,
                        fallback: SANS_FALLBACK,
                        fontSizePx: composerTextPx,
                        lineHeightPx: composerLinePx,
                        color: palette.text,
                        wrap: "none",
                      },
                      composerDraftLine(timing.message.content),
                    ),
                  ),
                ];
              }

              const draft = timing.draft;
              if (draft === undefined) {
                return [];
              }
              const sansWidth = (text: string): number =>
                measureLineWidthPx(engine, {
                  text,
                  font: SANS_FONT,
                  fallback: SANS_FALLBACK,
                  fontSizePx: composerTextPx,
                  fontFeatureSettings: DRAFT_FONT_FEATURES,
                  fallbackRatio: DRAFT_MEASURE_FALLBACK_RATIO,
                });
              return [
                Box(
                  {
                    position: "absolute",
                    left: chromePx(26),
                    top: chromePx(11) - plan.maxExtraLines * composerLinePx,
                    width: draftWidth,
                    height: (plan.maxExtraLines + 1) * composerLinePx + 8,
                    overflow: "clip",
                    animate: composerDraftAnimation(
                      timing,
                      timeline.durationMs,
                      COMPOSER_PANEL_SHRINK_MS,
                    ),
                    meta: { "draft-root": timing.message.id },
                  },
                  ...plan.snapshots.map((snapshot, snapshotIndex) => {
                    const previous = plan.snapshots[snapshotIndex - 1];
                    return Box(
                      {
                        position: "absolute",
                        left: 0,
                        top: 0,
                        width: draftWidth,
                        height: (plan.maxExtraLines + 1) * composerLinePx + 8,
                        animate: stepVisibilityWindow(
                          snapshot.showMs,
                          snapshot.hideMs,
                          timeline.durationMs,
                        ),
                        meta: {
                          draft: timing.message.id,
                          phase: String(draft.phases.indexOf(snapshot.phase)),
                          snapshot: String(snapshotIndex),
                        },
                      },
                      ...snapshot.lines.map((line) =>
                        appDraftLineNode({
                          messageId: timing.message.id,
                          snapshot,
                          previous,
                          line,
                          draft,
                          draftWidth,
                          composerLinePx,
                          composerTextPx,
                          textColor: palette.text,
                          markColor: palette.muted,
                          sceneDurationMs: timeline.durationMs,
                          widthOf: sansWidth,
                        }),
                      ),
                    );
                  }),
                ),
              ];
            }),
            Box(
              {
                position: "absolute",
                left: 0,
                top: 0,
                width: composerWidth,
                height: composerBoxHeight,
                ...(pickerHold ? { animate: pickerHold } : {}),
              },
              Flex(
                {
                  position: "absolute",
                  left: chromePx(16),
                  bottom: chromePx(9),
                  direction: "row",
                  gap: chromePx(8),
                  alignItems: "center",
                },
                // "+" attach button sits at the head of the mode-chip row.
                Box(
                  {
                    position: "relative",
                    width: chromePx(24),
                    height: chromePx(24),
                    borderRadius: chromePx(8),
                    borderWidth: 1.2 * chromeScale,
                    borderColor: chromeBorder,
                  },
                  Box({
                    position: "absolute",
                    left: chromePx(6.4),
                    top: chromePx(11),
                    width: chromePx(11.2),
                    height: chromePx(2),
                    borderRadius: chromePx(1),
                    background: chromeMuted,
                  }),
                  Box({
                    position: "absolute",
                    left: chromePx(11),
                    top: chromePx(6.4),
                    width: chromePx(2),
                    height: chromePx(11.2),
                    borderRadius: chromePx(1),
                    background: chromeMuted,
                  }),
                ),
                Box(
                  {
                    padding: [chromePx(2), chromePx(9), chromePx(3), chromePx(9)],
                    borderRadius: 999,
                    background: palette.panelSoft,
                    borderWidth: 1,
                    borderColor: palette.border,
                  },
                  Text(
                    {
                      font: MONO_FONT,
                      fallback: MONO_FALLBACK,
                      fontSizePx: chromeFontPx(11),
                      color: palette.warning,
                      letterSpacingPx: 0.6,
                      wrap: "none",
                    },
                    "ASK BEFORE EDITS",
                  ),
                ),
              ),
              // Model label rides left of the mic and send controls.
              Text(
                {
                  position: "absolute",
                  right: chromePx(86),
                  bottom: chromePx(19),
                  font: MONO_FONT,
                  fallback: MONO_FALLBACK,
                  fontSizePx: chromeFontPx(11),
                  color: chromeMuted,
                  wrap: "none",
                },
                resolveSafeModelLabel(project.modelLabel),
              ),
              // Mic, slightly smaller than the send button: a filled capsule
              // body plus the U-shaped holder, stem, and base as one stroked
              // path (no glyph coverage needed). It yields its spot to the
              // confirm control while a voice capture is live, the way real
              // voice UIs drop the mic icon during recording.
              Box(
                {
                  position: "absolute",
                  right: chromePx(48),
                  bottom: chromePx(13),
                  width: chromePx(26),
                  height: chromePx(26),
                  ...(micIdleAnimation ? { animate: micIdleAnimation } : {}),
                },
                Path({
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: chromePx(26),
                  height: chromePx(26),
                  d: `M${chromePx(10)} ${chromePx(6.5)} a${chromePx(3)} ${chromePx(3)} 0 0 1 ${chromePx(6)} 0 v${chromePx(5)} a${chromePx(3)} ${chromePx(3)} 0 0 1 ${-chromePx(6)} 0 Z`,
                  fill: "none",
                  stroke: chromeMuted,
                  strokeWidth: Math.max(0.5, chromePx(1.8)),
                  strokeLinejoin: "round",
                }),
                Path({
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: chromePx(26),
                  height: chromePx(26),
                  d: `M${chromePx(6.5)} ${chromePx(12)} v${chromePx(0.5)} a${chromePx(6.5)} ${chromePx(6.5)} 0 0 0 ${chromePx(13)} 0 v${-chromePx(0.5)} M${chromePx(13)} ${chromePx(19.2)} v${chromePx(2.3)} M${chromePx(9.5)} ${chromePx(21.7)} h${chromePx(7)}`,
                  fill: "none",
                  stroke: chromeMuted,
                  strokeWidth: Math.max(0.5, chromePx(1.8)),
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                }),
              ),
              // Confirm control in the mic's spot during a voice capture: a
              // check in a ring, the staged "end voice input" affordance. Its
              // fade is the exact inverse of the mic's.
              ...(confirmLiveAnimation
                ? [
                    Box(
                      {
                        position: "absolute",
                        right: chromePx(48),
                        bottom: chromePx(13),
                        width: chromePx(26),
                        height: chromePx(26),
                        animate: confirmLiveAnimation,
                      },
                      Box({
                        position: "absolute",
                        left: chromePx(2),
                        top: chromePx(2),
                        width: chromePx(22),
                        height: chromePx(22),
                        borderRadius: 999,
                        borderWidth: Math.max(0.5, chromePx(1.6)),
                        borderColor: palette.accent,
                      }),
                      Path({
                        position: "absolute",
                        left: 0,
                        top: 0,
                        width: chromePx(26),
                        height: chromePx(26),
                        d: `M${chromePx(8.5)} ${chromePx(13.4)} l${chromePx(3.1)} ${chromePx(3.1)} l${chromePx(6)} ${-chromePx(6.8)}`,
                        fill: "none",
                        stroke: palette.accent,
                        strokeWidth: Math.max(0.5, chromePx(1.8)),
                        strokeLinecap: "round",
                        strokeLinejoin: "round",
                      }),
                    ),
                  ]
                : []),
              Box(
                {
                  position: "absolute",
                  right: chromePx(12),
                  bottom: chromePx(10),
                  width: chromePx(32),
                  height: chromePx(32),
                  borderRadius: chromePx(11),
                  background: palette.accent,
                  ...(sendPulse ? { animate: sendPulse } : {}),
                },
                Text(
                  {
                    position: "absolute",
                    left: 0,
                    top: chromePx(6),
                    width: chromePx(32),
                    font: MONO_FONT,
                    fallback: MONO_FALLBACK,
                    fontSizePx: chromeFontPx(16),
                    color: accentInk(palette.accent),
                    textStrokes: [{ color: accentInk(palette.accent), widthPx: chromeScale }],
                    textAlign: "center",
                    wrap: "none",
                  },
                  "↑",
                ),
              ),
            ),
          ),
        ]
      : []),
  ];
}

/**
 * A message row for a report still, with a highlighted thinking row's note
 * laid out in flow beneath it. The wrapper carries the edit tag so measured
 * heights record the row-plus-note extent — the canvas has to grow by it, or
 * the notes push the transcript tail past the clip. The note itself stays
 * untagged so each message keeps exactly one block.
 */
function appMessageWithOpenNote(
  timing: SessionTimeline["messages"][number],
  env: SceneEnv,
  contentWidth: number,
): ReturnType<typeof appMessage> {
  const rendered = appMessage(timing, env, contentWidth);
  if (timing.message.role !== "thinking" || timing.message.highlight !== true) {
    return rendered;
  }
  const gapPx = spacePx(env.metrics, 8);
  const notePx = appHighlightNoteHeight(env, contentWidth, timing.message.content);
  return {
    ...rendered,
    node: Flex(
      { direction: "column", gap: gapPx, meta: { edit: timing.message.id } },
      rendered.node,
      appHighlightNoteBlock({ env, content: timing.message.content, width: contentWidth, notePx }),
    ),
    estimatedHeight: rendered.estimatedHeight + gapPx + notePx,
  };
}

function appCameraTypingTargets(options: {
  composerVisible: boolean;
  env: SceneEnv;
  userTimings: SessionTimeline["messages"];
  allTimings: SessionTimeline["messages"];
  draftPlans: AppDraftPlans;
  choicePanels: Array<{
    timing: SessionTimeline["messages"][number];
    panel: ReturnType<typeof appPickerComposerPanel> & {
      contentHeight: number;
      cutTop: number;
      clipped: boolean;
    };
  }>;
  cameraInkWidths: number[];
  chromePx: (px: number) => number;
  win: number;
  composerPadX: number;
  authoredHeight: number;
  composerBottom: number;
  composerBoxHeight: number;
  composerWidth: number;
  composerTextPx: number;
  composerLinePx: number;
}): Array<{
  startMs: number;
  target: { x: number; y: number; width: number; height: number };
  kind?: string;
}> {
  const {
    composerVisible,
    env,
    userTimings,
    allTimings,
    draftPlans,
    choicePanels,
    cameraInkWidths,
    chromePx,
    win,
    composerPadX,
    authoredHeight,
    composerBottom,
    composerBoxHeight,
    composerWidth,
    composerTextPx,
    composerLinePx,
  } = options;
  if (!composerVisible) {
    return [];
  }
  const composerX = win + composerPadX;
  const composerY = authoredHeight - composerBottom - composerBoxHeight;
  const draftShots = userTimings.map((timing) => {
    const plan = draftPlans.get(timing.message.id);
    const longestLine = (plan?.snapshots.flatMap((snapshot) => snapshot.lines) ?? []).reduce(
      (widest, line) =>
        Math.max(
          widest,
          measureLineWidthPx(env.engine, {
            text: line.text,
            font: SANS_FONT,
            fallback: SANS_FALLBACK,
            fontSizePx: composerTextPx,
            fontFeatureSettings: DRAFT_FONT_FEATURES,
            fallbackRatio: DRAFT_MEASURE_FALLBACK_RATIO,
          }),
        ),
      0,
    );
    const draftBoxWidth =
      longestLine > 0
        ? Math.min(composerWidth, longestLine + chromePx(CAMERA_DRAFT_PAD_PX))
        : composerWidth;
    const extraHeight = (plan?.maxExtraLines ?? 0) * composerLinePx;
    return {
      startMs: timing.startMs,
      target: {
        x: composerX,
        y: composerY - extraHeight,
        width: draftBoxWidth,
        height: composerBoxHeight + extraHeight,
      },
    };
  });
  const pickerShots = choicePanels.map(({ timing, panel }) => {
    const full =
      timing.message.role === "permission"
        ? { topOffset: 0, height: panel.contentHeight }
        : appChoiceOptionsRegion(timing.message, env);
    // The box is `height` tall and pinned by its bottom, with the card drawn
    // at -cutTop inside it, so the card's own top is boxTop - cutTop. Reading
    // contentHeight instead aims at where an unclamped card would have been.
    const boxTop = authoredHeight - composerBottom - panel.height;
    const panelTop = boxTop - panel.cutTop;
    // The clip takes the card's head and its tail, so the shot runs between
    // what survives: framing the cut part spends the frame on nothing.
    const regionTop = Math.max(full.topOffset, panel.cutTop);
    const regionBottom = Math.min(full.topOffset + full.height, panel.cutTop + panel.height);
    const region = { topOffset: regionTop, height: Math.max(1, regionBottom - regionTop) };
    const index = allTimings.indexOf(timing);
    return {
      startMs: timing.startMs,
      target: {
        x: composerX,
        y: panelTop + region.topOffset,
        width: Math.min(composerWidth, cameraInkWidths[index] ?? composerWidth),
        height: region.height,
      },
      kind: "picker",
    };
  });
  return [...draftShots, ...pickerShots].sort((left, right) => left.startMs - right.startMs);
}

/**
 * The header's own geometry, shared by the band that reserves the space and
 * the elements that paint into it — two statements of one fact drift.
 */
const APP_HEADER_ICONS_SIZE = 30;
const APP_HEADER_TITLE_TOP = 13;
const APP_HEADER_TITLE_FONT = 16;
const APP_HEADER_LINE2_TOP = 37;
const APP_HEADER_LINE2_FONT = 13;
/**
 * Space above and below whatever the band carries. Chosen so a header showing
 * everything keeps the height it has always had; anything less fills less.
 */
const APP_HEADER_PAD_Y = 11.5;
/** An empty band is still a band, sized as if it held the buttons. */
const APP_HEADER_MIN = 53;
/**
 * Header lines pin their own line box rather than inheriting whatever the
 * font's metrics give, so the band's height can be computed instead of
 * measured. Matches what the two faces were already rendering within a pixel.
 */
function appHeaderLinePx(fontPx: number): number {
  return fontPx + 4;
}

export function appScene(
  project: SvgentProject,
  {
    messages,
    pageIndex,
    pageCount,
    fullHeight,
    openNotes = false,
    engine,
    product,
    fallbackImage,
  }: {
    messages: SessionMessage[];
    pageIndex: number;
    pageCount: number;
    fullHeight: boolean;
    /** Render highlighted thinking notes open, in flow — for report stills. */
    openNotes?: boolean;
    engine?: Engine | undefined;
    product: SceneEnv["product"];
    fallbackImage?: SceneEnv["fallbackImage"];
  },
): { vnode: AnyVNode; durationMs: number } {
  const env: SceneEnv = {
    project,
    product,
    fallbackImage,
    palette: paletteFor(project),
    metrics: metricsFor(project),
    engine,
  };
  const { palette, metrics } = env;
  const { canvasWidth: width, canvasHeight: authoredHeight } = project.appearance;
  const timeline = buildTimeline(project, messages);
  // Chrome ink (clock, header actions, footer, composer controls) darkens
  // as the panel turns translucent so it stays readable over backdrops.
  const chromeMuted = chromeInk(env, palette.muted);
  const chromeBorder = chromeInk(env, palette.border);
  // The gap between the floating window and the canvas edge is authorable
  // (Window margin); 0 makes the window flush with the canvas.
  const win = Math.round(project.appearance.windowMargin);
  const winW = width - win * 2;
  // Chrome (header/footer/composer controls) follows its own scale so an
  // SNS-size transcript can keep the surrounding UI legible too. The scale
  // is capped so header + composer + footer always leave the transcript a
  // viewport: chrome cost is 196·s when the composer is chrome-bound, else
  // 126·s plus the fontScale-driven composer floor.
  const display = project.display;
  const headerVisible = display.header;
  // Exact chrome layout at a candidate scale. This is the single source of
  // truth for chrome geometry: the cap solver bisects it and the scene
  // below consumes the same numbers, so the old approximate linear cost
  // model (196·s etc.) is gone.
  const chromeAt = (scaleCandidate: number) => {
    const chromePx = (px: number): number => px * scaleCandidate;
    const fontAt = (base: number): number => Math.max(9, Math.round(base * scaleCandidate));
    // The band follows what it carries, and centres it. Each block declares
    // its own height; the taller one sets the band, and both sit in the
    // middle of it — so dropping the text leaves the buttons centred rather
    // than parked under the space two lines of type used to occupy.
    const headerTextHeight =
      chromePx(APP_HEADER_LINE2_TOP - APP_HEADER_TITLE_TOP) +
      appHeaderLinePx(fontAt(APP_HEADER_LINE2_FONT));
    const headerContentHeight = Math.max(
      display.headerIcons ? chromePx(APP_HEADER_ICONS_SIZE) : 0,
      display.headerText ? headerTextHeight : 0,
    );
    const headerHeight = Math.max(
      chromePx(APP_HEADER_MIN),
      headerContentHeight + chromePx(APP_HEADER_PAD_Y) * 2,
    );
    const headerIconsTop = (headerHeight - chromePx(APP_HEADER_ICONS_SIZE)) / 2;
    const headerTextTop = (headerHeight - headerTextHeight) / 2;
    const viewportTop = headerVisible ? win + headerHeight : win + 12;
    // The composer draft follows whichever is larger — transcript font or
    // chrome — so enlarged chrome never dwarfs the text being typed in it.
    const composerTextPx = Math.max(13, metrics.uiPx - 2, fontAt(14));
    // Proportional, not additive: Noto's natural line box is ~1.45em, so a
    // flat +10 undershoots past ~22px and the clip shaves glyph bottoms.
    const composerLinePx = Math.max(composerTextPx + 10, Math.round(composerTextPx * 1.5));
    // Two-band composer like real chat UIs: full-width text band on top,
    // control row below, so the draft can never collide with the buttons.
    const composerBoxHeight = Math.max(
      chromePx(70),
      metrics.uiPx * 2 + 30,
      chromePx(11) + composerLinePx + chromePx(50),
    );
    const composerBottom = win + (display.footer ? chromePx(34) : chromePx(14));
    const footerHeight = display.footer ? chromePx(28) : 0;
    return {
      viewportTop,
      headerHeight,
      headerIconsTop,
      headerTextTop,
      composerTextPx,
      composerLinePx,
      composerBoxHeight,
      composerBottom,
      footerHeight,
    };
  };
  // The same measurement the scene below makes, so the scale the solver
  // settles on is the scale that leaves the transcript the slot it is given.
  const viewportAt = (scaleCandidate: number): number => {
    const chrome = chromeAt(scaleCandidate);
    const reserve = appTranscriptBottomReserve({
      composer: display.composer,
      footer: display.footer,
      windowMargin: win,
      composerBottom: chrome.composerBottom,
      composerBoxHeight: chrome.composerBoxHeight,
      footerHeight: chrome.footerHeight,
    });
    return authoredHeight - chrome.viewportTop - reserve;
  };
  const chromeScale = fullHeight
    ? metrics.chromeScale
    : fitChromeScale({ requested: metrics.chromeScale, viewportAt });
  // Everything sized by the chrome — including stroke and border widths —
  // has to read the resolved scale, not the requested one. A scale the
  // canvas cannot fit is bisected down above, and a hairline left on the
  // original multiplier came out as a slab next to the shrunken shapes.
  const chromePx = (px: number): number => px * chromeScale;
  const chromeFontPx = (base: number): number => Math.max(9, Math.round(base * chromeScale));
  const {
    viewportTop,
    headerHeight,
    headerIconsTop,
    headerTextTop,
    composerTextPx,
    composerLinePx,
    composerBoxHeight,
    composerBottom,
    footerHeight,
  } = chromeAt(chromeScale);
  // The transcript's own insets, unlike the chrome's, follow the type. Both
  // axes come from here so the band stays centred in the window.
  const transcriptInsetLeft = spacePx(metrics, project.appearance.windowPaddingX);
  const transcriptInsetY = spacePx(metrics, project.appearance.windowPaddingY);
  const contentWidth = sizeLeft(winW, transcriptInsetLeft * 2);
  // The composer sits in the same column as the transcript, so it takes the
  // frame padding rather than a chrome constant of its own — otherwise the
  // one control named for the inside of the frame leaves the widest element
  // in it untouched.
  const composerPadX = spacePx(metrics, project.appearance.windowPaddingX);
  const composerWidth = sizeLeft(winW, composerPadX * 2);
  // Report stills open each highlighted note in flow: the note becomes real
  // laid-out content under its row, so the still shows what the replay's
  // beat holds. The animated path never takes this arm — there the note is
  // a timed overlay and the column lifts instead.
  const renderMessage = openNotes ? appMessageWithOpenNote : appMessage;
  const renderedMessages = timeline.messages.map((timing) =>
    renderMessage(timing, env, contentWidth),
  );
  const messageGap = spacePx(metrics, 14);
  // Real layout heights when an engine is available; estimates otherwise.
  const heightContextKey = `app|${winW}|composer:${display.composer}|${openNotes}|${JSON.stringify(metrics)}|${JSON.stringify(project.timing)}`;
  const measuredHeights = engine
    ? measureMessageHeights(engine, {
        nodes: renderedMessages.map((rendered) => rendered.node),
        ids: timeline.messages.map((timing) => timing.message.id),
        width: winW,
        cacheKeys: timeline.messages.map((timing) =>
          messageHeightCacheKey({ contextKey: heightContextKey, message: timing.message }),
        ),
      })
    : null;
  const messageHeights = renderedMessages.map((rendered, index) => {
    const timing = timeline.messages[index];
    // A collapsed choice's record declares its own line boxes; the engine's
    // tight glyph bbox under-reads them and the layout invariants compare
    // children against whichever height wins.
    if (
      timing &&
      (timing.message.role === "choice" || timing.message.role === "permission") &&
      choiceCollapses(timing.message, project)
    ) {
      return rendered.estimatedHeight;
    }
    return measuredHeights?.[index] ?? rendered.estimatedHeight;
  });
  // Gaps sit between messages, so there are one fewer of them than there are
  // messages. Counting one after the last made the final gap a bottom pad
  // that nothing declared and nothing could see.
  const flowContentHeight = messageHeights.reduce(
    (sum, height, index) => sum + height + (index > 0 ? messageGap : 0),
    0,
  );
  // What the transcript sits above, measured to that band rather than derived
  // from the window's outer margin. The margin is owed to the frame, and the
  // frame is not the transcript's neighbour here — the composer is, and it is
  // placed at `composerBottom` with a known height.
  const bottomReserve = appTranscriptBottomReserve({
    composer: display.composer,
    footer: display.footer,
    windowMargin: win,
    composerBottom,
    composerBoxHeight,
    footerHeight,
  });
  // Full-height posters skip the scroll viewport entirely: the canvas grows
  // until every message fits, so content that scrolled away in the animated
  // cut stays visible in the fixed export.
  const transcriptSlotHeight = fullHeight
    ? flowContentHeight + transcriptInsetY * 2
    : Math.max(40, authoredHeight - viewportTop - bottomReserve);
  const height = fullHeight
    ? Math.round(viewportTop + transcriptSlotHeight + bottomReserve)
    : authoredHeight;
  // The frame padding is a margin the transcript keeps on both of its own
  // edges, inside the slot. The slot already ends where the next band starts,
  // so this is the transcript's air and not a second reserve for the composer.
  const transcriptViewport = Math.max(40, transcriptSlotHeight - transcriptInsetY * 2);
  // Content shorter than its viewport leaves slack. "start" lets it hang at
  // the top, which is how a chat actually fills; "center" spends the slack
  // evenly, for a frame composed as artwork rather than replayed as a session.
  const contentOffsetY = contentAlignOffset({
    align: project.appearance.contentAlign,
    fullHeight,
    viewportHeight: transcriptViewport,
    insetTop: 0,
    contentHeight: flowContentHeight,
  });
  // Highlighted thinking rows: measure each note once. The replay is
  // append-only, so the note opens into empty column space; the beat only
  // has to lift the scrolled column when the viewport would clip it.
  const highlightBeats = planAppHighlights({
    project,
    timeline,
    heights: messageHeights,
    gap: messageGap,
    openNotes,
    noteHeights: collectHighlightNoteHeights(timeline, (content) =>
      appHighlightNoteHeight(env, contentWidth, content),
    ),
  });
  const scrollPlan = fullHeight
    ? undefined
    : planAutoFollowScroll({
        env,
        timings: timeline.messages,
        heights: messageHeights,
        gap: messageGap,
        leadingHeight: 0,
        viewportHeight: transcriptViewport,
        durationMs: timeline.durationMs,
        surface: "app",
      });
  const scrollThumb = fullHeight
    ? undefined
    : appScrollbarThumb({
        palette,
        plan: scrollPlan,
        viewportHeight: transcriptViewport,
        contentHeight: flowContentHeight,
        durationMs: timeline.durationMs,
      });
  // Composer planning is deliberately downstream of the permanent band
  // allocation. Transient growth borrows space through the stand-off; it is
  // not a static input to the transcript's height.
  const userTimings = composerDraftTimings(timeline, project);
  const draftWidth = sizeLeft(composerWidth, chromePx(42));
  const draftPlans = planAppDrafts({
    userTimings,
    wrap: {
      widthPx: draftWidth - 6,
      fontPx: composerTextPx,
      lineHeightPx: composerLinePx,
      font: SANS_FONT,
      fallback: SANS_FALLBACK,
      fallbackRatio: DRAFT_MEASURE_FALLBACK_RATIO,
      engine,
    },
  });
  // Collapsing choices live in the composer's frame while they are live;
  // the transcript keeps only their record. A scene without a composer has
  // nowhere to hold the transient picker and keeps the standing card.
  const collapsedChoiceTimings = timeline.messages.filter(
    (timing) =>
      (timing.message.role === "choice" || timing.message.role === "permission") &&
      choiceCollapses(timing.message, project),
  );
  /*
   * A picker grows upward out of the composer, so the window's inner top is
   * the only thing that can stop it. Clamping the height here rather than at
   * the paint keeps the camera and the stand-off reading the same panel the
   * viewer sees; a card taller than this loses its far rows, which is the
   * lesser harm next to painting over the header and off the canvas.
   */
  const pickerCeiling = Math.max(0, height - composerBottom - viewportTop);
  const choicePanels = collapsedChoiceTimings.map((timing) => {
    const panel = appPickerComposerPanel(timing, env, { width: composerWidth });
    const shown = Math.min(panel.height, pickerCeiling);
    return {
      timing,
      panel: {
        ...panel,
        height: shown,
        contentHeight: panel.height,
        cutTop: pickerCutTop(panel, shown),
        clipped: shown < panel.height,
      },
    };
  });
  const typingWindows = userTypingWindows(userTimings);
  // The idle caret and placeholder also step aside while a picker holds the
  // composer's frame — and again while the answer to that picker is typed.
  // The picker hands the keyboard back at its close, so the two windows meet
  // rather than overlap; without the second one the placeholder comes back
  // under the sentence being keyed and both print at once.
  const composerHoldWindows = [
    ...typingWindows,
    ...collapsedChoiceTimings.flatMap((timing) => {
      const closeMs = pickerCloseMs(timing, project);
      const answer = choiceDraftTiming(timing, project);
      return [
        { startMs: timing.startMs, endMs: closeMs, sendMs: closeMs },
        ...(answer === null
          ? []
          : [
              {
                startMs: answer.startMs,
                endMs: answer.settledMs,
                sendMs: sendMomentMs(answer),
              },
            ]),
      ];
    }),
  ].sort((a, b) => a.startMs - b.startMs);
  const composerIdle = composerIdleAnimation(composerHoldWindows, timeline.durationMs);
  const sendPulse = sendButtonAnimation(typingWindows, timeline.durationMs);
  const composerExpansionWindows = appComposerExpansionWindows({
    userTimings,
    draftPlans,
    collapsedChoiceTimings,
    project,
  });
  const composerBasePanel = composerBasePanelAnimation(
    composerExpansionWindows,
    timeline.durationMs,
  );
  const composerShove = planTranscriptStandoff({
    fullHeight,
    userTimings,
    allTimings: timeline.messages,
    draftPlans,
    pickerReleaseMs: (timing) => pickerCloseMs(timing, project),
    pickerPanels: choicePanels.map(({ timing, panel }) => ({
      timing,
      extraPx: Math.max(0, panel.height - composerBoxHeight),
    })),
    messageHeights,
    messageGap,
    contentOffsetY,
    scrollPlan,
    transcriptViewport,
    composerLinePx,
    // How far the grown panel reaches into the clip box, per extra line.
    clipBottom: viewportTop + transcriptInsetY + transcriptViewport,
    composerTop: authoredHeight - composerBottom - composerBoxHeight,
    durationMs: timeline.durationMs,
  });
  // Ink width per message: the camera frames how far the text actually
  // runs, not the reserved box (short status rows zoom close, a paragraph
  // that fills its bubble zooms gently).
  const cameraInkWidths =
    fullHeight || !project.camera.follow
      ? []
      : timeline.messages.map((timing) =>
          appMessageInkWidthPx(timing.message, env, {
            bandWidth: appMessageBand({
              message: timing.message,
              rowWidth: contentWidth,
              env,
              align: project.appearance.messageAlign,
            }).width,
            engine,
          }),
        );
  // In-message close-ups: the options block as a choice commits, and the
  // attached-image stack once its banners land. Content-space rects; the
  // plan applies the scroll offset.
  const cameraExtraShots = (): Array<{
    anchorMs: number;
    target: { x: number; y: number; width: number; height: number };
    kind: string;
  }> => {
    const shots: Array<{
      anchorMs: number;
      target: { x: number; y: number; width: number; height: number };
      kind: string;
    }> = [];
    let contentY = 0;
    timeline.messages.forEach((timing, index) => {
      const messageTop = viewportTop + transcriptInsetY + contentOffsetY + contentY;
      const height = messageHeights[index] ?? 0;
      contentY += height + messageGap;
      const band = appMessageBand({
        message: timing.message,
        rowWidth: contentWidth,
        env,
        align: project.appearance.messageAlign,
      });
      const bandX = win + transcriptInsetLeft + band.offsetX;
      if (timing.message.role === "choice") {
        if (choiceCollapses(timing.message, project)) {
          // The close-up rides the typing-target channel: the picker is the
          // composer's growth, and content space holds only the record.
          return;
        }
        const region = appChoiceOptionsRegion(timing.message, env);
        shots.push({
          // Mirrors the card's own commit moment (decideMs).
          anchorMs: timing.startMs + project.timing.permissionMs,
          target: {
            x: bandX,
            y: messageTop + region.topOffset,
            width: Math.min(band.width, cameraInkWidths[index] ?? band.width),
            height: region.height,
          },
          kind: "choice-options",
        });
        return;
      }
      const imagesRegion = appAttachedImagesRegion(timing.message, band.width);
      if (imagesRegion) {
        const anchorMs =
          (timing.message.role === "user" ? timing.revealEndMs : timing.startMs) +
          CAMERA_IMAGE_SHOT_DELAY_MS;
        shots.push({
          anchorMs,
          target: {
            x: bandX,
            y: messageTop + height - imagesRegion.height,
            width: band.width,
            height: imagesRegion.height,
          },
          kind: "images",
        });
      }
    });
    return shots;
  };
  const cameraTrack =
    fullHeight || !project.camera.follow
      ? null
      : planCameraTrack({
          timings: timeline.messages,
          heights: messageHeights,
          gap: messageGap,
          contentTop: viewportTop + transcriptInsetY + contentOffsetY,
          rowLeft: win + transcriptInsetLeft,
          messageBands: timeline.messages.map((timing) =>
            appMessageBand({
              message: timing.message,
              rowWidth: contentWidth,
              env,
              align: project.appearance.messageAlign,
            }),
          ),
          leadingHeight: 0,
          typingTargets: appCameraTypingTargets({
            composerVisible: display.composer,
            env,
            userTimings,
            allTimings: timeline.messages,
            draftPlans,
            choicePanels,
            cameraInkWidths,
            chromePx,
            win,
            composerPadX,
            authoredHeight,
            composerBottom,
            composerBoxHeight,
            composerWidth,
            composerTextPx,
            composerLinePx,
          }),
          extraShots: cameraExtraShots(),
          contentWidths: cameraInkWidths,
          scrollMoves: scrollPlan?.moves ?? [],
          canvasWidth: width,
          canvasHeight: authoredHeight,
          durationMs: timeline.durationMs,
          zoom: project.camera.zoom,
          style: project.camera.style,
          minShotMs: project.camera.minShotMs,
          // A collapsed choice's record is a two-line whisper: aiming at it
          // would normalise to a full-frame cut and bounce the zoom. The
          // picker aim rides the draft channel instead.
          omitMessageAim: (timing) =>
            (timing.message.role === "choice" || timing.message.role === "permission") &&
            choiceCollapses(timing.message, project),
        });
  // The camera transform rides one wrapping box around the whole window
  // (shadow, chrome, transcript); the backdrop stays put so the zoom
  // reads as leaning into the window, not scaling the wallpaper. The
  // meta marks the wrapper so the Studio can invert its transform when
  // hit-testing clicks (browsers hit-test as if the camera were off).
  const cameraLayer = (nodes: AnyVNode[]): AnyVNode[] =>
    cameraTrack
      ? [
          Box(
            {
              position: "absolute",
              left: 0,
              top: 0,
              width,
              height,
              animate: cameraTrack,
              meta: { camera: "window" },
            },
            ...nodes,
          ),
        ]
      : nodes;
  // Exact right-side reserve for the header text block: the clock sits at
  // right chromePx(136), so the title/subtitle can stretch to a chromePx(12) gap before
  // its measured width instead of a conservative flat chromePx(250).
  const clockText = sessionClockLabel(timeline.durationMs, project.chrome.clockTime);
  const clockWidthPx = measureLineWidthPx(engine, {
    text: clockText,
    font: MONO_FONT,
    fontSizePx: chromeFontPx(13),
    fallbackRatio: TUI_CHAR_RATIO,
  });
  const headerRightReserve = chromePx(136) + clockWidthPx + chromePx(12);
  return {
    durationMs: timeline.durationMs,
    vnode: Canvas(
      {
        width,
        height,
        ...(project.appearance.transparentCanvas ? {} : { background: palette.canvas }),
        language: "auto",
        meta: {
          product: "SVGENT",
          // Always true regardless of basis: the artifact is an authored
          // rendering, never a capture of a real screen.
          simulated: "true",
          disclosure: disclosureFor(project.basis),
          "model-kind": project.basis,
          surface: "app",
        },
      },
      ...backdropNodes(env, width, height),
      ...cameraLayer([
        ...windowShadowNodes(env, {
          left: win,
          top: win,
          width: winW,
          height: sizeLeft(height, win * 2),
          radius: 18,
        }),
        Box({
          position: "absolute",
          left: win,
          top: win,
          width: winW,
          height: sizeLeft(height, win * 2),
          borderRadius: 18,
          background: hexToRgba(palette.panel, project.appearance.terminalOpacity),
          borderWidth: 1,
          borderColor: palette.border,
        }),
        // Border only — the base window box supplies the translucent panel
        // fill, so the header stays as see-through as the rest of the window.
        ...(headerVisible
          ? [
              Box({
                position: "absolute",
                left: win,
                top: win,
                width: winW,
                height: headerHeight,
                borderRadius: [18, 18, 0, 0],
                borderWidth: 1,
                borderColor: palette.border,
              }),
            ]
          : []),
        ...(display.header && display.headerText
          ? [
              Text(
                {
                  position: "absolute",
                  left: win + chromePx(28),
                  top: win + headerTextTop,
                  width: Math.max(
                    40,
                    Math.min(chromePx(520), winW - chromePx(28) - headerRightReserve),
                  ),
                  font: SANS_FONT,
                  fallback: SANS_FALLBACK,
                  fontSizePx: chromeFontPx(APP_HEADER_TITLE_FONT),
                  lineHeightPx: appHeaderLinePx(chromeFontPx(APP_HEADER_TITLE_FONT)),
                  color: palette.text,
                  textStrokes: [{ color: palette.text, widthPx: 0.4 * chromeScale }],
                  wrap: "char",
                  maxLines: 1,
                  ellipsis: true,
                  meta: { edit: "field:title" },
                },
                project.title,
              ),
              Text(
                {
                  position: "absolute",
                  left: win + chromePx(28),
                  top: win + headerTextTop + chromePx(APP_HEADER_LINE2_TOP - APP_HEADER_TITLE_TOP),
                  width: Math.max(
                    40,
                    Math.min(chromePx(620), winW - chromePx(28) - headerRightReserve),
                  ),
                  font: MONO_FONT,
                  fallback: MONO_FALLBACK,
                  fontSizePx: chromeFontPx(APP_HEADER_LINE2_FONT),
                  lineHeightPx: appHeaderLinePx(chromeFontPx(APP_HEADER_LINE2_FONT)),
                  color: palette.muted,
                  wrap: "char",
                  maxLines: 1,
                  ellipsis: true,
                  meta: { edit: "field:workspace" },
                },
                [project.workspaceLabel.trim(), project.branchLabel.trim(), "● session active"]
                  .filter((part) => part.length > 0)
                  .join("  ·  "),
              ),
              ...(clockText.length > 0
                ? [
                    Text(
                      {
                        position: "absolute",
                        right: win + chromePx(136),
                        top: win + chromePx(20),
                        font: MONO_FONT,
                        fallback: MONO_FALLBACK,
                        fontSizePx: chromeFontPx(13),
                        color: chromeMuted,
                        wrap: "none",
                        meta: { edit: "field:clock" },
                      },
                      clockText,
                    ),
                  ]
                : []),
            ]
          : []),
        ...appHeaderNodes({
          env,
          chromeBorder,
          chromeMuted,
          chromePx,
          chromeScale,
          win,
          headerIconsTop,
        }),
        // No background of its own: the base window box already paints the
        // panel at the authored opacity, and stacking it twice would darken
        // the transcript band and break "Panel opacity" transparency.
        //
        // Both surfaces compose the same four bands — header, this transcript
        // viewport, composer, footer — and the other three are subtracted from
        // its height once. Message content belongs to the flow inside it, so a
        // window-anchored node that drew a message would be outside the budget
        // that the scroll plan, the camera and the height probe all share.
        Box(
          {
            position: "absolute",
            left: win,
            top: viewportTop + transcriptInsetY,
            width: winW,
            height: transcriptViewport,
            overflow: "clip",
            meta: { band: "transcript" },
          },
          // Two transforms, two jobs: the inner one is where the conversation
          // has scrolled to, the outer one is how far it stands off the grown
          // composer. Folding them together would make the scroll plan carry a
          // motion that is not scrolling. Most scripts never grow the composer,
          // and a layer that would only ever hold an identity transform is not
          // worth putting in every export.
          ...standoffLayer(
            composerShove,
            { width: winW, height: transcriptViewport, preclip: true },
            [
              // A third motion, same rule as the two above: while a note is
              // open the whole scrolled column rises just far enough to keep it
              // clear of the viewport clip, and settles back on close.
              ...standoffLayer(
                planBeatLift({
                  beats: highlightBeats,
                  contentOffsetY,
                  scrollOffsets: scrollPlan,
                  viewportPx: transcriptViewport,
                  durationMs: timeline.durationMs,
                }),
                { width: winW, height: transcriptViewport },
                [
                  Flex(
                    {
                      position: "absolute",
                      left: transcriptInsetLeft,
                      top: contentOffsetY,
                      width: contentWidth,
                      direction: "column",
                      gap: messageGap,
                      ...(scrollPlan ? { animate: scrollPlan.track } : {}),
                    },
                    ...renderedMessages.map((rendered) => rendered.node),
                    // Opened notes draw once at their opened place — below the
                    // last landed row, in empty column space — and fade in;
                    // they never scale, so their text never distorts.
                    ...highlightBeats.map((beat) =>
                      appHighlightNote({
                        env,
                        content: timeline.messages[beat.index]?.message.content ?? "",
                        editId: timeline.messages[beat.index]?.message.id ?? "",
                        width: contentWidth,
                        topPx: beat.noteTopPx,
                        notePx: beat.notePx,
                        window: beat.window,
                        durationMs: timeline.durationMs,
                      }),
                    ),
                  ),
                ],
              ),
            ],
          ),
          ...(scrollThumb ? [scrollThumb] : []),
        ),
        ...appComposerNodes({
          choicePanels,
          env,
          timeline,
          userTimings,
          draftPlans,
          composerIdle,
          sendPulse,
          composerBasePanel,
          chromeBorder,
          chromeMuted,
          chromePx,
          chromeFontPx,
          chromeScale,
          win,
          composerWidth,
          composerPadX,
          composerBottom,
          composerBoxHeight,
          composerLinePx,
          composerTextPx,
          draftWidth,
        }),
        ...appFooterNodes({
          env,
          pageIndex,
          pageCount,
          composerPadX,
          chromeMuted,
          chromePx,
          chromeFontPx,
          win,
          composerWidth,
        }),
      ]),
    ),
  };
}
