import {
  type AnimationSpec,
  type AnyVNode,
  Box,
  type Engine,
  Flex,
  Image,
  Inline,
  Text,
} from "@boundsvg/core";
import {
  appBubbleFade,
  appBubbleSpring,
  appEntrance,
  appSpinnerRing,
  appThinkingDots,
  stepVisibilityWindow,
  streamedUnits,
  TUI_PULSE_FRAMES,
  TUI_SPINNER_FRAMES,
  tuiPop,
  tuiSpinner,
  typedUnits,
  visibilityWindow,
} from "./animations.js";
import { userLandingMs } from "./composer.js";
import {
  accentInk,
  estimateTextWidthPx,
  hexToRgba,
  type Metrics,
  MONO_FALLBACK,
  MONO_FONT,
  messageSurfaceAlpha,
  type RenderedBlock,
  SANS_FALLBACK,
  SANS_FONT,
  type SceneEnv,
  type ScenePalette,
  secondsLabel,
  sizeLeft,
  spacePx,
  strokePx,
  TUI_CHAR_RATIO,
  TUI_FRAME_STROKE_PX,
} from "./env.js";
import { type SceneAction, sceneActionMeta } from "./interaction.js";
import { markdownPlainText, parseMarkdown } from "./markdown.js";
import { renderMarkdown } from "./markdown-render.js";
import { measureLineWidthPx, measureWrappedLineCount } from "./measure.js";
import {
  type AttachedImage,
  type MessageAlign,
  type SessionMessage,
  type SvgentProject,
  stripDraftMarkup,
} from "./model.js";
import { choiceDraftTiming, type MessageTiming } from "./timeline.js";

// ————————————————————————————————————————————————————————————————————————————
// Status rows (thinking / tool)
// ————————————————————————————————————————————————————————————————————————————

/**
 * Characters per second that spends roughly the first half of the thinking
 * window forming the thought, whatever the authored pace.
 */
function thinkingRevealCps(content: string, windowMs: number): number {
  const characters = Math.max(1, Array.from(content).length);
  return characters / Math.max(0.4, (windowMs * 0.5) / 1_000);
}

/**
 * Fill and edge for a message card. "plain" drops the agent's slab entirely
 * rather than fading it — a near-invisible border is worse than none, and the
 * user's bubble carries the distinction either way.
 */
function appCardSurface(env: SceneEnv, isUser: boolean): Record<string, unknown> {
  const { palette } = env;
  if (!isUser && env.project.appearance.assistantSurface === "plain") {
    return {};
  }
  return {
    background: hexToRgba(
      isUser ? palette.user : palette.panelStrong,
      messageSurfaceAlpha(env.project),
    ),
    borderWidth: strokePx(env.metrics),
    // The fill already says whose words these are; an accent-coloured edge on
    // top of it was the loudest thing in the transcript.
    borderColor: palette.border,
  };
}

const APP_STATUS_INSET_PX = 13;
const APP_STATUS_GAP_PX = 10;

/**
 * Status-row icon box, tracking the text it sits beside. The ratio keeps the
 * default 16px ring at the default 13px UI text; the widths mirror what the
 * icon builders lay out, since the row reserves its text band before the
 * engine measures anything.
 */
function appStatusIconSize(uiPx: number): { boxPx: number; dotsWidthPx: number } {
  const boxPx = Math.max(12, Math.round(uiPx * 1.23));
  const dotPx = Math.max(4, Math.round(boxPx * 0.31));
  const gapPx = Math.max(3, Math.round(boxPx * 0.25));
  return { boxPx, dotsWidthPx: dotPx * 3 + gapPx * 2 };
}

function appStatusMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics, project, engine } = env;
  const { message, startMs, revealEndMs } = timing;
  const isThinking = message.role === "thinking";
  const settledLabel = isThinking
    ? `Thought for ${secondsLabel(project.timing.thinkingMs)}`
    : message.content;
  const liveLabel = isThinking ? `${message.content}…` : message.content;
  const bodyFont = isThinking ? SANS_FONT : MONO_FONT;
  const bodyFallback = isThinking ? [MONO_FONT] : [SANS_FONT];
  const secondsPx = Math.max(9, metrics.uiPx - 2);

  // Both states stack at the same origin, so the row reserves the taller
  // of the two rather than letting either run past the card edge.
  const inset = spacePx(metrics, APP_STATUS_INSET_PX);
  const gap = spacePx(metrics, APP_STATUS_GAP_PX);
  const innerWidth = sizeLeft(width, inset * 2);
  const icon = appStatusIconSize(metrics.uiPx);
  const liveTextWidth = Math.max(
    40,
    innerWidth - (isThinking ? icon.dotsWidthPx : icon.boxPx) - gap,
  );
  const checkWidth = measureLineWidthPx(engine, {
    text: "✓",
    font: MONO_FONT,
    fontSizePx: metrics.uiPx,
    fallbackRatio: 0.6,
  });
  const trailingWidth = isThinking
    ? 0
    : measureLineWidthPx(engine, {
        text: secondsLabel(project.timing.toolRunMs),
        font: MONO_FONT,
        fontSizePx: secondsPx,
        fallbackRatio: 0.6,
      }) + gap;
  const settledTextWidth = Math.max(40, innerWidth - checkWidth - gap - trailingWidth);
  const lineHeightPx = Math.round(metrics.uiPx * 1.45);
  const lineCount = Math.max(
    measureWrappedLineCount(engine, {
      text: liveLabel,
      font: bodyFont,
      fontSizePx: metrics.uiPx,
      maxWidthPx: liveTextWidth,
      wrap: "word",
      fallbackRatio: 0.6,
      whiteSpace: "pre-wrap",
    }),
    measureWrappedLineCount(engine, {
      text: settledLabel,
      font: bodyFont,
      fontSizePx: metrics.uiPx,
      maxWidthPx: settledTextWidth,
      wrap: "word",
      fallbackRatio: 0.6,
      whiteSpace: "pre-wrap",
    }),
  );
  const bodyHeight = lineHeightPx * lineCount;
  const padPx = Math.max(8, Math.round((Math.max(40, metrics.uiPx + 26) - lineHeightPx) / 2));
  const rowHeight = bodyHeight + padPx * 2;
  // Icons keep their own size, so a box one line tall centres them against
  // the first line instead of the whole wrapped block.
  const iconRow = (icon: AnyVNode): AnyVNode =>
    Flex({ height: lineHeightPx, direction: "row", alignItems: "center" }, icon);
  return {
    node: Box(
      {
        width,
        height: rowHeight,
        position: "relative",
        borderRadius: 10,
        background: hexToRgba(palette.panelSoft, messageSurfaceAlpha(env.project)),
        borderWidth: strokePx(metrics),
        borderColor: palette.border,
        animate: appEntrance(startMs),
        meta: { edit: message.id },
      },
      Flex(
        {
          position: "absolute",
          left: inset,
          top: padPx,
          width: innerWidth,
          height: bodyHeight,
          direction: "row",
          gap,
          alignItems: "start",
          animate: visibilityWindow(startMs, revealEndMs, 160),
        },
        iconRow(
          isThinking
            ? appThinkingDots(palette.muted, icon.boxPx)
            : appSpinnerRing(palette.accent, icon.boxPx, revealEndMs),
        ),
        Text(
          {
            width: liveTextWidth,
            font: bodyFont,
            fallback: bodyFallback,
            fontSizePx: metrics.uiPx,
            lineHeightPx,
            color: palette.muted,
            wrap: "word",
            whiteSpace: "pre-wrap",
            // A thought forms; it is not known the instant the row appears.
            // The tool row keeps its instant echo — a shell command really
            // does appear whole the moment it runs.
            ...(isThinking
              ? {
                  animateUnits: streamedUnits(
                    startMs + 120,
                    thinkingRevealCps(message.content, revealEndMs - startMs),
                    0,
                  ),
                }
              : {}),
          },
          liveLabel,
        ),
      ),
      Flex(
        {
          position: "absolute",
          left: inset,
          top: padPx,
          width: innerWidth,
          height: bodyHeight,
          direction: "row",
          gap,
          alignItems: "start",
          animate: visibilityWindow(revealEndMs, null, 200),
        },
        iconRow(
          Text(
            {
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx: metrics.uiPx,
              color: palette.success,
              wrap: "none",
            },
            "✓",
          ),
        ),
        Text(
          {
            width: settledTextWidth,
            font: bodyFont,
            fallback: bodyFallback,
            fontSizePx: metrics.uiPx,
            lineHeightPx,
            color: palette.muted,
            wrap: "word",
            whiteSpace: "pre-wrap",
          },
          settledLabel,
        ),
        ...(isThinking
          ? []
          : [
              iconRow(
                Text(
                  {
                    font: MONO_FONT,
                    fallback: MONO_FALLBACK,
                    fontSizePx: secondsPx,
                    color: palette.faint,
                    wrap: "none",
                  },
                  secondsLabel(project.timing.toolRunMs),
                ),
              ),
            ]),
      ),
    ),
    estimatedHeight: rowHeight,
  };
}

const APP_NOTE_PAD_PX = 10;

/**
 * Height the opened note needs for this content at this width. Measured with
 * the same wrap the note renders with, so the lift computed from this number
 * matches the panel actually drawn.
 */
export function appHighlightNoteHeight(env: SceneEnv, width: number, content: string): number {
  const inset = spacePx(env.metrics, APP_STATUS_INSET_PX);
  const sidePad = spacePx(env.metrics, APP_ROW_SIDE_PAD_PX);
  const lineHeightPx = Math.round(env.metrics.uiPx * 1.45);
  const lines = measureWrappedLineCount(env.engine, {
    text: content,
    font: SANS_FONT,
    fontSizePx: env.metrics.uiPx,
    maxWidthPx: Math.max(40, width - sidePad * 2 - inset * 2),
    wrap: "word",
    fallbackRatio: 0.6,
    whiteSpace: "pre-wrap",
  });
  return lines * lineHeightPx + spacePx(env.metrics, APP_NOTE_PAD_PX) * 2;
}

/**
 * The note a highlighted thinking row opens beneath itself. It is drawn once
 * at its opened place and revealed by fade-and-rise while the rows below make
 * room — the panel never scales, so its text never distorts mid-flight.
 */
export function appHighlightNote(options: {
  env: SceneEnv;
  content: string;
  /** Message id, so clicking the open note edits its thinking row. */
  editId: string;
  width: number;
  topPx: number;
  notePx: number;
  window: { startMs: number; arriveMs: number; holdEndMs: number; returnMs: number };
  durationMs: number;
}): AnyVNode {
  const { env, content, editId, width, topPx, notePx, window, durationMs } = options;
  const { palette, metrics } = env;
  const inset = spacePx(metrics, APP_STATUS_INSET_PX);
  const sidePad = spacePx(metrics, APP_ROW_SIDE_PAD_PX);
  const at = (timeMs: number) => Math.min(1, Math.max(0, timeMs / durationMs));
  const hidden = { opacity: 0, transform: { translateY: -6 } };
  const shown = { opacity: 1, transform: { translateY: 0 } };
  const reveal: AnimationSpec = {
    keyframes: [
      { at: 0, ...hidden },
      { at: at(window.startMs), ...hidden },
      { at: at(window.arriveMs), ...shown },
      { at: at(window.holdEndMs), ...shown },
      { at: at(window.returnMs), ...hidden },
      { at: 1, ...hidden },
    ].filter((keyframe, index, all) => index === 0 || keyframe.at > (all[index - 1]?.at ?? -1)),
    durationMs,
    easing: "ease-in-out",
    fill: "both",
  };
  return Box(
    {
      position: "absolute",
      left: sidePad,
      top: topPx,
      width: sizeLeft(width, sidePad * 2),
      height: notePx,
      borderRadius: 10,
      background: hexToRgba(palette.panelSoft, messageSurfaceAlpha(env.project)),
      borderWidth: strokePx(metrics),
      borderColor: palette.border,
      padding: [spacePx(metrics, APP_NOTE_PAD_PX), inset, spacePx(metrics, APP_NOTE_PAD_PX), inset],
      animate: reveal,
      // The note is a timed overlay: it shares column space with rows that
      // enter only after it has folded, so one frame's boxes overlap even
      // though no two visible things ever do. The overlay marker keeps the
      // static stacking invariant honest about that.
      meta: { edit: editId, overlay: "highlight-note" },
    },
    Text(
      {
        width: Math.max(40, width - sidePad * 2 - inset * 2),
        font: SANS_FONT,
        fallback: [MONO_FONT],
        fontSizePx: metrics.uiPx,
        lineHeightPx: Math.round(metrics.uiPx * 1.45),
        color: palette.muted,
        wrap: "word",
        whiteSpace: "pre-wrap",
      },
      content,
    ),
  );
}

/**
 * The opened note as real in-flow content, for report stills: same panel,
 * no animation, laid out under its row so the still shows what the replay's
 * beat holds.
 */
export function appHighlightNoteBlock(options: {
  env: SceneEnv;
  content: string;
  width: number;
  notePx: number;
}): AnyVNode {
  const { env, content, width, notePx } = options;
  const { palette, metrics } = env;
  const inset = spacePx(metrics, APP_STATUS_INSET_PX);
  const sidePad = spacePx(metrics, APP_ROW_SIDE_PAD_PX);
  return Box(
    {
      width: sizeLeft(width, sidePad * 2),
      height: notePx,
      margin: [0, sidePad, 0, sidePad],
      borderRadius: 10,
      background: hexToRgba(palette.panelSoft, messageSurfaceAlpha(env.project)),
      borderWidth: strokePx(metrics),
      borderColor: palette.border,
      padding: [spacePx(metrics, APP_NOTE_PAD_PX), inset, spacePx(metrics, APP_NOTE_PAD_PX), inset],
    },
    Text(
      {
        width: Math.max(40, width - sidePad * 2 - inset * 2),
        font: SANS_FONT,
        fallback: [MONO_FONT],
        fontSizePx: metrics.uiPx,
        lineHeightPx: Math.round(metrics.uiPx * 1.45),
        color: palette.muted,
        wrap: "word",
        whiteSpace: "pre-wrap",
      },
      content,
    ),
  );
}

/**
 * Cells the TUI status rows wrap at. A terminal breaks mid-word at the cell
 * boundary, so these rows wrap by character like the rest of the TUI surface;
 * the continuation sits under the text rather than at column 0, which is what
 * a program printing its own indent produces.
 */
function tuiStatusLineCount(env: SceneEnv, text: string, maxWidthPx: number): number {
  return measureWrappedLineCount(env.engine, {
    text,
    font: MONO_FONT,
    fontSizePx: env.metrics.tuiFontPx,
    maxWidthPx,
    wrap: "char",
    fallbackRatio: TUI_CHAR_RATIO,
    whiteSpace: "pre-wrap",
  });
}

function tuiThinkingMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics, project } = env;
  const { message, startMs, revealEndMs } = timing;
  const spinnerWidth = Math.ceil(metrics.tuiCharPx) + 2;
  const liveWidth = Math.max(metrics.tuiCharPx * 8, width - spinnerWidth - 8);
  const liveLabel = `${message.content}… (esc to interrupt)`;
  const settledLabel = `✓ Thought for ${secondsLabel(project.timing.thinkingMs)}`;
  const lineCount = Math.max(
    tuiStatusLineCount(env, liveLabel, liveWidth),
    tuiStatusLineCount(env, settledLabel, width),
  );
  const rowHeight = metrics.tuiLinePx * lineCount;
  return {
    node: Box(
      { width, height: rowHeight, position: "relative", meta: { edit: message.id } },
      Flex(
        {
          position: "absolute",
          left: 0,
          top: 0,
          width,
          direction: "row",
          gap: 8,
          alignItems: "start",
          animate: visibilityWindow(startMs, revealEndMs, 16),
        },
        tuiSpinner(env, { frames: TUI_PULSE_FRAMES, color: palette.accent, cycleMs: 640 }),
        Text(
          {
            width: liveWidth,
            font: MONO_FONT,
            fallback: MONO_FALLBACK,
            fontSizePx: metrics.tuiFontPx,
            lineHeightPx: metrics.tuiLinePx,
            color: palette.muted,
            wrap: "char",
            // Terminal repaint pacing, but still forming over the window
            // rather than asserting the thought the instant the row prints.
            animateUnits: typedUnits(
              startMs + 80,
              thinkingRevealCps(message.content, revealEndMs - startMs),
              0,
            ),
          },
          liveLabel,
        ),
      ),
      Text(
        {
          position: "absolute",
          left: 0,
          top: 0,
          width,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: metrics.tuiFontPx,
          lineHeightPx: metrics.tuiLinePx,
          wrap: "char",
          color: palette.muted,
          animate: visibilityWindow(revealEndMs, null, 16),
        },
        Inline({ color: palette.success }, "✓ "),
        Inline({ color: palette.muted }, `Thought for ${secondsLabel(project.timing.thinkingMs)}`),
      ),
    ),
    estimatedHeight: rowHeight,
  };
}

function tuiToolMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics, project } = env;
  const { message, startMs, revealEndMs } = timing;
  // The echoed command wraps like a terminal does, so the result line sits
  // below however many rows it actually took.
  // A tool message may carry several commands. A terminal prints each with its
  // own prompt, and collapsing them into one run produces a line that is not a
  // command at all ("… src tests sed -n '1,240p' …").
  const commands = message.content.split("\n");
  const commandLines = tuiStatusLineCount(
    env,
    commands.map((command) => `$ ${command}`).join("\n"),
    width,
  );
  const resultTop = metrics.tuiLinePx * commandLines;
  const rowHeight = metrics.tuiLinePx * (commandLines + 1);
  return {
    node: Box(
      { width, height: rowHeight, position: "relative", meta: { edit: message.id } },
      Text(
        {
          position: "absolute",
          left: 0,
          top: 0,
          width,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: metrics.tuiFontPx,
          lineHeightPx: metrics.tuiLinePx,
          wrap: "char",
          whiteSpace: "pre-wrap",
          color: palette.codeText,
          animate: tuiPop(startMs),
        },
        ...commands.flatMap((command, index) => [
          Inline({ color: palette.accent }, index === 0 ? "$ " : "\n$ "),
          Inline({ color: palette.codeText }, command),
        ]),
      ),
      Flex(
        {
          position: "absolute",
          left: 0,
          top: resultTop,
          width,
          direction: "row",
          gap: 8,
          animate: visibilityWindow(startMs + 120, revealEndMs, 16),
        },
        tuiSpinner(env, { frames: TUI_SPINNER_FRAMES, color: palette.muted, cycleMs: 480 }),
        Text(
          {
            font: MONO_FONT,
            fallback: MONO_FALLBACK,
            fontSizePx: metrics.tuiFontPx,
            lineHeightPx: metrics.tuiLinePx,
            color: palette.faint,
            wrap: "none",
          },
          "running…",
        ),
      ),
      Text(
        {
          position: "absolute",
          left: 0,
          top: resultTop,
          width,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: metrics.tuiFontPx,
          lineHeightPx: metrics.tuiLinePx,
          wrap: "none",
          color: palette.faint,
          animate: visibilityWindow(revealEndMs, null, 16),
        },
        Inline({ color: palette.faint }, "└ "),
        Inline({ color: palette.success }, "done"),
        Inline({ color: palette.faint }, ` · exit 0 · ${secondsLabel(project.timing.toolRunMs)}`),
      ),
    ),
    estimatedHeight: rowHeight,
  };
}

// ————————————————————————————————————————————————————————————————————————————
// Permission prompts
// ————————————————————————————————————————————————————————————————————————————

/**
 * The transcript record of a permission: only the compact approved line,
 * sized as the one-liner it is. The interactive prompt itself floats above
 * the composer (appApprovalPrompt) like real agent UIs, so this card never
 * reserves button-row height.
 */
/**
 * A permission request as a chat app shows it: inline in the conversation,
 * in sequence. The card holds its place and height throughout — the button
 * row is simply replaced by the decision — so nothing jumps when the
 * request resolves. (Terminals do float their picker above the prompt
 * line; that stays in tuiApprovalPrompt.)
 */
function appPermissionMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  if (choiceCollapses(timing.message, env.project)) {
    return appPermissionRecordBlock(timing, env, width);
  }
  return appPermissionCard(timing, env, {
    width,
    animate: appEntrance(timing.startMs),
    editMeta: true,
  });
}

/**
 * The record a collapsed permission leaves: what was asked, in the quiet
 * voice, and how it resolved — the same two-line shape the choice keeps.
 */
function appPermissionRecordBlock(
  timing: MessageTiming,
  env: SceneEnv,
  width: number,
): RenderedBlock {
  const { palette, metrics, message } = { ...env, message: timing.message };
  const words = approvalWords(message.content);
  const denied = message.decision === "deny";
  const labelPx = Math.max(12, metrics.uiPx);
  const hintPx = Math.max(10, metrics.uiPx - 2);
  const labelLinePx = Math.round(labelPx * 1.5);
  const hintLinePx = Math.round(hintPx * 1.5);
  const markGapPx = labelPx + 8;
  const height = 8 + hintLinePx + 4 + labelLinePx + 8;
  const reveal = visibilityWindow(Math.max(1, timing.revealEndMs - 220), null, 200);
  return {
    node: Box(
      { width, height, position: "relative", animate: reveal, meta: { edit: message.id } },
      Text(
        {
          position: "absolute",
          left: 2,
          top: 8,
          width: sizeLeft(width, 4),
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: hintPx,
          lineHeightPx: hintLinePx,
          color: palette.faint,
          wrap: "none",
          maxLines: 1,
          ellipsis: true,
        },
        message.content,
      ),
      Text(
        {
          position: "absolute",
          left: 2,
          top: 8 + hintLinePx + 4,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: labelPx,
          lineHeightPx: labelLinePx,
          color: denied ? palette.danger : palette.success,
          wrap: "none",
        },
        denied ? "✗" : "✓",
      ),
      Text(
        {
          position: "absolute",
          left: 2 + markGapPx,
          top: 8 + hintLinePx + 4,
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: labelPx,
          lineHeightPx: labelLinePx,
          color: palette.muted,
          wrap: "none",
        },
        denied ? words.denied : words.approved,
      ),
    ),
    estimatedHeight: height,
  };
}

/** The consent card, standing in the transcript or grown out of the frame. */
function appPermissionCard(
  timing: MessageTiming,
  env: SceneEnv,
  mode: { width: number; animate: AnimationSpec; editMeta: boolean },
): RenderedBlock {
  const { palette, metrics, project } = env;
  const { startMs, revealEndMs, message } = timing;
  const { width } = mode;
  const words = approvalWords(message.content);
  const denied = message.decision === "deny";
  const headerPx = metrics.metaPx;
  const buttonTextPx = Math.max(11, metrics.uiPx - 1);
  const buttonLinePx = buttonTextPx + 6;
  const buttonRowPx = buttonLinePx + 12;
  const descriptionTop = 13 + headerPx + 8;
  // What is being approved has to stay readable in full: an ellipsis here
  // hides the very thing the decision is about.
  const descriptionLines = measureWrappedLineCount(env.engine, {
    text: message.content,
    font: SANS_FONT,
    fontSizePx: metrics.prosePx,
    maxWidthPx: width - 30,
    wrap: "char",
    fallbackRatio: 0.6,
  });
  const decisionTop = descriptionTop + metrics.proseLinePx * descriptionLines + 12;
  const height = decisionTop + buttonRowPx + 14;
  const press: AnimationSpec = {
    keyframes: [
      { at: 0, opacity: 1, transform: { scaleX: 1, scaleY: 1 } },
      { at: 0.4, opacity: 1, transform: { scaleX: 1, scaleY: 1 } },
      { at: 0.62, opacity: 1, transform: { scaleX: 0.94, scaleY: 0.9 } },
      { at: 1, opacity: 1, transform: { scaleX: 1, scaleY: 1 } },
    ],
    durationMs: Math.max(240, revealEndMs - startMs),
    delayMs: startMs,
    easing: "ease-out",
    fill: "both",
  };
  const button = (spec: {
    label: string;
    active: boolean;
    primary: boolean;
    action: SceneAction;
  }): AnyVNode =>
    Box(
      {
        padding: [6, 14, 6, 14],
        borderRadius: 8,
        ...(spec.primary
          ? { background: palette.accent }
          : {
              borderWidth: strokePx(metrics),
              borderColor: spec.active ? palette.danger : palette.border,
            }),
        ...(spec.active ? { animate: press } : {}),
        meta: sceneActionMeta(spec.action, { messageId: message.id }),
      },
      Text(
        {
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: buttonTextPx,
          lineHeightPx: buttonLinePx,
          color: spec.primary ? accentInk(palette.accent) : palette.muted,
          wrap: "none",
        },
        spec.label,
      ),
    );
  return {
    node: Box(
      {
        width,
        height,
        position: "relative",
        borderRadius: 12,
        borderWidth: strokePx(metrics),
        borderColor: palette.border,
        background: hexToRgba(palette.panelStrong, messageSurfaceAlpha(project)),
        animate: mode.animate,
        ...(mode.editMeta ? { meta: { edit: message.id } } : {}),
      },
      Text(
        {
          position: "absolute",
          left: 15,
          top: 11,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: headerPx,
          color: palette.warning,
          letterSpacingPx: 0.8,
          wrap: "none",
        },
        words.heading,
      ),
      Text(
        {
          position: "absolute",
          left: 15,
          top: descriptionTop,
          width: sizeLeft(width, 30),
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: metrics.prosePx,
          lineHeightPx: metrics.proseLinePx,
          color: palette.text,
          wrap: "char",
        },
        message.content,
      ),
      // Pending: the buttons. Settled: the decision, in their place.
      Flex(
        {
          position: "absolute",
          left: 15,
          top: decisionTop,
          direction: "row",
          gap: 8,
          alignItems: "center",
          animate: visibilityWindow(startMs, revealEndMs, 160),
        },
        button({ label: words.allow, active: !denied, primary: true, action: "approve" }),
        button({ label: words.deny, active: denied, primary: false, action: "deny" }),
      ),
      Flex(
        {
          position: "absolute",
          left: 15,
          top: decisionTop,
          height: buttonRowPx,
          direction: "row",
          gap: 9,
          alignItems: "center",
          animate: visibilityWindow(revealEndMs, null, 200),
        },
        Text(
          {
            font: MONO_FONT,
            fallback: MONO_FALLBACK,
            fontSizePx: metrics.uiPx,
            color: denied ? palette.danger : palette.success,
            wrap: "none",
          },
          denied ? "✗" : "✓",
        ),
        Text(
          {
            font: SANS_FONT,
            fallback: SANS_FALLBACK,
            fontSizePx: metrics.uiPx,
            color: palette.muted,
            wrap: "none",
          },
          denied ? words.denied : words.approved,
        ),
      ),
    ),
    estimatedHeight: height,
  };
}

/**
 * Approval wording follows the script's language, the way the generation
 * phrases do: an agent shown speaking Japanese would not label its own
 * buttons in English.
 */
function approvalWords(content: string): {
  allow: string;
  deny: string;
  hint: string;
  approved: string;
  approvedLower: string;
  denied: string;
  deniedLower: string;
  required: string;
  heading: string;
  rows: readonly string[];
  selectHeading: string;
  writeOwn: string;
} {
  return hasCjk(content)
    ? {
        allow: "許可",
        deny: "拒否",
        hint: "enter 許可 · esc 拒否",
        approved: "承認済み",
        approvedLower: "承認済み",
        denied: "拒否しました",
        deniedLower: "拒否しました",
        required: "● 許可が必要です",
        heading: "許可が必要です",
        rows: ["1. はい", "2. 常に許可", "3. いいえ (esc)"],
        selectHeading: "● 選択してください",
        writeOwn: "自分で書く",
      }
    : {
        allow: "Allow once",
        deny: "Deny",
        hint: "enter allow · esc deny",
        approved: "Approved",
        approvedLower: "approved",
        denied: "Denied",
        deniedLower: "denied",
        required: "● Permission required",
        heading: "APPROVAL REQUIRED",
        rows: ["1. Yes", "2. Yes, always", "3. No (esc)"],
        selectHeading: "● Select an option",
        writeOwn: "Write your own",
      };
}

/**
 * An option the agent offers. Scripts author `label — hint`; the hint is
 * the one-line explanation shown under the label.
 */
function parseOption(raw: string): { label: string; hint: string } {
  const [label = raw, ...rest] = raw.split(/\s+[—–-]\s+/u);
  return { label: label.trim(), hint: rest.join(" — ").trim() };
}

/** The span a picker's caret rests on one row; `to: null` means it stays. */
type CaretWindow = { from: number; to: number | null };

/**
 * When the caret sits on each row of a terminal picker. It opens on the
 * first row — every terminal picker starts focused on option 1 — pauses
 * while the list is read, then steps down one row at a time to the answer,
 * because that is the only way a keyboard reaches a lower option. Rows are
 * switched, never tweened: a caret does not slide between lines.
 */
function caretWindows(
  span: { startMs: number; endMs: number },
  rowCount: number,
  chosen: number,
): Array<CaretWindow | null> {
  const { startMs, endMs } = span;
  const target = Math.max(0, Math.min(rowCount - 1, chosen));
  const dwell = Math.max(1, endMs - startMs);
  // Read first, and land on the answer with time in hand before the press.
  const firstStepMs = startMs + dwell * 0.3;
  const stepMs = target > 0 ? (dwell * 0.45) / target : 0;
  const enterMs = (row: number): number => (row === 0 ? startMs : firstStepMs + stepMs * row);
  // Rows below the answer are never reached, so they get no focus line at
  // all — a zero-length window would flash them for a frame on the way past.
  return Array.from({ length: rowCount }, (_unused, row) =>
    row > target ? null : { from: enterMs(row), to: row === target ? null : enterMs(row + 1) },
  );
}

/** One picker row: the muted line, with the focused line switched over it. */
/** Complement of a caret window: the muted line yields while the caret is on it. */
function unfocusedWindow(focus: CaretWindow): AnimationSpec {
  if (focus.to === null) {
    return {
      keyframes: [
        { at: 0, opacity: 1 },
        { at: 1, opacity: 0 },
      ],
      durationMs: 16,
      delayMs: focus.from,
      easing: "step-start",
      fill: "both",
    };
  }
  const held = Math.max(1, focus.to - focus.from);
  const total = held + 16;
  const outAt = Math.min(0.49, 16 / total);
  return {
    keyframes: [
      { at: 0, opacity: 1 },
      { at: outAt, opacity: 0 },
      { at: Math.max(outAt + 0.01, Math.min(0.99, held / total)), opacity: 0 },
      { at: 1, opacity: 1 },
    ],
    durationMs: total,
    delayMs: focus.from,
    easing: "linear",
    fill: "both",
  };
}

/**
 * One picker row. The muted and focused copies of the label share the exact
 * same box and swap by opacity — overlaying them would double the glyphs —
 * and the caret lives in its own column so the labels stay aligned whatever
 * width the font gives "\u276f".
 */
function pickerRow(
  env: SceneEnv,
  place: { left: number; top: number; width: number },
  row: {
    label: string;
    focus: CaretWindow | null;
    meta: Record<string, string>;
    /**
     * The repaint that turns the resting caret into the recorded answer. A
     * `label` replaces the row's own text with what the answer actually was —
     * the terminal echoes a typed reply where the offer used to be.
     */
    settle?: { atMs: number; mark: string; color: string; label?: string | undefined };
  },
): AnyVNode[] {
  const { label, focus } = row;
  const { palette, metrics } = env;
  const caretWidth = metrics.tuiCharPx * 2;
  const cell = (spec: { left: number; color: string; text: string }, animate?: AnimationSpec) => {
    const { left, color, text } = spec;
    return Text(
      {
        position: "absolute",
        left,
        top: place.top,
        width: sizeLeft(place.width, left - place.left),
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: metrics.tuiFontPx,
        lineHeightPx: metrics.tuiLinePx,
        wrap: "none",
        maxLines: 1,
        ellipsis: true,
        color,
        meta: row.meta,
        ...(animate ? { animate } : {}),
      },
      text,
    );
  };
  const labelLeft = place.left + caretWidth;
  if (focus === null) {
    return [cell({ left: labelLeft, color: palette.muted, text: label })];
  }
  const shown = visibilityWindow(focus.from, focus.to, 16);
  const settle = focus.to === null ? row.settle : undefined;
  const settledLabel = settle?.label;
  return [
    cell({ left: labelLeft, color: palette.muted, text: label }, unfocusedWindow(focus)),
    cell(
      { left: labelLeft, color: palette.text, text: label },
      settledLabel === undefined ? shown : visibilityWindow(focus.from, settle?.atMs ?? null, 16),
    ),
    cell(
      { left: place.left, color: palette.accent, text: "\u276f" },
      settle ? visibilityWindow(focus.from, settle.atMs, 16) : shown,
    ),
    // One repaint swaps the caret for the mark: the row the walk stopped on
    // is what the scrollback keeps, so the answer stays readable long after
    // the picker was live.
    ...(settle
      ? [
          cell(
            { left: place.left, color: settle.color, text: settle.mark },
            visibilityWindow(settle.atMs, null, 16),
          ),
        ]
      : []),
    // "Write my own" is answered by typing, so the offer is replaced by what
    // was typed rather than ticked in place.
    ...(settle && settledLabel !== undefined
      ? [
          cell(
            { left: labelLeft, color: palette.text, text: settledLabel },
            visibilityWindow(settle.atMs, null, 16),
          ),
        ]
      : []),
  ];
}

/**
 * A terminal picker as a transcript block.
 *
 * Every row svgent draws inside the terminal grid belongs to the transcript
 * flow, so the layout that reserves space for a message is the same layout
 * that draws it. An earlier build floated the pending picker over the prompt
 * area and left a one-line summary in the flow: two records of one message in
 * two coordinate systems, with nothing to keep them apart. Whatever the
 * authored font and chrome scales made the picker, it covered the rows above
 * it \u2014 and a terminal cannot half-cover a row.
 *
 * The pending caret walk and the settled answer are therefore two states of
 * one block. Its height is fixed at the taller of them, which is what lets the
 * scroll plan, the camera and the height probe agree, and what puts the picker
 * into every still the way the app card already is.
 */
function tuiPickerBlock(
  timing: MessageTiming,
  env: SceneEnv,
  spec: {
    width: number;
    /** Border and heading colour: accent for a question, warning for consent. */
    tone: string;
    heading: string;
    question: string;
    rows: readonly string[];
    chosen: number;
    settledMark: string;
    settledTone: string;
    settledLabel?: string | undefined;
    /** When the answer's mark lands; the reveal's end unless the block
        must hand its rows back before the message is over. */
    settleAtMs?: number | undefined;
    /** Overrides the block's own entrance, for a picker that also leaves. */
    animate?: AnimationSpec | undefined;
    rowMeta: (row: number) => Record<string, string>;
  },
): RenderedBlock {
  const { palette, metrics } = env;
  const { startMs, revealEndMs, message } = timing;
  const { width } = spec;
  const padX = 12;
  // The frame costs a row above and below, the way a box-drawing border does,
  // so the rows inside it stay on the same lattice as the rows outside.
  const padY = metrics.tuiLinePx;
  const innerWidth = sizeLeft(width, padX * 2);
  const questionText = `  ${spec.question}`;
  const questionLines = tuiStatusLineCount(env, questionText, innerWidth);
  const settleAtMs = spec.settleAtMs ?? revealEndMs;
  const rowFocus = caretWindows({ startMs, endMs: settleAtMs }, spec.rows.length, spec.chosen);
  const height = metrics.tuiLinePx * (3 + questionLines + spec.rows.length);
  return {
    node: Box(
      {
        width,
        height,
        padding: [padY, padX, padY, padX],
        borderRadius: 4,
        // The same width the window and composer carry: these are the same
        // kind of line, and the picker used to be the only one that grew with
        // the authored spacing.
        borderWidth: TUI_FRAME_STROKE_PX,
        // Both pickers come through here, so this is the choice frame and the
        // permission frame at once — the two the camera shimmer was reported
        // on. See the window and composer frames for the reasoning.
        strokeScaling: "canvas",
        borderColor: spec.tone,
        // A window's opacity applies to the whole surface, so no region of the
        // grid may be more solid than the terminal it sits in.
        background: hexToRgba(palette.panelSoft, messageSurfaceAlpha(env.project)),
        animate: spec.animate ?? tuiPop(startMs),
        // A standing block carries the edit handle; the transient panel
        // names its message another way, so it never registers as a block
        // in the transcript flow.
        ...(spec.animate ? { meta: { "picker-for": message.id } } : { meta: { edit: message.id } }),
      },
      Text(
        {
          position: "absolute",
          left: padX,
          top: padY,
          width: innerWidth,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: metrics.tuiFontPx,
          lineHeightPx: metrics.tuiLinePx,
          wrap: "none",
          color: spec.tone,
          textStrokes: [{ color: spec.tone, widthPx: 0.4 }],
        },
        spec.heading,
      ),
      Text(
        {
          position: "absolute",
          left: padX,
          top: padY + metrics.tuiLinePx,
          width: innerWidth,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: metrics.tuiFontPx,
          lineHeightPx: metrics.tuiLinePx,
          wrap: "char",
          color: palette.text,
        },
        questionText,
      ),
      ...spec.rows.flatMap((label, row) =>
        pickerRow(
          env,
          {
            left: padX,
            top: padY + metrics.tuiLinePx * (1 + questionLines + row),
            width: innerWidth,
          },
          {
            label,
            focus: rowFocus[row] ?? null,
            meta: spec.rowMeta(row),
            settle: {
              atMs: settleAtMs,
              mark: spec.settledMark,
              color: spec.settledTone,
              label: spec.settledLabel,
            },
          },
        ),
      ),
    ),
    estimatedHeight: height,
  };
}

/**
 * The TUI consent picker. Deny is option 3, not a relabelled option 1: the
 * caret has to walk down to it, which is the whole reason a denial reads
 * slower than an approval.
 */
function tuiPermissionPickerSpec(message: SessionMessage, env: SceneEnv, width: number) {
  const { palette } = env;
  const words = approvalWords(message.content);
  const denied = message.decision === "deny";
  return {
    width,
    tone: palette.warning,
    heading: words.required,
    question: message.content,
    rows: words.rows,
    chosen: denied ? 2 : message.decision === "allow-always" ? 1 : 0,
    settledMark: denied ? "\u2717" : "\u2713",
    settledTone: denied ? palette.danger : palette.success,
    rowMeta: (row: number) =>
      sceneActionMeta(row === 2 ? "deny" : row === 1 ? "approve-always" : "approve", {
        messageId: message.id,
      }),
  };
}

/**
 * The record a collapsed TUI permission keeps: the request in the faint
 * voice, the verdict on the settled mark — scrollback, not chrome.
 */
function tuiPermissionRecordBlock(
  timing: MessageTiming,
  env: SceneEnv,
  width: number,
): RenderedBlock {
  const { palette, metrics } = env;
  const { revealEndMs, message } = timing;
  const words = approvalWords(message.content);
  const denied = message.decision === "deny";
  const height = metrics.tuiLinePx * 2;
  const tone = denied ? palette.danger : palette.success;
  const line = (spec: { top: number; color: string; text: string; strokes?: boolean }): AnyVNode =>
    Text(
      {
        position: "absolute",
        left: 0,
        top: spec.top,
        width,
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: metrics.tuiFontPx,
        lineHeightPx: metrics.tuiLinePx,
        wrap: "none",
        color: spec.color,
        ...(spec.strokes ? { textStrokes: [{ color: spec.color, widthPx: 0.4 }] } : {}),
      },
      spec.text,
    );
  return {
    node: Box(
      {
        width,
        height,
        position: "relative",
        animate: visibilityWindow(Math.max(1, revealEndMs - 24), null, 16),
        meta: { edit: message.id },
      },
      line({ top: 0, color: palette.faint, text: message.content }),
      line({
        top: metrics.tuiLinePx,
        color: tone,
        text: `${denied ? "\u2717" : "\u2713"} ${denied ? words.denied : words.approved}`,
        strokes: true,
      }),
    ),
    estimatedHeight: height,
  };
}

/** The TUI consent picker: standing block (keep) or two-row record. */
function tuiPermissionMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  if (choiceCollapses(timing.message, env.project)) {
    return tuiPermissionRecordBlock(timing, env, width);
  }
  return tuiPickerBlock(timing, env, tuiPermissionPickerSpec(timing.message, env, width));
}

// ————————————————————————————————————————————————————————————————————————————
// Attachments. The app embeds the bitmap like a chat attachment; a terminal
// cannot render inline images, so the TUI prints an attachment stub line.
// ————————————————————————————————————————————————————————————————————————————

/** Banner height presets: "small" tucks in, "large" leads the bubble. */
const IMAGE_SIZE_FACTOR = { small: 0.6, standard: 1, large: 1.5 } as const;
/** Which band survives a "cover" crop. */
const IMAGE_FOCUS_POSITION = { top: "50% 0%", center: "50% 50%", bottom: "50% 100%" } as const;

/** The clamped banner height one attached image takes at this width. */
function attachedImageHeight(image: AttachedImage, width: number): number {
  const factor = IMAGE_SIZE_FACTOR[image.size ?? "standard"];
  const naturalHeight = (width * image.height) / image.width;
  // "contain" keeps the true aspect (capped) so nothing gets cropped;
  // "cover" fills a clamped banner height like a chat attachment.
  return (image.fit ?? "cover") === "contain"
    ? Math.min(420 * factor, Math.max(60, naturalHeight))
    : Math.min(280 * factor, Math.max(120 * factor, naturalHeight));
}

function appMessageImages(
  message: SessionMessage,
  {
    width,
    anchorMs,
    palette,
    metrics,
  }: { width: number; anchorMs: number; palette: ScenePalette; metrics: Metrics },
): { nodes: AnyVNode[]; height: number } | null {
  const images = message.images ?? [];
  if (images.length === 0) {
    return null;
  }
  let height = 0;
  const nodes = images.map((image, index) => {
    const bannerHeight = attachedImageHeight(image, width);
    // The card's own column gap separates the banners.
    height += bannerHeight;
    return Box(
      {
        width,
        height: bannerHeight,
        borderRadius: 10,
        borderWidth: strokePx(metrics),
        borderColor: palette.border,
        overflow: "clip",
        // Banners land one beat apart, like attachments finishing upload.
        animate: appEntrance(anchorMs + 160 + index * 90),
        meta: sceneActionMeta("replace-image", { messageId: message.id, imageIndex: index }),
      },
      Image({
        src: image.dataUrl,
        width,
        height: bannerHeight,
        objectFit: image.fit ?? "cover",
        objectPosition: IMAGE_FOCUS_POSITION[image.focus ?? "center"],
        borderRadius: 10,
        meta: { alt: image.alt },
      }),
    );
  });
  return { nodes, height };
}

function tuiAttachmentStub(
  message: SessionMessage,
  { anchorMs, env, width }: { anchorMs: number; env: SceneEnv; width: number },
): { node: AnyVNode; height: number } | null {
  const images = message.images ?? [];
  if (images.length === 0) {
    return null;
  }
  const { palette, metrics } = env;
  return {
    node: Flex(
      { direction: "column", width, gap: 0 },
      ...images.map((image, index) => {
        const label = image.alt.trim().length > 0 ? image.alt.trim() : "attachment";
        return Text(
          {
            width,
            font: MONO_FONT,
            fallback: MONO_FALLBACK,
            fontSizePx: metrics.tuiFontPx,
            lineHeightPx: metrics.tuiLinePx,
            wrap: "none",
            color: palette.faint,
            animate: tuiPop(anchorMs + 60 + index * 40),
            meta: sceneActionMeta("replace-image", { messageId: message.id, imageIndex: index }),
          },
          Inline({ color: palette.faint }, "[image] "),
          Inline({ color: palette.muted }, label),
          Inline(
            { color: palette.faint },
            ` · ${image.width}×${image.height}px (not rendered in terminal)`,
          ),
        );
      }),
    ),
    height: metrics.tuiLinePx * images.length,
  };
}

// ————————————————————————————————————————————————————————————————————————————
// Message rows
// ————————————————————————————————————————————————————————————————————————————

// ————————————————————————————————————————————————————————————————————————————
// Image generation — request accepted → generating (skeleton + rotating
// status phrases) → completion report with the produced image.
// ————————————————————————————————————————————————————————————————————————————

const GEN_PHRASES_JA = [
  "構図を決めています",
  "ディテールを描き込んでいます",
  "色と光を整えています",
  "仕上げています",
];
const GEN_PHRASES_EN = [
  "Blocking in the composition",
  "Adding fine detail",
  "Balancing color and light",
  "Finishing touches",
];

function hasCjk(text: string): boolean {
  return /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/u.test(text);
}

type PhraseSlot = { text: string; inMs: number; slotMs: number };

/**
 * Rotating status phrases across the generating window keep the wait
 * legible instead of frozen. Slots divide the window evenly; phrases
 * cycle when the window outlasts the list.
 */
function genPhraseSlots(startMs: number, endMs: number, cjk: boolean): PhraseSlot[] {
  const phrases = cjk ? GEN_PHRASES_JA : GEN_PHRASES_EN;
  const span = Math.max(600, endMs - startMs);
  const count = Math.max(1, Math.min(6, Math.floor(span / 1_300)));
  const slotMs = span / count;
  return Array.from({ length: count }, (_unused, index) => ({
    text: `${phrases[index % phrases.length] ?? ""}…`,
    inMs: startMs + index * slotMs,
    slotMs,
  }));
}

/**
 * One rotating phrase: each character rides the same wave — rises in
 * left-to-right, holds, then dissolves left-to-right as the wave leaves,
 * making room for the next phrase.
 */
function phraseWaveText(
  slot: PhraseSlot,
  { fontPx, color }: { fontPx: number; color: string },
): AnyVNode {
  const characters = Math.max(1, Array.from(slot.text).length);
  const stepMs = Math.min(18, 360 / characters);
  const tailMs = stepMs * characters;
  const specMs = Math.max(420, slot.slotMs - tailMs - 60);
  return Text(
    {
      position: "absolute",
      left: 0,
      top: 0,
      font: SANS_FONT,
      fallback: SANS_FALLBACK,
      fontSizePx: fontPx,
      color,
      wrap: "none",
      animateUnits: {
        by: "cluster",
        animation: {
          keyframes: [
            { at: 0, opacity: 0, transform: { translateY: 5 } },
            { at: 0.1, opacity: 1, transform: { translateY: 0 } },
            { at: 0.85, opacity: 1, transform: { translateY: 0 } },
            { at: 0.97, opacity: 0, transform: { translateY: -5 } },
            { at: 1, opacity: 0, transform: { translateY: -5 } },
          ],
          durationMs: specMs,
          delayMs: slot.inMs,
          easing: "ease-out",
          fill: "both",
        },
        delayStepMs: stepMs,
        order: "logical",
      },
    },
    slot.text,
  );
}

/**
 * Dot-wave skeleton: a fine lattice of small dots whose size itself
 * swells and shrinks as a diagonal wave passes — the motion reads as the
 * image condensing rather than a loading blink.
 */
function dotWaveNodes(boxW: number, boxH: number, color: string): AnyVNode[] {
  const cols = 15;
  const rows = 9;
  const cellW = boxW / (cols + 1);
  const cellH = boxH / (rows + 1);
  const nodes: AnyVNode[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      // Static size bias along the same diagonal the wave travels: dots
      // grow toward the lower right, so even a frozen frame has depth.
      const diagonal = (col / (cols - 1) + row / (rows - 1)) / 2;
      const dot = 2.5 + diagonal * 3;
      nodes.push(
        Box({
          position: "absolute",
          left: Math.round(cellW * (col + 1) - dot / 2),
          top: Math.round(cellH * (row + 1) - dot / 2),
          width: dot,
          height: dot,
          borderRadius: dot / 2,
          background: color,
          animate: {
            keyframes: [
              { at: 0, opacity: 0.2, transform: { scaleX: 0.5, scaleY: 0.5 } },
              { at: 0.35, opacity: 0.95, transform: { scaleX: 1.8, scaleY: 1.8 } },
              { at: 0.7, opacity: 0.2, transform: { scaleX: 0.5, scaleY: 0.5 } },
              { at: 1, opacity: 0.2, transform: { scaleX: 0.5, scaleY: 0.5 } },
            ],
            durationMs: 1_500,
            delayMs: col * 55 + row * 40,
            easing: "ease-in-out",
            iterations: "infinite",
          },
        }),
      );
    }
  }
  return nodes;
}

/** Sweep skeleton: a bright band sweeping diagonally, forever. */
function sweepNodes(boxW: number, boxH: number, accent: string): AnyVNode[] {
  return [
    Box({
      position: "absolute",
      left: 0,
      top: 0,
      width: boxW,
      height: boxH,
      background: `linear-gradient(160deg, ${hexToRgba(accent, 0.16)} 0%, ${hexToRgba(accent, 0.05)} 55%, ${hexToRgba(accent, 0.14)} 100%)`,
    }),
    Box({
      position: "absolute",
      left: -boxW,
      top: 0,
      width: boxW,
      height: boxH,
      background:
        "linear-gradient(115deg, rgba(255,255,255,0) 38%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0) 62%)",
      // The return trip is written into the cycle: the band travels back
      // while fully transparent, off canvas at both ends. A track that ends
      // away from where it began is a jump at every iteration boundary, and
      // the animated SVG's document timeline refuses to compile that jump —
      // the cycle's endpoints have to hold the same values.
      animate: {
        keyframes: [
          { at: 0, opacity: 1, transform: { translateX: 0 } },
          { at: 0.94, opacity: 1, transform: { translateX: boxW * 3 } },
          { at: 0.95, opacity: 0, transform: { translateX: boxW * 3 } },
          { at: 0.99, opacity: 0, transform: { translateX: 0 } },
          { at: 1, opacity: 1, transform: { translateX: 0 } },
        ],
        durationMs: 1_700,
        easing: "ease-in-out",
        iterations: "infinite",
      },
    }),
  ];
}

/** Soft mosaic skeleton: rounded tiles breathing on offset phases. */
function tileWaveNodes(boxW: number, boxH: number, color: string): AnyVNode[] {
  const cols = 8;
  const rows = 5;
  const cellW = boxW / cols;
  const cellH = boxH / rows;
  const nodes: AnyVNode[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      nodes.push(
        Box({
          position: "absolute",
          left: Math.round(cellW * col + cellW * 0.14),
          top: Math.round(cellH * row + cellH * 0.14),
          width: Math.round(cellW * 0.72),
          height: Math.round(cellH * 0.72),
          borderRadius: 5,
          background: color,
          animate: {
            keyframes: [
              { at: 0, opacity: 0.1, transform: { scaleX: 0.9, scaleY: 0.9 } },
              { at: 0.4, opacity: 0.42, transform: { scaleX: 1.03, scaleY: 1.03 } },
              { at: 0.8, opacity: 0.1, transform: { scaleX: 0.9, scaleY: 0.9 } },
              { at: 1, opacity: 0.1, transform: { scaleX: 0.9, scaleY: 0.9 } },
            ],
            durationMs: 1_600,
            delayMs: ((col * 7 + row * 13) % 9) * 150,
            easing: "ease-in-out",
            iterations: "infinite",
          },
        }),
      );
    }
  }
  return nodes;
}

function skeletonNodes(env: SceneEnv, { boxW, boxH }: { boxW: number; boxH: number }): AnyVNode[] {
  const { palette, project } = env;
  switch (project.appearance.imageSkeleton) {
    case "sweep":
      return sweepNodes(boxW, boxH, palette.accent);
    case "tiles":
      return tileWaveNodes(boxW, boxH, palette.muted);
    default:
      return dotWaveNodes(boxW, boxH, palette.muted);
  }
}

/** Runtime-owned fallback when a generated result is not attached. */
function generatedPlaceholderNodes(
  image: SceneEnv["fallbackImage"],
  boxW: number,
  boxH: number,
): AnyVNode[] {
  if (image === undefined) {
    return [];
  }
  return [
    Image({
      src: image.dataUrl,
      width: boxW,
      height: boxH,
      objectFit: "cover",
      objectPosition: "center",
      meta: { alt: image.alt },
    }),
  ];
}

function appImageMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics, project } = env;
  const { message, startMs, revealEndMs } = timing;
  const cjk = hasCjk(message.content);
  const cardW = Math.min(width, APP_IMAGE_CARD_MAX_W_PX);
  const boxW = cardW - 30;
  const boxH = Math.max(140, Math.min(300, Math.round(boxW * 0.66)));
  const headerZone = Math.max(24, metrics.uiPx + 10);
  const phraseZone = Math.max(20, metrics.uiPx + 8);
  const generatingLabel = cjk ? "画像を生成しています" : "Generating image";
  const doneLabel = cjk ? "画像を生成しました" : "Image generated";
  const caption = message.content.trim();
  const headerRow = (options: {
    visible: AnimationSpec;
    icon: AnyVNode;
    label: string;
    detail?: string;
  }): AnyVNode =>
    Flex(
      {
        position: "absolute",
        left: 0,
        top: 0,
        width: boxW,
        height: headerZone,
        direction: "row",
        gap: 9,
        alignItems: "center",
        animate: options.visible,
      },
      options.icon,
      Text(
        {
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: metrics.uiPx,
          color: palette.muted,
          wrap: "none",
        },
        options.label,
      ),
      ...(options.detail !== undefined
        ? [
            Text(
              {
                font: MONO_FONT,
                fallback: MONO_FALLBACK,
                fontSizePx: Math.max(9, metrics.uiPx - 2),
                color: palette.faint,
                wrap: "none",
              },
              options.detail,
            ),
          ]
        : []),
    );
  const card = Flex(
    {
      direction: "column",
      width: cardW,
      padding: [12, 15, 13, 15],
      gap: 8,
      borderRadius: 12,
      background: hexToRgba(palette.panelStrong, messageSurfaceAlpha(project)),
      borderWidth: strokePx(metrics),
      borderColor: palette.border,
      animate: appEntrance(startMs),
    },
    // Header band: generating spinner ↔ completion report.
    Box(
      { position: "relative", width: boxW, height: headerZone },
      headerRow({
        visible: visibilityWindow(startMs, revealEndMs, 160),
        icon: appSpinnerRing(palette.accent, appStatusIconSize(metrics.uiPx).boxPx, revealEndMs),
        label: `${generatingLabel}…`,
      }),
      headerRow({
        visible: visibilityWindow(revealEndMs, null, 200),
        icon: Text(
          {
            font: MONO_FONT,
            fallback: MONO_FALLBACK,
            fontSizePx: metrics.uiPx,
            color: palette.success,
            wrap: "none",
          },
          "✓",
        ),
        label: doneLabel,
        detail: secondsLabel(project.timing.imageGenMs),
      }),
    ),
    // Rotating status phrases while the skeleton runs; the zone stays
    // reserved afterwards so the card never changes height mid-scene.
    Box(
      { position: "relative", width: boxW, height: phraseZone },
      ...genPhraseSlots(startMs, revealEndMs, cjk).map((slot) =>
        phraseWaveText(slot, { fontPx: Math.max(10, metrics.uiPx - 1), color: palette.faint }),
      ),
    ),
    // Image band: dot-wave skeleton ↔ produced image (or placeholder art).
    Box(
      {
        position: "relative",
        width: boxW,
        height: boxH,
        borderRadius: 10,
        overflow: "clip",
        borderWidth: strokePx(metrics),
        borderColor: palette.border,
        background: hexToRgba(palette.panelSoft, messageSurfaceAlpha(project)),
        meta: sceneActionMeta("replace-image", { messageId: message.id }),
      },
      Box(
        {
          position: "absolute",
          left: 0,
          top: 0,
          width: boxW,
          height: boxH,
          animate: visibilityWindow(startMs, revealEndMs, 200),
        },
        ...skeletonNodes(env, { boxW, boxH }),
      ),
      Box(
        {
          position: "absolute",
          left: 0,
          top: 0,
          width: boxW,
          height: boxH,
          animate: visibilityWindow(revealEndMs, null, 260),
        },
        ...(message.images?.[0]
          ? [
              Image({
                src: message.images[0].dataUrl,
                width: boxW,
                height: boxH,
                objectFit: "cover",
                objectPosition: "center",
                meta: { alt: message.images[0].alt },
              }),
            ]
          : generatedPlaceholderNodes(env.fallbackImage, boxW, boxH)),
      ),
    ),
    // The prompt as a caption, like real image tools echo it back.
    Text(
      {
        width: boxW,
        font: SANS_FONT,
        fallback: SANS_FALLBACK,
        fontSizePx: Math.max(10, metrics.uiPx - 1),
        lineHeightPx: Math.max(14, metrics.uiPx + 4),
        color: palette.faint,
        wrap: "word",
      },
      caption,
    ),
  );
  const captionLines = Math.max(
    1,
    Math.ceil(estimateTextWidthPx(caption, Math.max(10, metrics.uiPx - 1)) / boxW),
  );
  return {
    node: card,
    estimatedHeight:
      headerZone + phraseZone + boxH + captionLines * Math.max(14, metrics.uiPx + 4) + 49,
  };
}

const TUI_SHIMMER_ROWS = [
  "▒▓░▒▓▒░▓▒░▒▓░▒▓▒░▓▒░▒▓░▒▓▒░▓▒░▒▓░▒▓",
  "░▒▓▒░▓▒▒▓░▒▓▒░▓▒▒▓░▒▓▒░▓▒▒▓░▒▓▒░▓▒▒",
  "▓░▒▓▒░▓░▒▓▒▒░▓▒░▓░▒▓▒▒░▓▒░▓░▒▓▒▒░▓▒",
];

function tuiImageMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics, project } = env;
  const { message, startMs, revealEndMs } = timing;
  const cjk = hasCjk(message.content);
  const cols = Math.max(12, Math.min(36, Math.floor((width - 24) / metrics.tuiCharPx)));
  const blockRows = TUI_SHIMMER_ROWS.length;
  const line = (top: number, children: AnyVNode[], animate?: AnimationSpec): AnyVNode =>
    Flex(
      {
        position: "absolute",
        left: 0,
        top,
        width,
        height: metrics.tuiLinePx,
        direction: "row",
        gap: Math.ceil(metrics.tuiCharPx),
        alignItems: "center",
        ...(animate ? { animate } : {}),
      },
      ...children,
    );
  const mono = (text: string, color: string): AnyVNode =>
    Text(
      {
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: metrics.tuiFontPx,
        lineHeightPx: metrics.tuiLinePx,
        color,
        wrap: "none",
      },
      text,
    );
  const phraseTop = metrics.tuiLinePx;
  const blockTop = metrics.tuiLinePx * 2;
  const totalRows = 2 + blockRows;
  return {
    node: Box(
      {
        width,
        height: metrics.tuiLinePx * totalRows,
        position: "relative",
        animate: tuiPop(startMs),
        meta: {
          edit: message.id,
          ...sceneActionMeta("replace-image", { messageId: message.id }),
        },
      },
      // 1. request line — the agent echoes the accepted prompt.
      line(0, [mono("◆", palette.accent), mono(`image · ${message.content}`, palette.text)]),
      // 2. status line: spinner + rotating phrase, then the completion report.
      Box(
        {
          position: "absolute",
          left: 0,
          top: phraseTop,
          width,
          height: metrics.tuiLinePx,
          animate: visibilityWindow(startMs, revealEndMs, 60),
        },
        line(0, [
          tuiSpinner(env, {
            frames: ["|", "/", "-", "\\"],
            color: palette.warning,
            cycleMs: 520,
          }),
          ...genPhraseSlots(startMs, revealEndMs, cjk).map((slot) =>
            Text(
              {
                position: "absolute",
                left: Math.ceil(metrics.tuiCharPx * 2),
                top: 0,
                font: MONO_FONT,
                fallback: MONO_FALLBACK,
                fontSizePx: metrics.tuiFontPx,
                lineHeightPx: metrics.tuiLinePx,
                color: palette.muted,
                wrap: "none",
                animate: visibilityWindow(slot.inMs, slot.inMs + slot.slotMs, 40),
              },
              slot.text,
            ),
          ),
        ]),
      ),
      Box(
        {
          position: "absolute",
          left: 0,
          top: phraseTop,
          width,
          height: metrics.tuiLinePx,
          animate: visibilityWindow(revealEndMs, null, 60),
        },
        line(0, [
          mono("✓", palette.success),
          mono(
            `${cjk ? "生成完了" : "generated"} · ${secondsLabel(project.timing.imageGenMs)}`,
            palette.muted,
          ),
        ]),
      ),
      // 3-5. character-cell shimmer while generating, a saved-file report after.
      Box(
        {
          position: "absolute",
          left: 0,
          top: blockTop,
          width,
          height: metrics.tuiLinePx * blockRows,
          animate: visibilityWindow(startMs, revealEndMs, 100),
        },
        ...TUI_SHIMMER_ROWS.map((row, rowIndex) =>
          Text(
            {
              position: "absolute",
              left: Math.ceil(metrics.tuiCharPx * 2),
              top: metrics.tuiLinePx * rowIndex,
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx: metrics.tuiFontPx,
              lineHeightPx: metrics.tuiLinePx,
              color: palette.accent,
              wrap: "none",
              animateUnits: {
                by: "cluster",
                animation: {
                  keyframes: [
                    { at: 0, opacity: 0.12 },
                    { at: 0.4, opacity: 0.8 },
                    { at: 0.8, opacity: 0.12 },
                    { at: 1, opacity: 0.12 },
                  ],
                  durationMs: 1_400,
                  delayMs: startMs + rowIndex * 180,
                  easing: "ease-in-out",
                  iterations: "infinite",
                },
                delayStepMs: 45,
                order: "logical",
              },
            },
            row.slice(0, cols),
          ),
        ),
      ),
      Box(
        {
          position: "absolute",
          left: 0,
          top: blockTop,
          width,
          height: metrics.tuiLinePx * blockRows,
          animate: visibilityWindow(revealEndMs, null, 100),
        },
        line(0, [
          // The saved-file line states only what the script actually carries:
          // the attached image's real pixel size and format, or bare "png".
          mono(
            `└ ${
              message.images?.[0]
                ? `${message.images[0].width}×${message.images[0].height} ${message.images[0].mediaType.slice("image/".length)}`
                : "png"
            } ${cjk ? "を書き出しました" : "written"}`,
            palette.faint,
          ),
        ]),
        ...(message.images?.[0]
          ? [
              line(metrics.tuiLinePx, [
                mono(`  ${message.images[0].alt || "image"}`, palette.faint),
              ]),
            ]
          : []),
      ),
    ),
    estimatedHeight: metrics.tuiLinePx * totalRows,
  };
}

/**
 * The option menu, inline in the conversation the way a chat app asks.
 * The rows stay put after the answer — the chosen one keeps its highlight
 * and gains a check, the rest fade back — so the card never changes size.
 */
/** The choice card's vertical layout, shared with the camera's close-up. */
/**
 * A freeform answer as it is read, not as it was keyed. The staged spans a
 * user line can carry — an IME conversion, a completion — belong to the
 * typing at the prompt; what the transcript keeps is the finished sentence.
 */
function freeformAnswer(message: SessionMessage): string {
  return stripDraftMarkup(message.freeform ?? "").trim();
}

/**
 * The row a choice card marks: the picked option, or the freeform row when the
 * answer was typed. Stated once — the card, the terminal spec and the clamp
 * that keeps the mark on screen all read it. Three separate guesses at this is
 * what the picker clamp kept tripping over.
 */
function markedChoiceRow(message: SessionMessage): number {
  const options = message.options ?? [];
  if (freeformAnswer(message).length > 0 || options.length === 0) {
    return options.length;
  }
  return Math.max(0, Math.min(options.length - 1, message.chosenIndex ?? 0));
}

function choiceCardLayout(message: SessionMessage, env: SceneEnv) {
  const { metrics } = env;
  const options = message.options ?? [];
  const labelPx = Math.max(12, metrics.uiPx);
  const hintPx = Math.max(10, metrics.uiPx - 2);
  const rowPx = labelPx + hintPx + 16;
  const headerPx = metrics.metaPx;
  const promptTop = 11 + headerPx + 8;
  const listTop = promptTop + metrics.proseLinePx + 8;
  const freeformTop = listTop + options.length * rowPx + 2;
  const height = freeformTop + rowPx + 12;
  return { labelPx, hintPx, rowPx, headerPx, promptTop, listTop, freeformTop, height };
}

/**
 * The options block inside a choice card, relative to the card's top —
 * where the camera leans in when the pick commits.
 */
export function appChoiceOptionsRegion(
  message: SessionMessage,
  env: SceneEnv,
): { topOffset: number; height: number } {
  const layout = choiceCardLayout(message, env);
  return { topOffset: layout.listTop, height: layout.height - layout.listTop };
}

/**
 * Whether a choice retires its menu once the pick lands. The default; a
 * script may pin `afterSelection: "keep"`, and a scene without a composer
 * has nowhere to hold the transient picker, so it keeps the box too.
 */
export function choiceCollapses(message: SessionMessage, project: SvgentProject): boolean {
  return message.afterSelection !== "keep" && project.display.composer;
}

/**
 * The record a collapsed choice leaves in the transcript: the question in a
 * quiet voice, then the answer under the same check the picker settled on —
 * the permission result's idiom, one surface over.
 */
function appChoiceRecordBlock(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics, project } = env;
  const { startMs, message } = timing;
  const options = message.options ?? [];
  const freeform = freeformAnswer(message);
  const answeredFree = freeform.length > 0;
  const chosen = Math.max(0, Math.min(options.length - 1, message.chosenIndex ?? 0));
  const decideMs = startMs + project.timing.permissionMs;
  const labelPx = Math.max(12, metrics.uiPx);
  const hintPx = Math.max(10, metrics.uiPx - 2);
  // Explicit line boxes: at large font scales a default line height paints
  // past the block's reserved rows.
  const labelLinePx = Math.round(labelPx * 1.5);
  const hintLinePx = Math.round(hintPx * 1.5);
  const markGapPx = labelPx + 8;
  const answer = answeredFree ? freeform : parseOption(options[chosen] ?? "").label;
  const height = 8 + hintLinePx + 4 + labelLinePx + 8;
  // A pick is recorded as the picker hands the frame back. A typed answer
  // is not settled until it is sent, so its record waits for the send
  // rather than printing the finished sentence over the typing.
  const draft = choiceDraftTiming(timing, project);
  const recordedMs = Math.min(timing.settledMs, draft ? draft.settledMs + 70 : decideMs + 160);
  // The question is answered as soon as the picker closes, so the record
  // takes its place immediately and keeps the reader oriented while the
  // answer is typed; only the answer line waits for the send.
  const reveal = visibilityWindow(draft ? draft.startMs + 160 : recordedMs, null, 200);
  const answerReveal = visibilityWindow(recordedMs, null, 200);
  return {
    node: Box(
      { width, height, position: "relative", animate: reveal, meta: { edit: message.id } },
      Text(
        {
          position: "absolute",
          left: 2,
          top: 8,
          width: sizeLeft(width, 4),
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: hintPx,
          lineHeightPx: hintLinePx,
          color: palette.faint,
          wrap: "none",
          maxLines: 1,
          ellipsis: true,
        },
        message.content,
      ),
      Text(
        {
          position: "absolute",
          left: 2,
          top: 8 + hintLinePx + 4,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: labelPx,
          lineHeightPx: labelLinePx,
          color: palette.accent,
          wrap: "none",
          ...(answeredFree ? { animate: answerReveal } : {}),
        },
        answeredFree ? ">" : "✓",
      ),
      Text(
        {
          position: "absolute",
          left: 2 + markGapPx,
          top: 8 + hintLinePx + 4,
          width: sizeLeft(width, markGapPx, 4),
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: labelPx,
          lineHeightPx: labelLinePx,
          color: palette.muted,
          wrap: "none",
          maxLines: 1,
          ellipsis: true,
          ...(answeredFree ? { animate: answerReveal } : {}),
        },
        answer,
      ),
    ),
    estimatedHeight: height,
  };
}

function appChoiceMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  if (choiceCollapses(timing.message, env.project)) {
    return appChoiceRecordBlock(timing, env, width);
  }
  return appChoiceCard(timing, env, {
    width,
    animate: appEntrance(timing.startMs),
    editMeta: true,
  });
}

/**
 * The full option card, drawn either as a standing transcript block (keep)
 * or as the composer's grown frame while the pick is live (collapse).
 */
function appChoiceCard(
  timing: MessageTiming,
  env: SceneEnv,
  mode: { width: number; animate: AnimationSpec; editMeta: boolean },
): RenderedBlock {
  const { palette, metrics, project } = env;
  const { startMs, message } = timing;
  const { width } = mode;
  const options = message.options ?? [];
  const freeform = freeformAnswer(message);
  const cjk = hasCjk(message.content);
  const chosen = markedChoiceRow(message);
  const decideMs = startMs + project.timing.permissionMs;
  // A typed answer settles on its send; a pick settles as it is made.
  const answerDraft = choiceDraftTiming(timing, project);
  const settledAnswerMs = (answerDraft?.settledMs ?? decideMs) + 70;
  const { labelPx, hintPx, rowPx, headerPx, promptTop, listTop, freeformTop, height } =
    choiceCardLayout(message, env);
  const answeredFree = freeform.length > 0;
  // The commit is a short event at decideMs, not a state the card is born
  // in: every row starts neutral, so the answer is not given away while the
  // reader is still reading. The motion is deliberately barely there — the
  // highlight arriving is the signal, and a row that scales far (or on one
  // axis, which stretches its own glyphs) reads as a cartoon.
  const pressLift: AnimationSpec = {
    keyframes: [
      { at: 0, transform: { scaleX: 1, scaleY: 1 } },
      { at: 0.4, transform: { scaleX: 0.992, scaleY: 0.992 } },
      { at: 1, transform: { scaleX: 1, scaleY: 1 } },
    ],
    durationMs: 160,
    delayMs: decideMs,
    easing: "ease-out",
    fill: "both",
  };
  const settleIn: AnimationSpec = {
    keyframes: [
      { at: 0, opacity: 0 },
      { at: 1, opacity: 1 },
    ],
    durationMs: 120,
    delayMs: decideMs,
    easing: "ease-out",
    fill: "both",
  };
  // The rows not taken step back rather than vanish — the reader can still
  // see what was on offer.
  const settleOut: AnimationSpec = {
    keyframes: [
      { at: 0, opacity: 1 },
      { at: 1, opacity: 0.62 },
    ],
    durationMs: 160,
    delayMs: decideMs,
    easing: "ease-out",
    fill: "both",
  };
  const selectedBaseOut: AnimationSpec = {
    keyframes: [
      { at: 0, opacity: 1 },
      { at: 1, opacity: 0 },
    ],
    durationMs: 120,
    delayMs: decideMs,
    easing: "ease-out",
    fill: "both",
  };
  const row = (spec: {
    top: number;
    marker: string;
    label: string;
    hint: string;
    active: boolean;
    check?: boolean;
    settled?: { text: string; atMs: number } | undefined;
    meta: Record<string, string>;
  }): AnyVNode => {
    const rowWidth = sizeLeft(width, 22);
    const rowHeight = sizeLeft(rowPx, 3);
    return Box(
      {
        position: "absolute",
        left: 11,
        top: spec.top,
        width: rowWidth,
        height: rowHeight,
        borderRadius: 8,
        ...(spec.active ? { animate: pressLift } : { animate: settleOut }),
        meta: spec.meta,
      },
      // Its own layer, painted first, so the highlight can fade in at the
      // press without the label fading with it.
      ...(spec.active
        ? [
            Box({
              position: "absolute",
              left: 0,
              top: 0,
              width: rowWidth,
              height: rowHeight,
              borderRadius: 8,
              background: hexToRgba(palette.accent, 0.16),
              borderWidth: strokePx(metrics),
              borderColor: palette.accent,
              animate: settleIn,
            }),
          ]
        : []),
      Text(
        {
          position: "absolute",
          left: 10,
          top: 6,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: labelPx,
          color: palette.faint,
          wrap: "none",
          ...(spec.check ? { animate: selectedBaseOut } : {}),
        },
        spec.marker,
      ),
      ...(spec.check
        ? [
            Text(
              {
                position: "absolute",
                left: 10,
                top: 6,
                font: MONO_FONT,
                fallback: MONO_FALLBACK,
                fontSizePx: labelPx,
                color: palette.accent,
                wrap: "none",
                animate: settleIn,
              },
              "\u2713",
            ),
          ]
        : []),
      Text(
        {
          position: "absolute",
          left: 34,
          top: 5,
          width: sizeLeft(width, 70),
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: labelPx,
          color: palette.muted,
          wrap: "none",
          maxLines: 1,
          ellipsis: true,
          ...(spec.active ? { animate: selectedBaseOut } : {}),
        },
        spec.label,
      ),
      ...(spec.active
        ? [
            Text(
              {
                position: "absolute",
                left: 34,
                top: 5,
                width: sizeLeft(width, 70),
                font: SANS_FONT,
                fallback: SANS_FALLBACK,
                fontSizePx: labelPx,
                color: palette.text,
                wrap: "none",
                maxLines: 1,
                ellipsis: true,
                animate: spec.settled ? visibilityWindow(spec.settled.atMs, null, 120) : settleIn,
              },
              spec.settled ? spec.settled.text : spec.label,
            ),
          ]
        : []),
      ...(spec.hint.length > 0
        ? [
            Text(
              {
                position: "absolute",
                left: 34,
                top: 5 + labelPx + 4,
                width: sizeLeft(width, 70),
                font: SANS_FONT,
                fallback: SANS_FALLBACK,
                fontSizePx: hintPx,
                color: palette.faint,
                wrap: "none",
                maxLines: 1,
                ellipsis: true,
              },
              spec.hint,
            ),
          ]
        : []),
    );
  };
  return {
    node: Box(
      {
        width,
        // Grown out of the composer, the card reserves room under its rows
        // for the frame's own control strip; in the transcript the pad is 0.
        height,
        position: "relative",
        borderRadius: 12,
        borderWidth: strokePx(metrics),
        borderColor: palette.accent,
        background: hexToRgba(palette.panelStrong, messageSurfaceAlpha(project)),
        animate: mode.animate,
        ...(mode.editMeta ? { meta: { edit: message.id } } : {}),
      },
      Text(
        {
          position: "absolute",
          left: 15,
          top: 11,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: headerPx,
          color: palette.accent,
          letterSpacingPx: 0.8,
          wrap: "none",
        },
        cjk ? "選択してください" : "SELECT AN OPTION",
      ),
      Text(
        {
          position: "absolute",
          left: 15,
          top: promptTop,
          width: sizeLeft(width, 30),
          font: SANS_FONT,
          fallback: SANS_FALLBACK,
          fontSizePx: metrics.prosePx,
          lineHeightPx: metrics.proseLinePx,
          color: palette.text,
          wrap: "char",
          maxLines: 1,
          ellipsis: true,
        },
        message.content,
      ),
      ...options.map((raw, index) => {
        const { label, hint } = parseOption(raw);
        const active = !answeredFree && index === chosen;
        return row({
          top: listTop + index * rowPx,
          marker: `${index + 1}.`,
          label,
          hint,
          active,
          check: active,
          meta: sceneActionMeta("select-choice", {
            messageId: message.id,
            optionIndex: index,
          }),
        });
      }),
      row({
        top: freeformTop,
        marker: ">",
        label: cjk ? "自分で書く" : "Write your own",
        hint: "",
        active: answeredFree,
        // The answer is typed at the composer, so the row shows it only
        // once it has been sent — the card records, it does not compose.
        ...(answeredFree ? { settled: { text: freeform, atMs: settledAnswerMs } } : {}),
        meta: sceneActionMeta("write-choice", { messageId: message.id }),
      }),
    ),
    estimatedHeight: height,
  };
}

/**
 * When a picker stops holding the frame. A pick answers on the spot, so the
 * card stays until its own tail. "Write your own" hands the keyboard back:
 * the card closes on the pick and the answer is typed at the composer, the
 * way a real selector does it — its rows take keys for selection, not prose.
 */
export function pickerCloseMs(
  timing: MessageTiming,
  project: SvgentProject,
  /** The surface's own tail, used when the pick answers on the spot. */
  fallbackMs = timing.revealEndMs - 160,
): number {
  const draft = choiceDraftTiming(timing, project);
  return Math.max(
    timing.startMs + 1,
    draft ? timing.startMs + project.timing.permissionMs : fallbackMs,
  );
}

/**
 * The picker as the composer's grown frame: the same card, shown only while
 * the pick is live. The record it leaves behind is appChoiceRecordBlock's.
 */
/**
 * How much of a clamped picker's head the window takes. The card scrolls just
 * far enough to keep its answer row on screen and no further, so the heading
 * and the question go first — the transcript prints both again — while the row
 * carrying the mark stays. Anchoring to either edge instead drops the answer
 * off one end or the other, which is what the two rounds before this one did.
 */
export function pickerCutTop(panel: { height: number; keepBottom: number }, shown: number): number {
  return Math.max(0, Math.min(panel.height - shown, Math.ceil(panel.keepBottom - shown)));
}

/** How long the app's picker card takes to fade in over the composer. */
export const PICKER_FADE_MS = 160;

/**
 * The lowest point in a picker card that has to stay on screen when the card
 * is taller than the window. A long selector scrolls to its answer the way a
 * terminal menu follows its cursor; anchoring the card to either edge instead
 * loses the chosen row from one end or the other. A permission card has no
 * chosen row — its decision sits at the very bottom.
 */
function pickerKeepBottom(message: SessionMessage, env: SceneEnv, height: number): number {
  if (message.role !== "choice") {
    return height;
  }
  const layout = choiceCardLayout(message, env);
  const marked = markedChoiceRow(message);
  return marked < (message.options ?? []).length
    ? layout.listTop + (marked + 1) * layout.rowPx
    : layout.freeformTop + layout.rowPx;
}

export function appPickerComposerPanel(
  timing: MessageTiming,
  env: SceneEnv,
  spec: { width: number },
): { node: AnyVNode; height: number; keepBottom: number } {
  // The window ends inside the message's own tail, so even at zero pacing
  // no keyframe outlives the scene.
  const shown = visibilityWindow(
    timing.startMs,
    pickerCloseMs(timing, env.project, timing.revealEndMs - PICKER_FADE_MS),
    PICKER_FADE_MS,
  );
  const build = timing.message.role === "permission" ? appPermissionCard : appChoiceCard;
  const card = build(timing, env, {
    width: spec.width,
    animate: shown,
    editMeta: false,
  });
  return {
    node: card.node,
    height: card.estimatedHeight,
    keepBottom: pickerKeepBottom(timing.message, env, card.estimatedHeight),
  };
}

/** The picker spec both TUI forms share: the standing block and the panel. */
function tuiChoicePickerSpec(
  message: SessionMessage,
  env: SceneEnv,
  /**
   * `keepsAnswer`: whether these rows are the message's lasting record. A
   * standing card is all the transcript keeps, so it holds the answer. The
   * transient panel hands the keyboard to the prompt and lets the record
   * block hold it.
   */
  spec: { width: number; keepsAnswer?: boolean },
) {
  const { width } = spec;
  const keepsAnswer = spec.keepsAnswer !== false;
  const { palette } = env;
  const words = approvalWords(message.content);
  const options = message.options ?? [];
  const freeform = freeformAnswer(message);
  const answeredFree = freeform.length > 0;
  // The freeform row is the last one, exactly as in the app card.
  const rows = [
    ...options.map((raw, index) => `${index + 1}. ${parseOption(raw).label}`),
    `${options.length + 1}. ${words.writeOwn}`,
  ];
  return {
    width,
    tone: palette.accent,
    heading: words.selectHeading,
    question: message.content,
    rows,
    chosen: markedChoiceRow(message),
    settledMark: answeredFree ? ">" : "✓",
    settledTone: palette.success,
    ...(answeredFree && keepsAnswer ? { settledLabel: freeform } : {}),
    rowMeta: (row: number) =>
      row < options.length
        ? sceneActionMeta("select-choice", { messageId: message.id, optionIndex: row })
        : sceneActionMeta("write-choice", { messageId: message.id }),
  };
}

/**
 * The record a collapsed TUI choice keeps: the question in the faint voice
 * and the answer on the settled mark — two rows on the lattice, exactly
 * what a terminal's scrollback would hold once a selector closes.
 */
function tuiChoiceRecordBlock(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics, project } = env;
  const { revealEndMs, message } = timing;
  const options = message.options ?? [];
  const freeform = freeformAnswer(message);
  const answeredFree = freeform.length > 0;
  const chosen = Math.max(0, Math.min(options.length - 1, message.chosenIndex ?? 0));
  const answer = answeredFree ? freeform : parseOption(options[chosen] ?? "").label;
  const height = metrics.tuiLinePx * 2;
  const line = (spec: {
    top: number;
    color: string;
    text: string;
    strokes?: boolean;
    animate?: AnimationSpec;
  }): AnyVNode =>
    Text(
      {
        position: "absolute",
        left: 0,
        top: spec.top,
        width,
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: metrics.tuiFontPx,
        lineHeightPx: metrics.tuiLinePx,
        wrap: "none",
        color: spec.color,
        ...(spec.strokes ? { textStrokes: [{ color: spec.color, widthPx: 0.4 }] } : {}),
        ...(spec.animate ? { animate: spec.animate } : {}),
      },
      spec.text,
    );
  // A typed answer is composed at the prompt, so the question takes the
  // picker's place as soon as it closes and the answered line waits for the
  // send — the scrollback never shows a sentence before it was entered.
  const draft = choiceDraftTiming(timing, project);
  const questionAtMs = Math.max(1, draft ? draft.startMs : revealEndMs - 24);
  const answerAtMs = Math.max(1, revealEndMs - 24);
  return {
    node: Box(
      {
        width,
        height,
        position: "relative",
        animate: visibilityWindow(questionAtMs, null, 16),
        meta: { edit: message.id },
      },
      line({ top: 0, color: palette.faint, text: message.content }),
      line({
        top: metrics.tuiLinePx,
        color: palette.success,
        text: `${answeredFree ? ">" : "✓"} ${answer}`,
        strokes: true,
        ...(draft ? { animate: visibilityWindow(answerAtMs, null, 16) } : {}),
      }),
    ),
    estimatedHeight: height,
  };
}

/** The TUI option picker: standing block (keep) or two-row record (collapse). */
function tuiChoiceMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  if (choiceCollapses(timing.message, env.project)) {
    return tuiChoiceRecordBlock(timing, env, width);
  }
  return tuiPickerBlock(timing, env, tuiChoicePickerSpec(timing.message, env, { width }));
}

/**
 * The picker as a temporary replacement for the terminal prompt. Its owner
 * anchors it to the prompt's bottom edge, and the rows it reaches into are
 * handed over by the transcript stand-off. The caret walk and settle land a
 * beat early so the mark is seen before those rows return.
 */
export function tuiPickerPanel(
  timing: MessageTiming,
  env: SceneEnv,
  options: { width: number; durationMs: number },
): {
  node: AnyVNode;
  height: number;
  keepBottom: number;
  rowsTop: number;
  rowsHeight: number;
  settleAtMs: number;
} {
  const { width, durationMs } = options;
  const { metrics } = env;
  const { startMs, revealEndMs, message } = timing;
  // A picked answer settles inside the panel's own window. A typed one is
  // answered at the prompt, so the panel closes on the pick and the rows
  // keep the mark without ever holding the sentence.
  const answerDraft = choiceDraftTiming(timing, env.project);
  const hideMs = pickerCloseMs(timing, env.project, revealEndMs - 80);
  const settleAtMs = answerDraft
    ? Math.max(startMs + 1, answerDraft.startMs - 80)
    : Math.max(startMs + 1, revealEndMs - 320);
  const spec =
    message.role === "permission"
      ? tuiPermissionPickerSpec(message, env, width)
      : tuiChoicePickerSpec(message, env, { width, keepsAnswer: false });
  const block = tuiPickerBlock(timing, env, {
    ...spec,
    settleAtMs,
    // Terminal rows repaint at the hand-off; a fade would leave the picker
    // painting after its stand-off and prompt hold had already released.
    // The stand-off, prompt hold and picker all use the scene's timeline.
    // Normalising one of them against the message tail creates a sub-ms
    // boundary where one track has repainted and another has not.
    animate: stepVisibilityWindow(startMs, hideMs, durationMs),
  });
  // The option rows' own region, for the camera's commit push-in.
  const questionLines = tuiStatusLineCount(env, `  ${message.content}`, width - 24);
  const rowsTop = metrics.tuiLinePx * (1 + 1 + questionLines);
  // The row the block itself walks the caret to and settles the mark on.
  const chosenRow = Math.min(spec.chosen, spec.rows.length - 1);
  return {
    node: block.node,
    height: block.estimatedHeight,
    // A permission card decides at its foot; a choice keeps its answer row.
    keepBottom:
      message.role === "choice"
        ? rowsTop + (chosenRow + 1) * metrics.tuiLinePx
        : block.estimatedHeight,
    rowsTop,
    rowsHeight: metrics.tuiLinePx * spec.rows.length,
    settleAtMs,
  };
}

/** Side padding every transcript row keeps against the window edge. */
const APP_ROW_SIDE_PAD_PX = 24;
/**
 * A user bubble takes at most this share of the row, chat-app style — and now
 * that the bubble is sized to its content, this is only ever reached by a
 * message long enough to wrap. Real agent UIs sit near the full column and
 * lean on the fill to say whose words these are; two thirds was tight enough
 * that ordinary sentences wrapped early. The remaining fifth is what keeps
 * the right-hang legible as a reply.
 */
const APP_USER_BUBBLE_WIDTH_RATIO = 0.8;
/** …and always leaves at least this much row to its left. */
const APP_USER_BUBBLE_MIN_GUTTER_PX = 150;
/**
 * An assistant card's total horizontal inset: the row's side padding on both
 * edges, so the card ends where the user's bubble does.
 *
 * It used to carry an extra 26px trailing gap that nothing occupied — the
 * scrollbar sits outside the row — and being an absolute value it vanished on
 * a narrow canvas and showed on a wide one, so it read as neither a deliberate
 * offset nor an alignment. The two speakers are already told apart by width:
 * the bubble is sized to its content, the card runs the row.
 */
const APP_AGENT_BUBBLE_INSET_PX = APP_ROW_SIDE_PAD_PX * 2;
/** The image-generation card never grows past this width. */
const APP_IMAGE_CARD_MAX_W_PX = 420;
/** A bubble's horizontal padding pair; banners inset by it. */
const APP_BUBBLE_INNER_PAD_PX = 30;

/**
 * The horizontal band a message's card occupies inside a transcript row —
 * the camera frames exactly this. User bubbles hang right at chat-bubble
 * width, assistant cards run wide, and the status-style roles keep the
 * row's side padding.
 */
export function appMessageBand(options: {
  message: SessionMessage;
  rowWidth: number;
  env: SceneEnv;
  align: MessageAlign;
}): { offsetX: number; width: number } {
  const { message, rowWidth, env, align } = options;
  const { metrics } = env;
  const role = message.role;
  // Same scaled values the rows are laid out with — the camera frames this
  // band, so a constant here would aim it at where the card used to be.
  const sidePad = spacePx(metrics, APP_ROW_SIDE_PAD_PX);
  // Mirrors what `justifyContent: "center"` does to a card inside a row that
  // carries this side padding; the two have to agree or the camera and the
  // click target part company with the picture.
  const centred = (width: number) => ({
    offsetX: sidePad + Math.round((rowWidth - sidePad * 2 - width) / 2),
    width,
  });
  if (role === "user") {
    const cap = Math.min(
      rowWidth * APP_USER_BUBBLE_WIDTH_RATIO,
      sizeLeft(rowWidth, spacePx(metrics, APP_USER_BUBBLE_MIN_GUTTER_PX)),
    );
    // A bubble is as wide as what it holds, up to that cap. Every chat surface
    // works this way, and the ratio was already documented as a maximum — it
    // was simply being used as the width, so two characters got a paragraph's
    // box. Measuring here rather than at the call site keeps the camera and
    // the click target on the same rectangle as the render.
    const width = Math.min(
      cap,
      Math.ceil(
        appMessageInkWidthPx(message, env, { bandWidth: cap, engine: env.engine }) +
          spacePx(metrics, APP_BUBBLE_INNER_PAD_PX / 2) * 2,
      ),
    );
    return align === "center" ? centred(width) : { offsetX: rowWidth - sidePad - width, width };
  }
  if (role === "assistant") {
    const width = sizeLeft(rowWidth, spacePx(metrics, APP_AGENT_BUBBLE_INSET_PX));
    return align === "center" ? centred(width) : { offsetX: sidePad, width };
  }
  if (role === "image") {
    // The generation card is width-capped, so the camera can actually
    // lean into the artwork instead of framing the empty row.
    return {
      offsetX: APP_ROW_SIDE_PAD_PX,
      width: Math.min(sizeLeft(rowWidth, APP_ROW_SIDE_PAD_PX * 2), APP_IMAGE_CARD_MAX_W_PX),
    };
  }
  return { offsetX: APP_ROW_SIDE_PAD_PX, width: sizeLeft(rowWidth, APP_ROW_SIDE_PAD_PX * 2) };
}

// Chrome allowances around a message's text ink, for the camera's fit:
// glyph marks, duration chips, option markers, and button rows that sit
// beside the measured lines.
const INK_SANS_FALLBACK_RATIO = 0.62;
const INK_TOOL_CHROME_PX = 90;
const INK_THINKING_CHROME_PX = 70;
const INK_CHOICE_CHROME_PX = 90;
/** A permission card is never thinner than its approve/deny button row. */
const INK_PERMISSION_MIN_PX = 340;
/** The camera never frames a sliver thinner than a status chip. */
const INK_MIN_PX = 180;

/**
 * How wide a message's rendered text actually runs. Rows and bubbles
 * reserve full-width boxes, but short lines leave most of that empty —
 * the camera frames the ink, not the box. Estimates are conservative
 * (raw markdown source, engine measurement when available) and always
 * capped by the structural band.
 */
export function appMessageInkWidthPx(
  message: SessionMessage,
  env: SceneEnv,
  probe: { bandWidth: number; engine: Engine | undefined },
): number {
  const { metrics } = env;
  const { bandWidth, engine } = probe;
  const measure = (text: string, font: string, fontSizePx: number): number =>
    measureLineWidthPx(engine, {
      text,
      font,
      fontSizePx,
      fallbackRatio: font === MONO_FONT ? TUI_CHAR_RATIO : INK_SANS_FALLBACK_RATIO,
    });
  const maxLine = (text: string, font: string, fontSizePx: number): number =>
    text
      .split("\n")
      .reduce((widest, line) => Math.max(widest, measure(line.trim(), font, fontSizePx)), 0);
  const role = message.role;
  if (role === "image") {
    // The generation card is width-capped already; its band is exact.
    return bandWidth;
  }
  if ((message.images ?? []).length > 0) {
    // Attached banners span the bubble, so the box width is the ink.
    return bandWidth;
  }
  let ink: number;
  if (role === "tool") {
    ink = maxLine(message.content, MONO_FONT, metrics.uiPx) + INK_TOOL_CHROME_PX;
  } else if (role === "thinking") {
    ink = maxLine(message.content, SANS_FONT, metrics.uiPx) + INK_THINKING_CHROME_PX;
  } else if (role === "permission") {
    ink = Math.max(
      maxLine(message.content, SANS_FONT, metrics.prosePx) + INK_THINKING_CHROME_PX,
      INK_PERMISSION_MIN_PX,
    );
  } else if (role === "choice") {
    ink =
      [message.content, ...(message.options ?? []), freeformAnswer(message)].reduce(
        (widest, line) => Math.max(widest, measure(line, SANS_FONT, metrics.uiPx)),
        0,
      ) + INK_CHOICE_CHROME_PX;
  } else {
    // User and assistant bubbles: raw markdown source lines, code in mono.
    ink =
      stripDraftMarkup(message.content)
        .split("\n")
        .reduce((widest, raw) => {
          const line = raw.trim();
          const mono = line.startsWith("```") || raw.startsWith("    ");
          return Math.max(widest, measure(line, mono ? MONO_FONT : SANS_FONT, metrics.prosePx));
        }, 0) + APP_BUBBLE_INNER_PAD_PX;
  }
  return Math.min(bandWidth, Math.max(ink, INK_MIN_PX));
}

/** Prefix glyph, gap, and trailing status a TUI row draws beside its text. */
const TUI_INK_CHROME_PX = 56;

/**
 * How wide a TUI row's mono text actually runs: rows reserve the full
 * body width, but commands and status lines rarely use it. Options and
 * image stub lines count too — the camera frames the widest of them.
 */
export function tuiMessageInkWidthPx(
  message: SessionMessage,
  env: SceneEnv,
  probe: { bandWidth: number; engine: Engine | undefined },
): number {
  const { metrics } = env;
  const { bandWidth, engine } = probe;
  const lines = [
    ...stripDraftMarkup(message.content).split("\n"),
    ...(message.options ?? []),
    ...(message.images ?? []).map((image) => `[image] ${image.alt} · 0000×0000px`),
  ];
  const widest = lines.reduce(
    (max, line) =>
      Math.max(
        max,
        measureLineWidthPx(engine, {
          text: line.trim(),
          font: MONO_FONT,
          fontSizePx: metrics.tuiFontPx,
          fallbackRatio: TUI_CHAR_RATIO,
        }),
      ),
    0,
  );
  return Math.min(
    bandWidth,
    Math.max(widest + metrics.tuiCharPx * 2 + TUI_INK_CHROME_PX, INK_MIN_PX),
  );
}

/**
 * The banner stack a bubble's attached images occupy, measured up from the
 * bubble's bottom edge — the camera's close-up once they have landed.
 */
export function appAttachedImagesRegion(
  message: SessionMessage,
  bandWidth: number,
): { height: number } | null {
  const images = message.images ?? [];
  if (images.length === 0) {
    return null;
  }
  const bannerWidth = sizeLeft(bandWidth, APP_BUBBLE_INNER_PAD_PX);
  const height = images.reduce(
    (sum, image, index) => sum + attachedImageHeight(image, bannerWidth) + (index > 0 ? 7 : 0),
    0,
  );
  return { height };
}

export function appMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette } = env;
  const { message } = timing;
  // The row reserves its side padding through spacePx, which follows both the
  // authored spacing and the type scale. Sizing the content against a bare 48
  // was only ever right at scale 1: above it the card was built wider than the
  // slot it is placed in, and its rows ran out past its own border.
  const rowInset = spacePx(env.metrics, APP_ROW_SIDE_PAD_PX) * 2;
  if (message.role === "thinking" || message.role === "tool") {
    const status = appStatusMessage(timing, env, width - rowInset);
    return {
      node: Flex(
        {
          direction: "row",
          width,
          padding: [
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
          ],
        },
        status.node,
      ),
      estimatedHeight: status.estimatedHeight,
    };
  }
  if (message.role === "permission") {
    const permission = appPermissionMessage(timing, env, width - rowInset);
    return {
      node: Flex(
        {
          direction: "row",
          width,
          padding: [
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
          ],
        },
        permission.node,
      ),
      estimatedHeight: permission.estimatedHeight,
    };
  }
  if (message.role === "choice") {
    const answered = appChoiceMessage(timing, env, width - rowInset);
    return {
      node: Flex(
        {
          direction: "row",
          width,
          padding: [
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
          ],
        },
        answered.node,
      ),
      estimatedHeight: answered.estimatedHeight,
    };
  }
  if (message.role === "image") {
    const generated = appImageMessage(timing, env, width - rowInset);
    return {
      node: Flex(
        {
          direction: "row",
          width,
          padding: [
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
            0,
            spacePx(env.metrics, APP_ROW_SIDE_PAD_PX),
          ],
          meta: { edit: message.id },
        },
        generated.node,
      ),
      estimatedHeight: generated.estimatedHeight,
    };
  }

  const sp = (px: number): number => spacePx(env.metrics, px);
  const isUser = message.role === "user";
  // A user message is typed in the composer, sits through the pre-send
  // beat, and lands here right after the send fires; the agent's messages
  // stream in as they generate. Real agent UIs don't label every message
  // with names or avatars — identity lives in alignment and the composer.
  const anchorMs = isUser ? userLandingMs(timing) : timing.startMs;
  const messageAlign = env.project.appearance.messageAlign;
  const contentWidth = appMessageBand({
    message,
    rowWidth: width,
    env,
    align: messageAlign,
  }).width;
  const markdown = renderMarkdown(isUser ? stripDraftMarkup(message.content) : message.content, {
    env,
    width: sizeLeft(contentWidth, 30),
    messageTiming: timing,
    surface: "app",
    reveal: isUser ? "instant" : "streamed",
  });
  const attachedImages = appMessageImages(message, {
    width: sizeLeft(contentWidth, sp(30)),
    anchorMs,
    palette,
    metrics: env.metrics,
  });
  const card = Flex(
    {
      direction: "column",
      width: contentWidth,
      padding: [sp(12), sp(15), sp(13), sp(15)],
      gap: sp(7),
      borderRadius: sp(isUser ? 16 : 12),
      ...appCardSurface(env, isUser),
      ...(isUser ? { animate: appBubbleSpring(anchorMs) } : { animate: appEntrance(anchorMs) }),
    },
    ...markdown.nodes,
    ...(attachedImages?.nodes ?? []),
  );
  return {
    node: Flex(
      {
        direction: "row",
        width,
        gap: sp(10),
        alignItems: "start",
        justifyContent: messageAlign === "center" ? "center" : isUser ? "end" : "start",
        padding: [0, sp(APP_ROW_SIDE_PAD_PX), 0, sp(APP_ROW_SIDE_PAD_PX)],
        meta: { edit: message.id },
        ...(isUser ? { animate: appBubbleFade(anchorMs) } : {}),
      },
      card,
    ),
    estimatedHeight: markdown.estimatedHeight + (attachedImages?.height ?? 0) + 30,
  };
}

export function tuiMessage(timing: MessageTiming, env: SceneEnv, width: number): RenderedBlock {
  const { palette, metrics } = env;
  const { message } = timing;
  if (message.role === "thinking") {
    return tuiThinkingMessage(timing, env, width);
  }
  if (message.role === "tool") {
    return tuiToolMessage(timing, env, width);
  }
  if (message.role === "permission") {
    return tuiPermissionMessage(timing, env, width);
  }
  if (message.role === "choice") {
    return tuiChoiceMessage(timing, env, width);
  }
  if (message.role === "image") {
    return tuiImageMessage(timing, env, width);
  }

  const blocks = parseMarkdown(
    message.role === "user" ? stripDraftMarkup(message.content) : message.content,
  );
  const isUser = message.role === "user";
  // The user types in the prompt below; after the pre-send beat the
  // finished line is appended here in one repaint — real terminals have no
  // send effect beyond the prompt clearing. Agent output streams per cell.
  const anchorMs = isUser ? userLandingMs(timing) : timing.startMs;
  const prefixWidth = Math.ceil(metrics.tuiCharPx * 2);
  const bodyWidth = sizeLeft(width, prefixWidth, 8);
  const markdown = renderMarkdown(isUser ? stripDraftMarkup(message.content) : message.content, {
    env,
    width: bodyWidth,
    messageTiming: timing,
    surface: "tui",
    reveal: isUser ? "instant" : "typed",
  });
  const attachment = tuiAttachmentStub(message, { anchorMs, env, width: bodyWidth });
  return {
    node: Flex(
      {
        direction: "row",
        width,
        gap: 8,
        animate: tuiPop(anchorMs),
        meta: { edit: message.id },
      },
      Text(
        {
          width: prefixWidth,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: metrics.tuiFontPx,
          lineHeightPx: metrics.tuiLinePx,
          color: isUser ? palette.accent : palette.success,
          wrap: "none",
        },
        isUser ? "❯" : "●",
      ),
      Flex(
        { direction: "column", width: bodyWidth, gap: 6 },
        ...markdown.nodes,
        ...(attachment ? [attachment.node] : []),
      ),
    ),
    estimatedHeight:
      Math.max(metrics.tuiLinePx, markdown.estimatedHeight + (attachment?.height ?? 0)) +
      (markdownPlainText(blocks).length === 0 ? 8 : 0),
  };
}
