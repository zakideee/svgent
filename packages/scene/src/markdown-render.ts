import { type AnyVNode, Box, Flex, Inline, Text } from "@boundsvg/core";
import {
  chipRevealAnimation,
  revealUnitsFor,
  structureRevealAnimation,
  visibilityWindow,
} from "./animations.js";
import {
  estimateTextWidthPx,
  hexToRgb,
  hexToRgba,
  MONO_FALLBACK,
  MONO_FONT,
  type RenderedBlock,
  SANS_FALLBACK,
  SANS_FONT,
  type SceneEnv,
  type ScenePalette,
  sizeLeft,
  TUI_CHAR_RATIO,
} from "./env.js";
import {
  type HighlightRun,
  type InlineRun,
  type MarkdownBlock,
  parseMarkdown,
} from "./markdown.js";
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

// ————————————————————————————————————————————————————————————————————————————
// Markdown rendering
// ————————————————————————————————————————————————————————————————————————————

function inlineNodes(
  runs: InlineRun[],
  context: MarkdownRenderContext,
  offsetCharacters: number,
): Array<ReturnType<typeof Inline>> {
  const { env, surface } = context;
  const { palette, metrics } = env;
  let runOffset = 0;
  return runs.map((run) => {
    const chipOffset = offsetCharacters + runOffset;
    runOffset += Array.from(run.text).length;
    switch (run.style) {
      case "strong":
        return Inline(
          {
            color: palette.text,
            textStrokes: [{ color: palette.text, widthPx: surface === "tui" ? 0.4 : 0.45 }],
          },
          run.text,
        );
      case "emphasis":
        return Inline({ color: palette.text, fontStyle: "italic" }, run.text);
      case "code": {
        const animate = chipRevealAnimation(context, chipOffset);
        return Inline(
          {
            font: MONO_FONT,
            fallback: MONO_FALLBACK,
            color: palette.codeText,
            background: surface === "tui" ? palette.panelStrong : palette.code,
            paddingInline: [4, 4],
            borderRadius: surface === "tui" ? [2, 2, 2, 2] : [4, 4, 4, 4],
            ...(surface === "app" ? { fontSizePx: metrics.codePx } : {}),
            ...(animate ? { animate } : {}),
          },
          run.text,
        );
      }
      case "link":
        return Inline({ color: palette.accent }, run.text);
      default:
        return Inline({ color: palette.text }, run.text);
    }
  });
}

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

function blockCharacterCount(block: MarkdownBlock): number {
  if (block.type === "rule") {
    return 1;
  }
  if (block.type === "code") {
    return block.lines.reduce(
      (sum, line) => sum + line.reduce((run, part) => run + Array.from(part.text).length, 0) + 1,
      0,
    );
  }
  if (block.type === "list") {
    return block.items.reduce(
      (sum, item) => sum + item.reduce((run, part) => run + Array.from(part.text).length, 0) + 1,
      0,
    );
  }
  return block.runs.reduce((sum, run) => sum + Array.from(run.text).length, 0);
}

function renderCodeBlock(
  block: Extract<MarkdownBlock, { type: "code" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { width, surface, env } = context;
  const { palette, metrics } = env;
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
            text: String(block.lines.length),
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
  const addedCount = isDiff ? block.lines.filter((line) => diffLineKind(line) === "add").length : 0;
  const removedCount = isDiff
    ? block.lines.filter((line) => diffLineKind(line) === "del").length
    : 0;

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

  const codeLines = block.lines.map((line, lineIndex) => {
    // One tick per line break, not per syntax-highlight run: counting runs
    // stretched a highlighted panel far past the time budgeted for it.
    const previousCharacters = block.lines
      .slice(0, lineIndex)
      .reduce(
        (sum, line) => sum + line.reduce((run, part) => run + Array.from(part.text).length, 0) + 1,
        0,
      );
    const units = revealUnitsFor(context, offsetCharacters + previousCharacters);
    // Reveal moment of this line's first character: the row's background
    // slab, gutter number, and decorations all land with the text, so the
    // panel visibly grows line by line instead of standing at full height.
    const lineRevealMs =
      context.reveal === "instant"
        ? null
        : context.messageTiming.startMs +
          ((offsetCharacters + previousCharacters) / revealCps) * 1_000;
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
      estimatedHeight: 18 + block.lines.length * lineHeight,
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
    estimatedHeight: 24 + metrics.metaPx + 10 + block.lines.length * lineHeight,
  };
}

/** Font, line height, and family for one markdown block on the active surface. */
function blockTypography(context: MarkdownRenderContext): {
  fontSizePx: number;
  lineHeightPx: number;
  family: { font: string; fallback: string[] };
} {
  const { surface, env } = context;
  const { metrics } = env;
  return {
    fontSizePx: surface === "tui" ? metrics.tuiFontPx : metrics.prosePx,
    lineHeightPx: surface === "tui" ? metrics.tuiLinePx : metrics.proseLinePx,
    family:
      surface === "tui"
        ? { font: MONO_FONT, fallback: MONO_FALLBACK }
        : { font: SANS_FONT, fallback: SANS_FALLBACK },
  };
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

function renderListBlock(
  block: Extract<MarkdownBlock, { type: "list" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { width, surface, env } = context;
  const { palette, metrics } = env;
  const { fontSizePx, lineHeightPx, family } = blockTypography(context);
  const itemHeight = lineHeightPx + (surface === "tui" ? 0 : 4);
  const bulletWidth = surface === "tui" ? Math.ceil(metrics.tuiCharPx * 2) : 22;
  const listGap = surface === "tui" ? 0 : 4;
  const itemTextWidth = sizeLeft(width, bulletWidth, 8);
  // Wrap-aware: long items span multiple lines, especially at large scales.
  const estimatedListHeight = block.items.reduce((sum, item) => {
    const text = item.map((run) => run.text).join("");
    const lines = Math.max(
      1,
      Math.ceil(estimateTextWidthPx(text, fontSizePx) / Math.max(40, itemTextWidth)),
    );
    return sum + (itemHeight + (lines - 1) * lineHeightPx);
  }, 0);
  return {
    node: Flex(
      { direction: "column", width, gap: listGap },
      ...block.items.map((item, index) => {
        const itemOffset =
          offsetCharacters +
          block.items
            .slice(0, index)
            .reduce(
              (sum, previous) =>
                sum + previous.reduce((run, part) => run + Array.from(part.text).length, 0) + 1,
              0,
            );
        const markerAnimate = structureRevealAnimation(context, itemOffset);
        return Flex(
          { direction: "row", width, gap: 8 },
          Text(
            {
              width: bulletWidth,
              font: MONO_FONT,
              fallback: MONO_FALLBACK,
              fontSizePx,
              lineHeightPx,
              color: surface === "tui" ? palette.muted : palette.accent,
              wrap: "none",
              ...(markerAnimate ? { animate: markerAnimate } : {}),
            },
            block.ordered ? `${index + 1}.` : surface === "tui" ? "-" : "•",
          ),
          (() => {
            const units = revealUnitsFor(context, itemOffset);
            return Text(
              {
                width: sizeLeft(width, bulletWidth, 8),
                font: family.font,
                fallback: family.fallback,
                fontSizePx,
                lineHeightPx,
                color: palette.text,
                wrap: "char",
                ...(units ? { animateUnits: units } : {}),
              },
              ...inlineNodes(item, context, itemOffset),
            );
          })(),
        );
      }),
    ),
    estimatedHeight: estimatedListHeight,
  };
}

/**
 * Wraps quoted text in its leading rule. A terminal draws the "|" gutter as a
 * real cell the way CLI markdown renderers do; the app draws a rounded bar.
 */
function quoteGutter(
  textNode: AnyVNode,
  options: {
    context: MarkdownRenderContext;
    offsetCharacters: number;
    quoteBarWidth: number;
    fontSizePx: number;
  },
): AnyVNode {
  const { context, offsetCharacters, quoteBarWidth, fontSizePx } = options;
  const { width, surface, env } = context;
  const { palette } = env;
  const { lineHeightPx } = blockTypography(context);
  const animate = structureRevealAnimation(context, offsetCharacters);
  if (surface === "tui") {
    return Flex(
      { direction: "row", width, gap: 0 },
      Text(
        {
          width: quoteBarWidth,
          font: MONO_FONT,
          fallback: MONO_FALLBACK,
          fontSizePx,
          lineHeightPx,
          color: palette.faint,
          wrap: "none",
          ...(animate ? { animate } : {}),
        },
        "\u2502",
      ),
      textNode,
    );
  }
  return Flex(
    { direction: "row", width, gap: 12 },
    Box({
      width: 3,
      minHeight: lineHeightPx,
      borderRadius: 2,
      background: palette.accent,
      ...(animate ? { animate } : {}),
    }),
    textNode,
  );
}

/** Headings, quotes, and paragraphs share one text node and differ only in trim. */
function renderProseBlock(
  block: Exclude<MarkdownBlock, { type: "code" } | { type: "rule" } | { type: "list" }>,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  const { width, surface, env } = context;
  const { palette, metrics } = env;
  const { fontSizePx, lineHeightPx, family } = blockTypography(context);
  const isHeading = block.type === "heading";
  const isQuote = block.type === "quote";
  const quoteBarWidth = surface === "tui" ? Math.ceil(metrics.tuiCharPx * 1.5) : 15;
  const textWidth = isQuote ? width - quoteBarWidth : width;
  // A terminal cannot change its cell size: TUI headings keep the grid font
  // and stand out through color and synthetic bold instead.
  const size =
    isHeading && surface === "app"
      ? fontSizePx + Math.max(2, Math.round((6 - block.level) * metrics.scale))
      : fontSizePx;
  const headingLineHeight = surface === "app" ? lineHeightPx + 5 : lineHeightPx;
  const blockText = block.runs.map((run) => run.text).join("");
  // Width-based wrap estimate: the old chars-per-line heuristic assumed
  // 0.72em glyphs, which undercounts lines for CJK (~1em) and clipped the
  // transcript tail once the auto-scroll target fell short.
  const estimatedLineCount = Math.max(
    1,
    Math.ceil(estimateTextWidthPx(blockText, size) / Math.max(40, textWidth)),
  );
  const units = revealUnitsFor(context, offsetCharacters);
  const textNode = Text(
    {
      width: textWidth,
      font: family.font,
      fallback: family.fallback,
      fontSizePx: size,
      lineHeightPx: isHeading ? headingLineHeight : lineHeightPx,
      color: isQuote
        ? palette.muted
        : isHeading && surface === "tui"
          ? palette.accent
          : palette.text,
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
      wrap: "char",
      ...(units ? { animateUnits: units } : {}),
    },
    ...inlineNodes(block.runs, context, offsetCharacters),
  );
  if (isQuote) {
    return {
      node: quoteGutter(textNode, { context, offsetCharacters, quoteBarWidth, fontSizePx }),
      estimatedHeight: estimatedLineCount * lineHeightPx,
    };
  }
  return {
    node: textNode,
    estimatedHeight: estimatedLineCount * (isHeading ? headingLineHeight : lineHeightPx),
  };
}

function renderMarkdownBlock(
  block: MarkdownBlock,
  context: MarkdownRenderContext,
  offsetCharacters: number,
): RenderedBlock {
  switch (block.type) {
    case "rule":
      return renderRuleBlock(context, offsetCharacters);
    case "code":
      return renderCodeBlock(block, context, offsetCharacters);
    case "list":
      return renderListBlock(block, context, offsetCharacters);
    default:
      return renderProseBlock(block, context, offsetCharacters);
  }
}

export function renderMarkdown(source: string, context: MarkdownRenderContext): RenderedMarkdown {
  const blocks = parseMarkdown(source);
  const blockGap = context.surface === "tui" ? 6 : 8;
  let characterOffset = 0;
  let estimatedHeight = 0;
  const nodes = blocks.map((block) => {
    const rendered = renderMarkdownBlock(block, context, characterOffset);
    characterOffset += blockCharacterCount(block);
    estimatedHeight += rendered.estimatedHeight + blockGap;
    return rendered.node;
  });
  return { nodes, estimatedHeight };
}
