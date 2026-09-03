import {
  type AnimationSpec,
  type AnyVNode,
  Box,
  Canvas,
  type Engine,
  Flex,
  Text,
} from "@boundsvg/core";
import { tuiPop } from "./animations.js";
import { backdropNodes, windowShadowNodes } from "./backdrop.js";
import { planCameraTrack } from "./camera.js";
import {
  composerBasePanelAnimation,
  composerIdleAnimation,
  planComposerShove,
  sendMomentMs,
  userTypingWindows,
} from "./composer.js";
import { DRAFT_FONT_FEATURES } from "./draft-layout.js";
import {
  chromeInk,
  hexToRgba,
  MONO_FALLBACK,
  MONO_FONT,
  metricsFor,
  paletteFor,
  type SceneEnv,
  type ScenePalette,
  sessionClockLabel,
  sizeLeft,
  spacePx,
  TUI_CHAR_RATIO,
  TUI_FRAME_STROKE_PX,
  TUI_LINE_RATIO,
} from "./env.js";
import {
  contentAlignOffset,
  fitChromeScale,
  measureLineWidthPx,
  measureMessageHeights,
  messageHeightCacheKey,
} from "./measure.js";
import {
  choiceCollapses,
  pickerCloseMs,
  pickerCutTop,
  tuiMessage,
  tuiMessageInkWidthPx,
  tuiPickerPanel,
} from "./messages.js";
import {
  disclosureFor,
  resolveSafeModelLabel,
  type SessionMessage,
  type SvgentProject,
} from "./model.js";
import { planAutoFollowScroll } from "./scroll.js";
import {
  buildTimeline,
  composerDraftTimings,
  type MessageTiming,
  type SessionTimeline,
} from "./timeline.js";
import {
  planTuiDraftGrowth,
  TUI_CHROME_SETTLE_MS,
  type TuiDraftGrowth,
  tuiComposerNodes,
} from "./tui-composer.js";

/** Diameter of the traffic-light dots. */
const TUI_HEADER_DOTS_SIZE = 10;
/**
 * Space above and below whatever the title bar carries. Chosen so a bar
 * showing everything keeps the height it has always had; anything less fills
 * less. Both blocks are centred, so the title still lines up with the dots
 * without either side stating that alignment twice.
 */
const TUI_HEADER_PAD_Y = 16.5;
/** An empty bar is still a bar, sized as if it held the dots. */
const TUI_HEADER_MIN = 29;

/** Bottom edge of the permanent grid slot, expressed as a canvas reserve. */
function tuiTranscriptBottomReserve(options: {
  composer: boolean;
  inset: number;
  footerHeight: number;
  composerHeight: number;
  composerTopAdjustment: number;
}): number {
  const { composer, inset, footerHeight, composerHeight, composerTopAdjustment } = options;
  return inset + footerHeight + (composer ? composerHeight - composerTopAdjustment : 0);
}

function tuiTranscriptGeometry(options: {
  fullHeight: boolean;
  flowContentHeight: number;
  gridPadY: number;
  authoredHeight: number;
  viewportTop: number;
  bottomReserve: number;
}): { transcriptSlotHeight: number; height: number } {
  const { fullHeight, flowContentHeight, gridPadY, authoredHeight, viewportTop, bottomReserve } =
    options;
  if (!fullHeight) {
    return {
      transcriptSlotHeight: Math.max(40, authoredHeight - viewportTop - bottomReserve),
      height: authoredHeight,
    };
  }
  const transcriptSlotHeight = flowContentHeight + gridPadY * 2;
  return {
    transcriptSlotHeight,
    height: Math.round(viewportTop + transcriptSlotHeight + bottomReserve),
  };
}

/**
 * The status bar under the prompt — the last of the four window bands, and
 * the only content the terminal window carries that is not a transcript row.
 */
function tuiStatusBarNodes(layout: {
  env: SceneEnv;
  pageIndex: number;
  pageCount: number;
  chromeMuted: string;
  chromePx: (px: number) => number;
  chromeFontPx: (base: number) => number;
  width: number;
  inset: number;
}): AnyVNode[] {
  const { env, pageIndex, pageCount, chromeMuted, chromePx, chromeFontPx, width, inset } = layout;
  const { project } = env;
  const display = project.display;
  return [
    ...(display.footer
      ? [
          Text(
            {
              position: "absolute",
              left: inset + chromePx(20),
              bottom: inset + chromePx(7),
              width: Math.max(40, width - inset * 2 - chromePx(40)),
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx: chromeFontPx(13),
              color: chromeMuted,
              wrap: "none",
              fit: "shrink",
              minFontSizePx: 8,
              meta: { edit: "field:footer" },
            },
            [
              resolveSafeModelLabel(project.modelLabel),
              display.productMark
                ? display.productVersion && env.product.version.length > 0
                  ? `${env.product.name} v${env.product.version}`
                  : env.product.name
                : "",
              pageCount > 1 ? `${pageIndex + 1}/${pageCount}` : "",
            ]
              .filter((part) => part.length > 0)
              .join("  ·  "),
          ),
        ]
      : []),
  ];
}

/** Title bar: the traffic lights, the session title, and the rule beneath them. */
function tuiHeaderNodes(layout: {
  env: SceneEnv;
  timeline: SessionTimeline;
  readablePalette: ScenePalette;
  chromePx: (px: number) => number;
  chromeFontPx: (base: number) => number;
  width: number;
  height: number;
  inset: number;
  viewportTop: number;
  /** Where the dots and the title sit so the bar holds them in its middle. */
  headerDotsTop: number;
  headerTitleTop: number;
  columns: number;
  rows: number;
}): AnyVNode[] {
  const {
    env,
    timeline,
    readablePalette,
    chromePx,
    chromeFontPx,
    width,
    inset,
    viewportTop,
    headerDotsTop,
    headerTitleTop,
    columns,
    rows,
  } = layout;
  const { project, palette } = env;
  const display = project.display;
  const headerVisible = display.header;
  return [
    ...(display.header && display.headerIcons
      ? ["#f37b83", "#f0b35a", "#64d79f"].map((color, index) =>
          Box({
            position: "absolute",
            left: inset + chromePx(18) + index * chromePx(20),
            top: inset + headerDotsTop,
            width: chromePx(TUI_HEADER_DOTS_SIZE),
            height: chromePx(TUI_HEADER_DOTS_SIZE),
            borderRadius: chromePx(TUI_HEADER_DOTS_SIZE / 2),
            background: color,
          }),
        )
      : []),
    ...(display.header && display.headerText
      ? [
          (() => {
            // Vertically center the title against the traffic-light dots
            // (dots: top inset+chromePx(19), size chromePx(10) → center at inset+chromePx(24)).
            const titleFontPx = chromeFontPx(13);
            const titleLinePx = titleFontPx + 8;
            return Text(
              {
                position: "absolute",
                left: inset + chromePx(92),
                top: inset + headerTitleTop,
                // Runs from left inset+chromePx(92) to a chromePx(12) gap before the
                // right inset — exact, nothing else occupies that edge.
                width: Math.max(40, width - inset * 2 - chromePx(104)),
                font: MONO_FONT,
                fallback: MONO_FALLBACK,
                fontSizePx: titleFontPx,
                lineHeightPx: titleLinePx,
                color: readablePalette.muted,
                wrap: "none",
                // With the session title and clock enabled the bar can
                // outgrow its width; shrink rather than clip.
                fit: "shrink",
                minFontSizePx: 8,
                meta: { edit: "field:workspace" },
              },
              [
                // The product mark belongs to the status bar, once. A terminal
                // that printed its program name in the window title and again
                // on the status line would be saying it twice, and one pair of
                // toggles could not have turned off either half on its own.
                display.tuiTitle ? project.title.trim() : "",
                project.workspaceLabel.trim(),
                display.tuiGeometry ? `${columns}×${rows}` : "",
                display.tuiClock
                  ? sessionClockLabel(timeline.durationMs, project.chrome.clockTime)
                  : "",
              ]
                .filter((part) => part.length > 0)
                .join(" — "),
            );
          })(),
        ]
      : []),
    ...(headerVisible
      ? [
          Box({
            position: "absolute",
            left: inset,
            top: viewportTop - 1,
            width: sizeLeft(width, inset * 2),
            height: 1,
            background: palette.border,
          }),
        ]
      : []),
  ];
}

/** The prompt row: frame, mode hint, typed draft, cursor, and status line. */
/**
 * The terminal's deterministic camera track: the same planned
 * camera as the app — svgent stages a simulation demo, not a faithful
 * terminal — with mono row ink and the prompt draft as targets.
 */
function tuiCameraTrack(options: {
  fullHeight: boolean;
  env: SceneEnv;
  timeline: SessionTimeline;
  messageHeights: number[];
  messageGap: number;
  viewportTop: number;
  /** Slack spent above the rows when contentAlign centres them. */
  contentOffsetY: number;
  contentWidth: number;
  inset: number;
  bannerHeight: number;
  chromePx: (px: number) => number;
  promptFontPx: number;
  promptLeft: number;
  composerTop: number;
  composerBaseHeight: number;
  pickerBottomY: number;
  promptLinePx: number;
  composerGrowth: TuiDraftGrowth;
  width: number;
  authoredHeight: number;
  scrollMoves: readonly { startMs: number; toY: number }[];
  /** Collapsing choices' live pickers in the composer-owned window space. */
  choicePanels: Array<{
    timing: SessionTimeline["messages"][number];
    panel: ReturnType<typeof tuiPickerPanel> & {
      contentHeight: number;
      cutTop: number;
      clipped: boolean;
    };
  }>;
  gridPadX: number;
  gridPadY: number;
}): AnimationSpec | null {
  const {
    env,
    timeline,
    messageHeights,
    messageGap,
    viewportTop,
    contentOffsetY,
    contentWidth,
    inset,
    bannerHeight,
    chromePx,
    promptFontPx,
    promptLeft,
    composerTop,
    composerBaseHeight,
    pickerBottomY,
    promptLinePx,
    composerGrowth,
    width,
    authoredHeight,
    scrollMoves,
    choicePanels,
    gridPadX,
    gridPadY,
  } = options;
  const { project, engine } = env;
  if (options.fullHeight || !project.camera.follow) {
    return null;
  }
  const typingTargets = (): Array<{
    startMs: number;
    target: { x: number; y: number; width: number; height: number };
  }> => {
    if (!project.display.composer) {
      return [];
    }
    return composerDraftTimings(timeline, env.project).map((timing) => {
      const growth = composerGrowth.get(timing.message.id);
      const longestLine = (growth?.snapshots.flatMap((snapshot) => snapshot.lines) ?? []).reduce(
        (widest, line) =>
          Math.max(
            widest,
            measureLineWidthPx(engine, {
              text: line.text,
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx: promptFontPx,
              fontFeatureSettings: DRAFT_FONT_FEATURES,
              fallbackRatio: TUI_CHAR_RATIO,
            }),
          ),
        0,
      );
      const extraHeight = (growth?.maxExtraLines ?? 0) * promptLinePx;
      return {
        startMs: timing.startMs,
        target: {
          x: inset + chromePx(18),
          y: composerTop - extraHeight,
          width: Math.min(contentWidth, promptLeft + longestLine + chromePx(40)),
          height: composerBaseHeight + extraHeight,
        },
      };
    });
  };
  return planCameraTrack({
    timings: timeline.messages,
    heights: messageHeights,
    gap: messageGap,
    // The inner padding the band actually keeps — the authored frame padding,
    // not a constant that happened to match its default. At `windowPaddingY:
    // 80` the two are 68px apart, and the camera aimed that far above the row
    // it was following, magnified by whatever zoom the shot was taking.
    contentTop: viewportTop + gridPadY + contentOffsetY,
    rowLeft: inset + spacePx(env.metrics, 20),
    messageBands: timeline.messages.map(() => ({ offsetX: 0, width: contentWidth })),
    leadingHeight: bannerHeight,
    typingTargets: [
      ...typingTargets(),
      // The live picker grows from the prompt's bottom edge. The camera reads
      // that same anchor instead of the old transcript-foot placement.
      ...choicePanels.map(({ timing, panel }) => {
        // The box is `height` tall and pinned by its bottom, with the card at
        // -cutTop inside it, so the card's own top is boxTop - cutTop.
        const panelTop = pickerBottomY - panel.height - panel.cutTop;
        // The shot runs between what survives the clip at both ends.
        const rowsTop = Math.max(panel.rowsTop, panel.cutTop);
        const rowsBottom = Math.min(panel.rowsTop + panel.rowsHeight, panel.cutTop + panel.height);
        const rowsHeight = Math.max(1, rowsBottom - rowsTop);
        return {
          startMs: timing.startMs,
          target: {
            x: inset + gridPadX,
            y: panelTop + rowsTop,
            width: Math.min(
              contentWidth,
              tuiMessageInkWidthPx(timing.message, env, { bandWidth: contentWidth, engine }),
            ),
            height: rowsHeight,
          },
          kind: "picker",
        };
      }),
    ],
    extraShots: [],
    contentWidths: timeline.messages.map((timing) =>
      tuiMessageInkWidthPx(timing.message, env, { bandWidth: contentWidth, engine }),
    ),
    scrollMoves,
    canvasWidth: width,
    canvasHeight: authoredHeight,
    durationMs: timeline.durationMs,
    zoom: project.camera.zoom,
    style: project.camera.style,
    minShotMs: project.camera.minShotMs,
    // A collapsed choice's two-line record must not draw an aim of its
    // own — a target that small normalises to a full-frame cut.
    omitMessageAim: (timing) =>
      (timing.message.role === "choice" || timing.message.role === "permission") &&
      choiceCollapses(timing.message, env.project),
  });
}

/**
 * The collapsing choices' live pickers and the whole-row stand-off that
 * hands the band's last rows to them, then takes the rows back.
 */
function planTuiChoicePanels(options: {
  env: SceneEnv;
  timeline: SessionTimeline;
  fullHeight: boolean;
  contentWidth: number;
  messageHeights: number[];
  messageGap: number;
  bannerHeight: number;
  contentOffsetY: number;
  scrollPlan: ReturnType<typeof planAutoFollowScroll> | undefined;
  transcriptViewport: number;
  clipBottom: number;
  composerTop: number;
  pickerBottomY: number;
  /** The window's inner top — the ceiling a growing picker may not pass. */
  viewportTop: number;
  composerGrowth: TuiDraftGrowth;
  /**
   * The timings the growth was planned from. A freeform answer is typed on a
   * synthetic user timing, so its send moment is not the choice's own — taking
   * the release from the choice leaves the rows shoved after the box is gone.
   */
  draftTimings: MessageTiming[];
  promptLinePx: number;
}): {
  choicePanels: Array<{
    timing: SessionTimeline["messages"][number];
    panel: ReturnType<typeof tuiPickerPanel> & {
      contentHeight: number;
      cutTop: number;
      clipped: boolean;
    };
  }>;
  composerShove: AnimationSpec | null;
} {
  const {
    env,
    timeline,
    fullHeight,
    contentWidth,
    messageHeights,
    messageGap,
    bannerHeight,
    contentOffsetY,
    scrollPlan,
    transcriptViewport,
    clipBottom,
    composerTop,
    pickerBottomY,
    composerGrowth,
    draftTimings,
    promptLinePx,
    viewportTop,
  } = options;
  const collapsed =
    fullHeight || !env.project.display.composer
      ? []
      : timeline.messages.filter(
          (timing) =>
            (timing.message.role === "choice" || timing.message.role === "permission") &&
            choiceCollapses(timing.message, env.project),
        );
  /*
   * A picker grows upward out of the prompt, so the window's inner top is the
   * only thing that can stop it. Clamped here rather than at the paint so the
   * camera and the row shove read the same panel the viewer sees; a selector
   * taller than this loses its far rows, which is the lesser harm next to
   * printing over the title bar and past the canvas edge.
   */
  const pickerCeiling = Math.max(0, pickerBottomY - viewportTop);
  const choicePanels = collapsed.map((timing) => {
    const panel = tuiPickerPanel(timing, env, {
      width: contentWidth,
      durationMs: timeline.durationMs,
    });
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
  const composerDrafts = draftTimings.flatMap((timing) => {
    const steps = composerGrowth.get(timing.message.id)?.steps ?? [];
    return steps.length === 0 ? [] : [{ timing, steps }];
  });
  if (fullHeight || !env.project.display.composer) {
    return { choicePanels, composerShove: null };
  }
  const intrusionFrom = (surfaceTop: number): number => Math.max(0, clipBottom - surfaceTop);
  const rowShove = (visibleBottom: number, intrusion: number): number => {
    const required = Math.max(
      0,
      // Never more than the viewport itself: a surface that reaches past the
      // whole band would otherwise shove every row out of it and leave the
      // transcript empty, which reads as a bug rather than as room made.
      Math.min(intrusion, transcriptViewport, visibleBottom - (transcriptViewport - intrusion)),
    );
    return Math.ceil(required / env.metrics.tuiLinePx) * env.metrics.tuiLinePx;
  };
  const visibleBottomBefore = (index: number): number => {
    const printed = messageHeights
      .slice(0, index)
      .reduce(
        (sum, blockHeight, priorIndex) =>
          sum + blockHeight + (priorIndex > 0 || bannerHeight > 0 ? messageGap : 0),
        bannerHeight + contentOffsetY,
      );
    return printed - (scrollPlan?.offsets[index] ?? 0);
  };
  const composerShove = planComposerShove({
    durationMs: timeline.durationMs,
    settleMs: TUI_CHROME_SETTLE_MS,
    drafts: [
      ...choicePanels.map(({ timing, panel }) => {
        const index = timeline.messages.indexOf(timing);
        const visibleBottom = visibleBottomBefore(index);
        const pickerTop = pickerBottomY - panel.height;
        const intrusion = intrusionFrom(pickerTop);
        return {
          // The rows come back when the panel closes, which for an answer
          // typed at the prompt is well before the message's own tail.
          releaseMs: pickerCloseMs(timing, env.project, timing.revealEndMs - 80),
          stages: [{ atMs: timing.startMs, shovePx: rowShove(visibleBottom, intrusion) }],
        };
      }),
      // A grown prompt box claims rows the same way a picker does: the box is
      // chrome, so the conversation steps off the rows it takes rather than
      // disappearing under it.
      ...composerDrafts.map(({ timing, steps }) => {
        // The rows it claims are the ones under its own block, which for a
        // freeform answer is the choice it was typed at.
        const index = timeline.messages.findIndex(
          (printed) => printed.message.id === timing.message.id,
        );
        const visibleBottom = visibleBottomBefore(index);
        return {
          releaseMs: sendMomentMs(timing),
          stages: steps.map((step: { atMs: number; extraLines: number }) => {
            const grownTop = composerTop - step.extraLines * promptLinePx;
            const intrusion = intrusionFrom(grownTop);
            return {
              atMs: step.atMs,
              shovePx: rowShove(visibleBottom, intrusion),
            };
          }),
        };
      }),
    ],
  });
  return { choicePanels, composerShove };
}

export function tuiScene(
  project: SvgentProject,
  {
    messages,
    pageIndex,
    pageCount,
    fullHeight,
    engine,
    product,
    fallbackImage,
  }: {
    messages: SessionMessage[];
    pageIndex: number;
    pageCount: number;
    fullHeight: boolean;
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
  const readablePalette = {
    ...palette,
    accent: chromeInk(env, palette.accent),
    muted: chromeInk(env, palette.muted),
    faint: chromeInk(env, palette.faint),
  };
  const readableEnv: SceneEnv = { ...env, palette: readablePalette };
  const { canvasWidth: width, canvasHeight: authoredHeight } = project.appearance;
  const timeline = buildTimeline(project, messages);
  const chromeMuted = readablePalette.muted;
  // Authorable gap between the terminal and the canvas edge (Window margin).
  const inset = Math.round(project.appearance.windowMargin);
  // Chrome (title bar, composer frame, status bars) follows its own scale so
  // an SNS-size transcript keeps the terminal dressing legible too. Capped so
  // title bar + composer + status bar always leave the grid a viewport:
  // chrome cost is 178·s when the composer is chrome-bound, else 158·s plus
  // the prompt line height.
  const display = project.display;
  const headerVisible = display.header;
  // Exact chrome layout at a candidate scale — same single-source pattern
  // as the app scene; the approximate 178·s cost model is gone.
  const chromeAt = (scaleCandidate: number) => {
    const chromePx = (px: number): number => px * scaleCandidate;
    const fontAt = (base: number): number => Math.max(9, Math.round(base * scaleCandidate));
    // The prompt line follows whichever is larger — the terminal grid or
    // the chrome — so enlarged chrome never dwarfs the typed text.
    const promptFontPx = Math.max(metrics.tuiFontPx, fontAt(13));
    const promptLinePx = Math.round(promptFontPx * TUI_LINE_RATIO);
    // The band follows what it carries, and centres it. The taller of the
    // dots and the title line sets the height; both then sit in the middle,
    // so a title bar showing only dots is not as tall as one carrying text
    // and does not park the dots under the room that text would have used.
    const titleLineHeight = Math.max(9, Math.round(13 * scaleCandidate)) + 8;
    const headerContentHeight = Math.max(
      display.headerIcons ? chromePx(TUI_HEADER_DOTS_SIZE) : 0,
      display.headerText ? titleLineHeight : 0,
    );
    const headerHeight = headerVisible
      ? Math.max(chromePx(TUI_HEADER_MIN), headerContentHeight + chromePx(TUI_HEADER_PAD_Y) * 2)
      : chromePx(10);
    const headerDotsTop = (headerHeight - chromePx(TUI_HEADER_DOTS_SIZE)) / 2;
    const headerTitleTop = (headerHeight - titleLineHeight) / 2;
    const composerHeight = display.composer
      ? Math.max(chromePx(96), promptLinePx + chromePx(76))
      : chromePx(10);
    const footerHeight = display.footer ? chromePx(28) : 0;
    return {
      promptFontPx,
      promptLinePx,
      headerHeight,
      headerDotsTop,
      headerTitleTop,
      composerHeight,
      footerHeight,
    };
  };
  const viewportAt = (scaleCandidate: number): number => {
    const chrome = chromeAt(scaleCandidate);
    const chromePx = (px: number): number => px * scaleCandidate;
    const viewportTop = inset + chrome.headerHeight;
    const bottomReserve = tuiTranscriptBottomReserve({
      composer: display.composer,
      inset,
      footerHeight: chrome.footerHeight,
      composerHeight: chrome.composerHeight,
      composerTopAdjustment: chromePx(12),
    });
    return authoredHeight - viewportTop - bottomReserve;
  };
  const chromeScale = fullHeight
    ? metrics.chromeScale
    : fitChromeScale({ requested: metrics.chromeScale, viewportAt });
  const chromePx = (px: number): number => px * chromeScale;
  const chromeFontPx = (base: number): number => Math.max(9, Math.round(base * chromeScale));
  const {
    promptFontPx,
    promptLinePx,
    headerHeight,
    headerDotsTop,
    headerTitleTop,
    composerHeight,
    footerHeight,
  } = chromeAt(chromeScale);
  const promptCharPx = promptFontPx * TUI_CHAR_RATIO;
  const viewportTop = inset + headerHeight;
  // Distance from the terminal border to the first column, following the cell
  // size so a large grid is not pressed against its own frame.
  const gridPadX = spacePx(metrics, project.appearance.windowPaddingX);
  const gridPadY = spacePx(metrics, project.appearance.windowPaddingY);
  const contentWidth = sizeLeft(width, inset * 2, gridPadX * 2);
  const renderedMessages = timeline.messages.map((timing) =>
    tuiMessage(timing, readableEnv, contentWidth),
  );
  // Blocks are separated by blank lines, not by pixels: a terminal has no
  // other unit for vertical space. The authored spacing still moves it, in
  // whole rows, so a tight script prints its blocks back to back the way
  // consecutive output does.
  const messageGap = Math.round(spacePx(metrics, 12) / metrics.tuiLinePx) * metrics.tuiLinePx;
  const heightContextKey = `tui|${contentWidth}|composer:${display.composer}|${JSON.stringify(metrics)}|${JSON.stringify(project.timing)}`;
  const measuredHeights = engine
    ? measureMessageHeights(engine, {
        nodes: renderedMessages.map((rendered) => rendered.node),
        ids: timeline.messages.map((timing) => timing.message.id),
        width: contentWidth,
        cacheKeys: timeline.messages.map((timing) =>
          messageHeightCacheKey({ contextKey: heightContextKey, message: timing.message }),
        ),
      })
    : null;
  // Every block occupies whole rows. A block builder is free to size itself
  // from its own content, but the column stacks it on the lattice: a terminal
  // that ends a block 4px into a row has nowhere to start the next one, and
  // the leftovers accumulate until the viewport edge cuts a line of text
  // through the middle. Both the layout below and the scroll plan read these,
  // so the rows they each believe in are the same rows.
  const messageHeights = renderedMessages.map((rendered, index) =>
    Math.max(
      metrics.tuiLinePx,
      Math.ceil((measuredHeights?.[index] ?? rendered.estimatedHeight) / metrics.tuiLinePx) *
        metrics.tuiLinePx,
    ),
  );
  const bannerHeight = pageIndex === 0 ? metrics.tuiLinePx : 0;
  // Full-height posters skip the scroll viewport entirely: the terminal
  // grows until every line fits, so scrolled-away rows stay visible.
  // Gaps sit between elements. The banner is one of them when it is drawn, so
  // it takes a gap after it and the last message takes none — a trailing gap
  // was a bottom pad nothing declared.
  const flowContentHeight = messageHeights.reduce(
    (sum, height, index) => sum + height + (index > 0 || bannerHeight > 0 ? messageGap : 0),
    bannerHeight,
  );
  // What the transcript sits above: the prompt panel's own top, which the
  // composer places at `inset + footerHeight + chromePx(10)` from the bottom
  // with a height of `composerHeight - chromePx(22)`. Deriving the slot from
  // the window's margins instead left a reserve nothing occupied.
  const bottomReserve = tuiTranscriptBottomReserve({
    composer: display.composer,
    inset,
    footerHeight,
    composerHeight,
    composerTopAdjustment: chromePx(12),
  });
  const { transcriptSlotHeight, height } = tuiTranscriptGeometry({
    fullHeight,
    flowContentHeight,
    gridPadY,
    authoredHeight,
    viewportTop,
    bottomReserve,
  });
  // Same slack rule as the app surface: a terminal fills from the top, so
  // centring is opt-in and only applies while the content still fits.
  // A terminal viewport is a whole number of rows. Left unquantized, the row
  // at the bottom edge is drawn cut through its own glyphs, which no terminal
  // can do; the remainder is spent as margin instead.
  const transcriptViewport = Math.max(
    metrics.tuiLinePx,
    Math.floor((transcriptSlotHeight - gridPadY * 2) / metrics.tuiLinePx) * metrics.tuiLinePx,
  );
  // Surface divergence, on purpose: the app centres short content when the
  // author asks (a chat window composed as artwork), but a terminal fills
  // from the top — centring would float the product banner into the middle
  // of an empty grid, a picture no terminal produces. The setting stays an
  // app-surface composition control.
  const contentOffsetY = contentAlignOffset({
    align: "start",
    fullHeight,
    viewportHeight: transcriptViewport,
    insetTop: 0,
    contentHeight: flowContentHeight,
  });
  const scrollPlan = fullHeight
    ? undefined
    : planAutoFollowScroll({
        env,
        timings: timeline.messages,
        heights: messageHeights,
        gap: messageGap,
        leadingHeight: bannerHeight,
        viewportHeight: transcriptViewport,
        durationMs: timeline.durationMs,
        surface: "tui",
      });
  const terminalBackground = hexToRgba(palette.panelSoft, project.appearance.terminalOpacity);
  const columns = Math.floor(contentWidth / metrics.tuiCharPx);
  // The rows the transcript actually has, not the slot it was cut from: the
  // status line reports what a reader can see.
  const rows = Math.floor(transcriptViewport / metrics.tuiLinePx);
  const promptBottomInset = inset + footerHeight + chromePx(10);
  const pickerBottomY = height - promptBottomInset;
  const composerBaseHeight = sizeLeft(composerHeight, chromePx(22));
  const composerTop = pickerBottomY - composerBaseHeight;
  const clipBottom = viewportTop + gridPadY + transcriptViewport;
  // Transient prompt growth is planned after the permanent row allocation:
  // it borrows rows through the stand-off instead of shrinking every frame to
  // its maximum possible envelope.
  const userTimings = composerDraftTimings(timeline, project);
  const draftWidth = sizeLeft(width, inset * 2, chromePx(36), chromePx(28), promptCharPx * 2);
  const composerGrowth = planTuiDraftGrowth({
    env,
    userTimings,
    draftWidth,
    promptFontPx,
    promptLinePx,
  });
  // A collapsing choice replaces the prompt and grows upward from the same
  // bottom edge. The transcript moves only by the rows that surface actually
  // reaches into its clip.
  const promptLeft = chromePx(14) + promptCharPx * 2;
  const { choicePanels, composerShove } = planTuiChoicePanels({
    env,
    timeline,
    fullHeight,
    contentWidth,
    messageHeights,
    messageGap,
    bannerHeight,
    contentOffsetY,
    scrollPlan,
    transcriptViewport,
    clipBottom,
    composerTop,
    pickerBottomY,
    viewportTop,
    composerGrowth,
    draftTimings: userTimings,
    promptLinePx,
  });
  const typingWindows = userTypingWindows(userTimings);
  const composerIdle = composerIdleAnimation(typingWindows, timeline.durationMs);
  // Deterministic camera work: extracted so tuiScene itself
  // stays under the complexity bar.
  const cameraTrack = tuiCameraTrack({
    choicePanels,
    gridPadX,
    gridPadY,
    fullHeight,
    env,
    timeline,
    messageHeights,
    messageGap,
    viewportTop,
    contentOffsetY,
    contentWidth,
    inset,
    bannerHeight,
    chromePx,
    promptFontPx,
    promptLeft,
    composerTop,
    composerBaseHeight,
    pickerBottomY,
    promptLinePx,
    composerGrowth,
    width,
    authoredHeight,
    scrollMoves: scrollPlan?.moves ?? [],
  });
  // Same layering as the app: one wrapping box carries the camera, the
  // backdrop stays put. The meta lets the Studio invert the transform
  // when hit-testing clicks.
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
  // Hint row under the prompt, with both sides' widths measured in the
  // actual fonts. When the canvas is too narrow for the chrome scale, the
  // right side drops its least important segment (the shortcut hint) and
  // the left side ellipsizes into whatever remains instead of the two
  // texts overlapping. Terminal geometry lives in the title bar
  // (tuiGeometry), so the footer never repeats the column count.
  const hintFontPx = chromeFontPx(12);
  const hintWidthPx = (text: string): number =>
    measureLineWidthPx(engine, {
      text,
      font: MONO_FONT,
      fontSizePx: hintFontPx,
      fallbackRatio: TUI_CHAR_RATIO,
    });
  const hintSpanPx = width - inset * 2 - chromePx(36) - chromePx(28);
  const modeHint = ["ask-before-edits", project.branchLabel.trim()]
    .filter((part) => part.length > 0)
    .join("  ·  ");
  const modeHintPx = hintWidthPx(modeHint);
  const statusSegments = [
    `ctx ${project.chrome.contextPercent}%`,
    ...(project.display.tuiStatusHints ? ["? for shortcuts"] : []),
  ];
  const hintGapPx = chromePx(16);
  while (
    statusSegments.length > 1 &&
    modeHintPx + hintWidthPx(statusSegments.join(" · ")) + hintGapPx > hintSpanPx
  ) {
    statusSegments.pop();
  }
  const statusHint = statusSegments.join(" · ");
  const modeHintWidth = Math.max(
    Math.ceil(hintFontPx * 2.4),
    Math.floor(hintSpanPx - hintWidthPx(statusHint) - hintGapPx),
  );
  const transcriptColumn = Flex(
    {
      position: "absolute",
      left: 0,
      top: contentOffsetY,
      width: contentWidth,
      direction: "column",
      gap: messageGap,
      ...(scrollPlan ? { animate: scrollPlan.track } : {}),
    },
    ...(pageIndex === 0
      ? [
          Text(
            {
              width: contentWidth,
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx: metrics.tuiFontPx,
              lineHeightPx: metrics.tuiLinePx,
              color: readablePalette.faint,
              wrap: "none",
              animate: tuiPop(40),
            },
            [
              display.productMark
                ? display.productVersion && env.product.version.length > 0
                  ? `${env.product.name} v${env.product.version}`
                  : env.product.name
                : "",
              project.branchLabel.trim(),
              "/help for commands",
            ]
              .filter((part) => part.length > 0)
              .join(" · "),
          ),
        ]
      : []),
    ...renderedMessages.map((rendered, index) =>
      Box(
        {
          width: contentWidth,
          height: messageHeights[index] ?? rendered.estimatedHeight,
        },
        rendered.node,
      ),
    ),
  );
  const standoffFrame = {
    position: "absolute" as const,
    left: 0,
    top: 0,
    width: contentWidth,
    height: transcriptViewport,
  };
  const transcriptLayers: AnyVNode[] = composerShove
    ? [
        Box(
          {
            ...standoffFrame,
            animate: composerShove,
            meta: { "composer-standoff": "transcript" },
          },
          // Crop in the column's own coordinates before moving it. This is
          // the same moving-viewport contract as App; TUI currently has no
          // spring overshoot, but future row effects cannot escape it.
          Box({ ...standoffFrame, overflow: "clip" }, transcriptColumn),
        ),
      ]
    : [transcriptColumn];

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
          surface: "tui",
        },
      },
      ...backdropNodes(env, width, height),
      ...cameraLayer([
        ...windowShadowNodes(env, {
          left: inset,
          top: inset,
          width: sizeLeft(width, inset * 2),
          height: sizeLeft(height, inset * 2),
          radius: 12,
        }),
        Box({
          position: "absolute",
          left: inset,
          top: inset,
          width: sizeLeft(width, inset * 2),
          height: sizeLeft(height, inset * 2),
          borderRadius: 12,
          background: terminalBackground,
          borderWidth: TUI_FRAME_STROKE_PX,
          strokeScaling: "canvas",
          borderColor: palette.border,
        }),
        ...tuiHeaderNodes({
          env,
          timeline,
          readablePalette,
          chromePx,
          chromeFontPx,
          width,
          height,
          inset,
          viewportTop,
          headerDotsTop,
          headerTitleTop,
          columns,
          rows,
        }),
        // The terminal window carries exactly four bands: the title bar, this
        // transcript viewport, the prompt, and the status bar. The other three
        // are subtracted from the viewport height above, so every row inside
        // the grid belongs to the transcript flow and no two of them can ever
        // claim the same rows. Anything the session prints — pickers included
        // — is a block in this column; a window-anchored node that draws grid
        // content would be outside the row budget, and would land on top of
        // the lines above it as soon as an authored scale made it tall enough.
        Box(
          {
            position: "absolute",
            left: inset + gridPadX,
            // Centering slack moves the rows inside the band, never the band
            // itself: the band owns exactly the viewport's rows, and shifting
            // it would push its foot under the prompt.
            top: viewportTop + gridPadY,
            width: contentWidth,
            height: transcriptViewport,
            overflow: "clip",
            meta: { band: "transcript" },
          },
          ...transcriptLayers,
        ),
        ...tuiComposerNodes({
          env,
          timeline,
          userTimings,
          composerIdle,
          // The prompt yields for exactly the window the panel prints in.
          composerGrowth,
          choicePanels: choicePanels.map(({ panel }) => panel),
          pickerHold: composerBasePanelAnimation(
            choicePanels.map(({ timing }) => ({
              startMs: timing.startMs,
              // The prompt comes back the moment the picker hands the
              // keyboard over, so the answer is typed where it would be.
              endMs: pickerCloseMs(timing, project),
            })),
            timeline.durationMs,
          ),
          readablePalette,
          chromeMuted,
          chromePx,
          width,
          height,
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
        }),
        ...tuiStatusBarNodes({
          env,
          pageIndex,
          pageCount,
          chromeMuted,
          chromePx,
          chromeFontPx,
          width,
          inset,
        }),
      ]),
    ),
  };
}

/**
 * Measure the real laid-out height of each message by running a probe
 * layout of just the transcript column — boundsvg can measure, so the
 * scroll plan does not need to trust the character-width estimates.
 * Returns null (fall back to estimates) if the probe fails.
 */
/**
 * Exact single-line text width from the engine's measurement API — correct
 * for whatever font the user assigned to the slot. Falls back to
 * per-character ratio arithmetic when no engine is attached (validation
 * paths) or the engine lacks the measurement API.
 */
