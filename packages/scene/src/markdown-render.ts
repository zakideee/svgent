import { type AnyVNode, Box, Flex, Inline, Path, Text } from "@boundsvg/core";
import { revealUnitsFor, structureRevealAnimation, visibilityWindow } from "./animations.js";
import {
  estimateTextWidthPx,
  hexToRgb,
  hexToRgba,
  MONO_FALLBACK,
  MONO_FONT,
  type RenderedBlock,
  type SceneEnv,
  type ScenePalette,
  sizeLeft,
  TUI_CHAR_RATIO,
} from "./env.js";
import { type HighlightRun, highlightCode, parseMarkdown } from "./markdown.js";
import {
  blockTypography,
  type LineTextOptions,
  lineText,
  type RevealAt,
  wholeCells,
} from "./markdown-inline-render.js";
import type { MarkdownBlock } from "./markdown-model.js";
import { layoutMarkdownTable, renderMarkdownTable } from "./markdown-table.js";
import {
  codePointLength,
  type DisplayLine,
  displayLineLength,
  markdownBlockRevealLength,
  markdownDisplayLines,
  markdownListItemRevealLength,
} from "./markdown-traversal.js";
import { measureLineWidthPx } from "./measure.js";
import type { MessageTiming } from "./timeline.js";

export type RevealMode = "typed" | "streamed" | "instant";

export type MarkdownRenderContext = {
  env: SceneEnv;
  width: number;
  messageTiming: MessageTiming;
  surface: "app" | "tui";
  reveal: RevealMode;
};

type RenderedMarkdown = {
  nodes: AnyVNode[];
  estimatedHeight: number;
};

/** Heading levels past this one share its size; smaller type would read as body. */
const SMALLEST_SIZED_HEADING = 4;
/** Space between a list marker and its item. */
const LIST_MARKER_GAP = 8;
/** An app list's marker column, as short lists have always had it. */
const APP_LIST_MARKER_MIN_PX = 22;
/** A terminal list's marker column, in cells. */
const TUI_LIST_MARKER_MIN_CELLS = 2;
/** Space between the items of a tight app list. */
const APP_TIGHT_ITEM_GAP_PX = 4;
/** Space between the items of a loose app list. */
const APP_LOOSE_ITEM_GAP_PX = 10;
/** The app quote's bar and the gap after it. */
const APP_QUOTE_COLUMN_PX = 15;
/** An app task box against the body font size. */
const TASK_BOX_FONT_RATIO = 0.95;
/** Room beside an app task box in the marker column. */
const TASK_BOX_MARGIN_PX = 4;
/** Corner radius of the app task box. */
const TASK_BOX_RADIUS_PX = 3;
/** The task box outline, and the least a check mark's stroke may be. */
const TASK_BOX_BORDER_PX = 1.5;
/** A check mark's stroke against the box size. */
const CHECK_MARK_STROKE_RATIO = 1 / 8;
/** The check mark's corners, as fractions of the task box. */
const CHECK_MARK_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0.22, 0.52],
  [0.42, 0.72],
  [0.78, 0.3],
];

// ————————————————————————————————————————————————————————————————————————————
// Code blocks
// ————————————————————————————————————————————————————————————————————————————

/** Pastel hues for dark code panels, saturated ones for light panels. */
const CODE_HUES = {
  dark: {
    keyword: "#c6a0f6",
    string: "#a6da95",
    number: "#f5a97f",
    callable: "#8aadf4",
    tag: "#eed49f",
    punctuation: "#a5adcb",
  },
  light: {
    keyword: "#8839ef",
    string: "#2e7d32",
    number: "#d2570b",
    callable: "#1e66f5",
    tag: "#b07d10",
    punctuation: "#7c7f93",
  },
} as const;

function codeHues(palette: ScenePalette): (typeof CODE_HUES)["dark" | "light"] {
  const [r, g, b] = hexToRgb(palette.code);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? CODE_HUES.light : CODE_HUES.dark;
}

function codeTokenColor(token: string, palette: ScenePalette): string {
  if (/deleted/iu.test(token)) {
    return palette.danger;
  }
  if (/inserted/iu.test(token)) {
    return palette.success;
  }
  if (/coord|comment|prolog|doctype|cdata/iu.test(token)) {
    return palette.faint;
  }
  const hues = codeHues(palette);
  if (/keyword|operator|boolean/iu.test(token)) {
    return hues.keyword;
  }
  if (/string|attr-value|char/iu.test(token)) {
    return hues.string;
  }
  if (/number|constant|symbol/iu.test(token)) {
    return hues.number;
  }
  if (/function|class-name|builtin/iu.test(token)) {
    return hues.callable;
  }
  if (/tag|property|selector|attr-name/iu.test(token)) {
    return hues.tag;
  }
  if (/punctuation/iu.test(token)) {
    return hues.punctuation;
  }
  return palette.codeText;
}

function codeLineNodes(
  line: HighlightRun[],
  palette: ScenePalette,
): Array<ReturnType<typeof Inline>> {
  if (line.length === 0) {
    return [Inline({ color: palette.codeText }, " ")];
  }
  return line.map((run) => Inline({ color: codeTokenColor(run.token, palette) }, run.text));
}

function renderCodeBlock(
  block: Extract<MarkdownBlock, { type: "code" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { width, surface, env } = context;
  const { palette, metrics } = env;
  const lines = highlightCode(block.text, block.language);
  const lineHeight = surface === "tui" ? metrics.tuiLinePx : metrics.codeLinePx;
  const codeFontPx = surface === "tui" ? metrics.tuiFontPx : metrics.codePx;
  const gutterFontPx = Math.max(9, metrics.codePx - 3);
  // Wide enough for the largest line number, measured in the actual mono
  // font — exact past 100 lines and robust to swapped fonts.
  const gutterWidth =
    surface === "tui"
      ? 0
      : Math.ceil(
          measureLineWidthPx(env.engine, {
            text: String(lines.length),
            font: MONO_FONT,
            fontSizePx: gutterFontPx,
            fallbackRatio: TUI_CHAR_RATIO,
          }),
        ) + 8;
  const gutterGap = surface === "tui" ? 0 : 10;
  const horizontalPadding = surface === "tui" ? 10 : 12;
  const codeWidth = sizeLeft(width, horizontalPadding * 2, gutterWidth, gutterGap);
  const isDiff = block.language.toLowerCase() === "diff";
  const diffLineKind = (line: HighlightRun[]): "add" | "del" | "hunk" | "ctx" => {
    const text = line.map((run) => run.text).join("");
    if (text.startsWith("+")) {
      return "add";
    }
    if (text.startsWith("-")) {
      return "del";
    }
    if (text.startsWith("@")) {
      return "hunk";
    }
    return "ctx";
  };
  const addedCount = isDiff ? lines.filter((line) => diffLineKind(line) === "add").length : 0;
  const removedCount = isDiff ? lines.filter((line) => diffLineKind(line) === "del").length : 0;

  const { timing: projectTiming } = context.env.project;
  const revealCps =
    context.messageTiming.message.role === "user"
      ? projectTiming.userTypingCps
      : projectTiming.agentTypingCps;
  // The panel (background, header, line numbers) enters with the block's
  // first character instead of standing empty ahead of the stream.
  const blockRevealMs =
    context.reveal === "instant"
      ? null
      : context.messageTiming.startMs + (offsetCharacters / revealCps) * 1_000;

  // One tick per line break, not per syntax-highlight run: counting runs
  // stretched a highlighted panel far past the time budgeted for it.
  let previousCharacters = 0;
  const codeLines = lines.map((line, lineIndex) => {
    const lineStart = previousCharacters;
    previousCharacters += line.reduce((sum, part) => sum + codePointLength(part.text), 0) + 1;
    const units = revealUnitsFor(context, offsetCharacters + lineStart);
    // Reveal moment of this line's first character: the row's background
    // slab, gutter number, and decorations all land with the text, so the
    // panel visibly grows line by line instead of standing at full height.
    const lineRevealMs =
      context.reveal === "instant"
        ? null
        : context.messageTiming.startMs + ((offsetCharacters + lineStart) / revealCps) * 1_000;
    const lineText = Text(
      {
        width: codeWidth,
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: codeFontPx,
        lineHeightPx: lineHeight,
        color: palette.codeText,
        whiteSpace: "pre-wrap",
        wrap: "none",
        ...(units ? { animateUnits: units } : {}),
      },
      ...codeLineNodes(line, palette),
    );
    if (surface === "tui") {
      return { row: lineText, lineRevealMs };
    }
    const lineKind = isDiff ? diffLineKind(line) : "ctx";
    const diffBackground =
      lineKind === "add"
        ? hexToRgba(palette.success, 0.26)
        : lineKind === "del"
          ? hexToRgba(palette.danger, 0.26)
          : null;
    const row = Flex(
      {
        direction: "row",
        width: sizeLeft(width, horizontalPadding * 2),
        minHeight: lineHeight,
        gap: gutterGap,
        // GitHub-style diff shading behind added/removed lines.
        ...(diffBackground ? { background: diffBackground, borderRadius: 3 } : {}),
      },
      Text(
        {
          width: gutterWidth,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx: gutterFontPx,
          lineHeightPx: lineHeight,
          color: palette.faint,
          textAlign: "end",
          wrap: "none",
        },
        String(lineIndex + 1),
      ),
      lineText,
    );
    return { row, lineRevealMs };
  });

  // Streaming code panels have no height channel to animate, so the frame is
  // built from per-row background slabs that pop in with their line — the
  // block reads as growing, and later line numbers stay unknown until their
  // line exists. The last row carries the bottom rounding and padding.
  const rowSlab = (
    entry: { row: AnyVNode; lineRevealMs: number | null },
    lineIndex: number,
    corner: { radius: number; bottomPad: number },
  ): AnyVNode => {
    const isLast = lineIndex === codeLines.length - 1;
    return Box(
      {
        width,
        padding: [0, horizontalPadding, isLast ? corner.bottomPad : 0, horizontalPadding],
        background: palette.code,
        ...(isLast ? { borderRadius: [0, 0, corner.radius, corner.radius] } : {}),
        ...(entry.lineRevealMs !== null
          ? { animate: visibilityWindow(entry.lineRevealMs, null, 90) }
          : {}),
      },
      entry.row,
    );
  };

  if (surface === "tui") {
    // Terminal fenced code: a dim slab, no chrome, no line numbers. The
    // first row carries the top rounding since there is no header band.
    return {
      node: Flex(
        { direction: "column", width, gap: 0, overflow: "clip" },
        Box({
          width,
          height: 8,
          borderRadius: [3, 3, 0, 0],
          background: palette.code,
          ...(blockRevealMs !== null ? { animate: visibilityWindow(blockRevealMs, null, 16) } : {}),
        }),
        ...codeLines.map((entry, lineIndex) =>
          rowSlab(entry, lineIndex, { radius: 3, bottomPad: 8 }),
        ),
      ),
      estimatedHeight: 18 + lines.length * lineHeight,
    };
  }

  return {
    node: Flex(
      { direction: "column", width, gap: 0, overflow: "clip" },
      Box(
        {
          width,
          padding: [10, horizontalPadding, 6, horizontalPadding],
          borderRadius: [10, 10, 0, 0],
          background: palette.code,
          ...(blockRevealMs !== null
            ? { animate: visibilityWindow(blockRevealMs, null, 160) }
            : {}),
        },
        Flex(
          {
            direction: "row",
            width: sizeLeft(width, horizontalPadding * 2),
            justifyContent: "space-between",
          },
          Text(
            {
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx: metrics.metaPx,
              color: palette.faint,
              letterSpacingPx: 0.6,
              wrap: "none",
            },
            block.language.toUpperCase(),
          ),
          isDiff
            ? Text(
                {
                  font: MONO_FONT,
                  fallback: MONO_FALLBACK,
                  fontSizePx: metrics.metaPx,
                  color: palette.faint,
                  wrap: "none",
                },
                Inline({ color: palette.success }, `+${addedCount}`),
                Inline({ color: palette.faint }, "  "),
                Inline({ color: palette.danger }, `−${removedCount}`),
              )
            : Text(
                {
                  font: MONO_FONT,
                  fallback: MONO_FALLBACK,
                  fontSizePx: metrics.metaPx,
                  color: palette.faint,
                  letterSpacingPx: 0.6,
                  wrap: "none",
                },
                "copy",
              ),
        ),
      ),
      ...codeLines.map((entry, lineIndex) =>
        rowSlab(entry, lineIndex, { radius: 10, bottomPad: 10 }),
      ),
    ),
    estimatedHeight: 24 + metrics.metaPx + 10 + lines.length * lineHeight,
  };
}

// ————————————————————————————————————————————————————————————————————————————
// Prose, rules, literal text
// ————————————————————————————————————————————————————————————————————————————

/** Space between sibling blocks inside a list item or a quote. */
function blockGap(context: MarkdownRenderContext): number {
  return context.surface === "tui" ? 6 : 8;
}

function renderRuleBlock(context: MarkdownRenderContext, offsetCharacters: number): RenderedBlock {
  const { width, env } = context;
  const { palette } = env;
  const animate = structureRevealAnimation(context, offsetCharacters);
  return {
    node: Box({
      width,
      height: 1,
      background: palette.border,
      margin: [6, 0, 6, 0],
      ...(animate ? { animate } : {}),
    }),
    estimatedHeight: 13,
  };
}

function estimatedLines(line: DisplayLine, fontSizePx: number, width: number): number {
  const text = line.map((run) => run.text).join("");
  // Width-based wrap estimate: the old chars-per-line heuristic assumed
  // 0.72em glyphs, which undercounts lines for CJK (~1em) and clipped the
  // transcript tail once the auto-scroll target fell short.
  return Math.max(1, Math.ceil(estimateTextWidthPx(text, fontSizePx) / Math.max(40, width)));
}

/** Lines of one text block; a single line stays a bare Text node. */
function stackLines(lines: DisplayLine[], at: RevealAt, options: LineTextOptions): RenderedBlock {
  const { context } = at;
  let lineOffset = at.offset;
  let estimatedHeight = 0;
  const nodes = lines.map((line) => {
    const node = lineText(line, { context, offset: lineOffset }, options);
    lineOffset += displayLineLength(line) + 1;
    estimatedHeight +=
      estimatedLines(line, options.fontSizePx, options.width) * options.lineHeightPx;
    return node;
  });
  const [only] = nodes;
  return {
    node:
      nodes.length === 1 && only !== undefined
        ? only
        : Flex({ direction: "column", width: options.width, gap: 0 }, ...nodes),
    estimatedHeight,
  };
}

/** Headings and paragraphs: one text line per hard break. */
function renderProseBlock(
  block: Extract<MarkdownBlock, { type: "heading" | "paragraph" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { width, surface, env } = context;
  const { palette, metrics } = env;
  const { fontSizePx, lineHeightPx, family } = blockTypography(context);
  const isHeading = block.type === "heading";
  // A terminal cannot change its cell size: TUI headings keep the grid font
  // and stand out through color and synthetic bold instead.
  const size =
    isHeading && surface === "app"
      ? fontSizePx +
        Math.max(2, Math.round((6 - Math.min(block.level, SMALLEST_SIZED_HEADING)) * metrics.scale))
      : fontSizePx;
  const headingLineHeight = surface === "app" ? lineHeightPx + 5 : lineHeightPx;
  return stackLines(
    markdownDisplayLines(block.children),
    { context, offset: offsetCharacters },
    {
      width,
      fontSizePx: size,
      lineHeightPx: isHeading ? headingLineHeight : lineHeightPx,
      family,
      color: isHeading && surface === "tui" ? palette.accent : palette.text,
      ...(isHeading
        ? {
            textStrokes: [
              {
                color: surface === "tui" ? palette.accent : palette.text,
                widthPx: surface === "tui" ? 0.4 : 0.5,
              },
            ],
          }
        : {}),
    },
  );
}

/** Raw HTML and unsupported syntax, shown as written with its line breaks. */
function renderLiteralBlock(
  block: Extract<MarkdownBlock, { type: "literal" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { fontSizePx, lineHeightPx, family } = blockTypography(context);
  const lines = block.text.split("\n").map(
    (text): DisplayLine =>
      text.length === 0
        ? []
        : [
            {
              text,
              kind: "literal",
              strong: false,
              emphasis: false,
              strikethrough: false,
              link: false,
            },
          ],
  );
  return stackLines(
    lines,
    { context, offset: offsetCharacters },
    {
      width: context.width,
      fontSizePx,
      lineHeightPx,
      family,
      color: context.env.palette.text,
      whiteSpace: "pre-wrap",
    },
  );
}

// ————————————————————————————————————————————————————————————————————————————
// Containers: lists and quotes hold blocks of their own
// ————————————————————————————————————————————————————————————————————————————

/** Blocks stacked in a column, each starting at its own tick. */
function renderBlockStack(blocks: MarkdownBlock[], at: RevealAt, gap: number): RenderedBlock {
  const { context } = at;
  let offset = at.offset;
  let estimatedHeight = 0;
  const nodes = blocks.map((block, index) => {
    const rendered = renderMarkdownBlock(block, context, offset);
    offset += markdownBlockRevealLength(block);
    estimatedHeight += rendered.estimatedHeight + (index > 0 ? gap : 0);
    return rendered.node;
  });
  const [only] = nodes;
  return {
    node:
      nodes.length === 1 && only !== undefined
        ? only
        : Flex({ direction: "column", width: context.width, gap }, ...nodes),
    estimatedHeight,
  };
}

/** An empty list item or quote still takes one line. */
function emptyLine(context: MarkdownRenderContext): RenderedBlock {
  const { fontSizePx, lineHeightPx, family } = blockTypography(context);
  return {
    node: Text(
      {
        width: context.width,
        font: family.font,
        fallback: family.fallback,
        fontSizePx,
        lineHeightPx,
        color: context.env.palette.text,
        wrap: "none",
      },
      Inline({ color: context.env.palette.text }, ""),
    ),
    estimatedHeight: lineHeightPx,
  };
}

function listMarkerText(
  block: Extract<MarkdownBlock, { type: "list" }>,
  index: number,
  surface: "app" | "tui",
): string {
  const task = block.items[index]?.task ?? null;
  const bullet = block.ordered ? `${block.start + index}.` : surface === "tui" ? "-" : "•";
  if (surface === "tui" && task !== null) {
    const box = task === "checked" ? "[x]" : "[ ]";
    return block.ordered ? `${bullet} ${box}` : box;
  }
  return bullet;
}

/** App task box, drawn from boxes and a stroke rather than a font glyph. */
function taskBox(
  state: "checked" | "unchecked",
  context: MarkdownRenderContext,
  sizePx: number,
): AnyVNode {
  const { palette } = context.env;
  const checked = state === "checked";
  return Box(
    {
      width: sizePx,
      height: sizePx,
      borderRadius: TASK_BOX_RADIUS_PX,
      borderWidth: TASK_BOX_BORDER_PX,
      borderColor: checked ? palette.accent : palette.muted,
      ...(checked ? { background: palette.accent } : {}),
    },
    ...(checked
      ? [
          Path({
            d: CHECK_MARK_POINTS.map(
              ([x, y], index) => `${index === 0 ? "M" : "L"}${sizePx * x} ${sizePx * y}`,
            ).join(" "),
            width: sizePx,
            height: sizePx,
            stroke: palette.canvas,
            strokeWidth: Math.max(TASK_BOX_BORDER_PX, sizePx * CHECK_MARK_STROKE_RATIO),
            strokeLinecap: "round",
            strokeLinejoin: "round",
            fill: "none",
          }),
        ]
      : []),
  );
}

/** Side of the app task box, matched to the text beside it. */
function taskBoxSize(context: { env: SceneEnv; surface: "app" | "tui" }): number {
  const { fontSizePx } = blockTypography(context);
  return Math.round(fontSizePx * TASK_BOX_FONT_RATIO);
}

/**
 * The marker column of a list. The widest marker decides it, measured in the
 * marker's own font, so a list that starts at 98 lines its text up past 100.
 */
function listMarkerWidth(
  block: Extract<MarkdownBlock, { type: "list" }>,
  context: { env: SceneEnv; surface: "app" | "tui" },
): number {
  const { env, surface } = context;
  const { metrics } = env;
  const { fontSizePx } = blockTypography(context);
  const widestMarker = block.items.reduce(
    (widest, _item, index) =>
      Math.max(
        widest,
        measureLineWidthPx(env.engine, {
          text: listMarkerText(block, index, surface),
          font: MONO_FONT,
          fontSizePx,
          fallbackRatio: TUI_CHAR_RATIO,
        }),
      ),
    0,
  );
  // The column only widens once a marker outgrows the one short lists have
  // always had. On the app a marker may hang into half the gap after it, as
  // "1." always has.
  if (surface === "tui") {
    return Math.ceil(
      metrics.tuiCharPx *
        Math.max(TUI_LIST_MARKER_MIN_CELLS, wholeCells(widestMarker, metrics.tuiCharPx)),
    );
  }
  const hasTask = block.items.some((item) => item.task !== null);
  return Math.max(
    APP_LIST_MARKER_MIN_PX,
    Math.ceil(widestMarker) - LIST_MARKER_GAP / 2,
    hasTask ? taskBoxSize(context) + TASK_BOX_MARGIN_PX : 0,
  );
}

/** An item's marker: its bullet or number, or on the app a drawn task box. */
function listMarkerNode(
  marker: {
    block: Extract<MarkdownBlock, { type: "list" }>;
    index: number;
    text: string;
    width: number;
  },
  at: RevealAt,
): AnyVNode {
  const { context, offset } = at;
  const { surface, env } = context;
  const { palette } = env;
  const { fontSizePx, lineHeightPx } = blockTypography(context);
  const animate = structureRevealAnimation(context, offset);
  const task = marker.block.items[marker.index]?.task ?? null;
  const markerText = (width?: number) =>
    Text(
      {
        ...(width !== undefined ? { width } : {}),
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx,
        lineHeightPx,
        color: surface === "tui" ? palette.muted : palette.accent,
        wrap: "none",
        ...(width !== undefined && animate ? { animate } : {}),
      },
      marker.text,
    );
  if (surface === "tui" || task === null) {
    return markerText(marker.width);
  }
  return Flex(
    {
      direction: "row",
      width: marker.width,
      height: lineHeightPx,
      alignItems: "center",
      gap: 6,
      ...(animate ? { animate } : {}),
    },
    ...(marker.block.ordered ? [markerText()] : []),
    taskBox(task, context, taskBoxSize(context)),
  );
}

function renderListBlock(
  block: Extract<MarkdownBlock, { type: "list" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { width, surface, env } = context;
  const { lineHeightPx } = blockTypography(context);
  const markers = block.items.map((_item, index) => listMarkerText(block, index, surface));
  const markerWidth = listMarkerWidth(block, { env, surface });
  const itemWidth = sizeLeft(width, markerWidth, LIST_MARKER_GAP);
  const itemContext = { ...context, width: itemWidth };
  // A loose list leaves a blank line between items on the terminal and
  // wider spacing in the app; a tight one keeps the spacing lists always had.
  const tightGap = surface === "tui" ? 0 : APP_TIGHT_ITEM_GAP_PX;
  const itemGap = block.loose
    ? surface === "tui"
      ? lineHeightPx
      : APP_LOOSE_ITEM_GAP_PX
    : tightGap;
  const innerGap = block.loose ? blockGap(context) : tightGap;
  let itemOffset = offsetCharacters;
  let estimatedHeight = 0;
  const rows = block.items.map((item, index) => {
    const content =
      item.children.length > 0
        ? renderBlockStack(item.children, { context: itemContext, offset: itemOffset }, innerGap)
        : emptyLine(itemContext);
    const marker = listMarkerNode(
      { block, index, text: markers[index] ?? "", width: markerWidth },
      { context, offset: itemOffset },
    );
    itemOffset += markdownListItemRevealLength(item);
    estimatedHeight +=
      Math.max(lineHeightPx, content.estimatedHeight) +
      (surface === "tui" ? 0 : 4) +
      (index > 0 ? itemGap : 0);
    return Flex({ direction: "row", width, gap: LIST_MARKER_GAP }, marker, content.node);
  });
  return {
    node: Flex({ direction: "column", width, gap: itemGap }, ...rows),
    estimatedHeight,
  };
}

/**
 * The rule beside quoted blocks: a rounded accent bar in the app, a thin
 * terminal-colored line centred in its cell on the TUI. It stretches with
 * whatever it sits beside and appears with that block's first character.
 */
function quoteBar(
  context: MarkdownRenderContext,
  offsetCharacters: number,
  barWidth: number,
): AnyVNode {
  const { surface, env } = context;
  const { palette, metrics } = env;
  const { lineHeightPx } = blockTypography(context);
  const animate = structureRevealAnimation(context, offsetCharacters);
  return Flex(
    {
      direction: "row",
      width: barWidth,
      alignItems: "stretch",
      ...(surface === "tui" ? { padding: [0, 0, 0, Math.floor(metrics.tuiCharPx / 2)] } : {}),
      ...(animate ? { animate } : {}),
    },
    Box({
      width: surface === "tui" ? Math.max(1, Math.round(metrics.tuiFontPx / 12)) : 3,
      minHeight: lineHeightPx,
      background: surface === "tui" ? palette.faint : palette.accent,
      ...(surface === "app" ? { borderRadius: 2 } : {}),
    }),
  );
}

/** The column a quote's bar takes: one and a half cells, or the app's bar and gap. */
function quoteBarWidth(env: SceneEnv, surface: "app" | "tui"): number {
  return surface === "tui" ? Math.ceil(env.metrics.tuiCharPx * 1.5) : APP_QUOTE_COLUMN_PX;
}

function renderQuoteBlock(
  block: Extract<MarkdownBlock, { type: "quote" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { width, surface, env } = context;
  const barWidth = quoteBarWidth(env, surface);
  const innerWidth = sizeLeft(width, barWidth);
  const inner = { ...context, width: innerWidth };
  const gap = blockGap(context);
  if (block.children.length === 0) {
    const empty = emptyLine(inner);
    return {
      node: Flex(
        { direction: "row", width, alignItems: "stretch", gap: 0 },
        quoteBar(context, offsetCharacters, barWidth),
        empty.node,
      ),
      estimatedHeight: empty.estimatedHeight,
    };
  }
  // One row per quoted block, so each stretch of the bar arrives with the
  // block beside it. The gap between blocks sits inside the row, where the
  // bar spans it, and the bar reads as one line.
  let offset = offsetCharacters;
  let estimatedHeight = 0;
  const rows = block.children.map((child, index) => {
    const rendered = renderMarkdownBlock(child, inner, offset);
    const bar = quoteBar(context, offset, barWidth);
    offset += markdownBlockRevealLength(child);
    estimatedHeight += rendered.estimatedHeight + (index > 0 ? gap : 0);
    const body =
      index === 0
        ? rendered.node
        : Flex(
            { direction: "column", width: innerWidth, gap: 0 },
            Box({ width: innerWidth, height: gap }),
            rendered.node,
          );
    return Flex({ direction: "row", width, alignItems: "stretch", gap: 0 }, bar, body);
  });
  return {
    node: Flex({ direction: "column", width, gap: 0 }, ...rows),
    estimatedHeight,
  };
}

// ————————————————————————————————————————————————————————————————————————————
// Dispatch
// ————————————————————————————————————————————————————————————————————————————

function renderMarkdownBlock(
  block: MarkdownBlock,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return renderProseBlock(block, context, offsetCharacters);
    case "rule":
      return renderRuleBlock(context, offsetCharacters);
    case "code":
      return renderCodeBlock(block, context, offsetCharacters);
    case "list":
      return renderListBlock(block, context, offsetCharacters);
    case "quote":
      return renderQuoteBlock(block, context, offsetCharacters);
    case "table":
      return renderMarkdownTable(block, context, offsetCharacters);
    case "literal":
      return renderLiteralBlock(block, context, offsetCharacters);
  }
}

/** Render parsed blocks as sibling nodes; the caller spaces them. */
export function renderMarkdownBlocks(
  blocks: MarkdownBlock[],
  context: MarkdownRenderContext,
): RenderedMarkdown {
  const gap = blockGap(context);
  let characterOffset = 0;
  let estimatedHeight = 0;
  const nodes = blocks.map((block) => {
    const rendered = renderMarkdownBlock(block, context, characterOffset);
    characterOffset += markdownBlockRevealLength(block);
    estimatedHeight += rendered.estimatedHeight + gap;
    return rendered.node;
  });
  return { nodes, estimatedHeight };
}

export function renderMarkdown(source: string, context: MarkdownRenderContext): RenderedMarkdown {
  return renderMarkdownBlocks(parseMarkdown(source), context);
}

/**
 * The widest table the blocks draw at this width, with the list markers and
 * quote bars in front of it, or 0 if there is none. A bubble sized from the
 * raw source would take its width from the pipes; this is what it draws.
 */
export function markdownTableInkWidthPx(
  blocks: MarkdownBlock[],
  options: { env: SceneEnv; surface: "app" | "tui"; width: number },
): number {
  const { env, surface, width } = options;
  let widest = 0;
  for (const block of blocks) {
    if (block.type === "table") {
      widest = Math.max(widest, layoutMarkdownTable(block, { env, surface, width }).width);
    } else if (block.type === "quote") {
      const barWidth = quoteBarWidth(env, surface);
      const inner = markdownTableInkWidthPx(block.children, {
        ...options,
        width: sizeLeft(width, barWidth),
      });
      widest = Math.max(widest, inner > 0 ? inner + barWidth : 0);
    } else if (block.type === "list") {
      const markerWidth = listMarkerWidth(block, { env, surface }) + LIST_MARKER_GAP;
      for (const item of block.items) {
        const inner = markdownTableInkWidthPx(item.children, {
          ...options,
          width: sizeLeft(width, markerWidth),
        });
        widest = Math.max(widest, inner > 0 ? inner + markerWidth : 0);
      }
    }
  }
  return widest;
}
