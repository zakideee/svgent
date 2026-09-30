/**
 * GFM tables: column widths decided once from the finished table, and the
 * two surfaces' drawings of the same layout.
 *
 * Widths come from the authored cells measured in the fonts they are drawn
 * in, so they never change while the table streams in. A table that cannot
 * fit even its narrowest readable columns is stacked into a single column
 * instead of being clipped or scrolled.
 *
 * Rows reveal in source order. Each row's fill and rules appear with its first
 * cell and every cell streams from its own offset, so a later row never shows
 * ahead of the text above it.
 */

import {
  type AnyVNode,
  Box,
  Canvas,
  type Engine,
  Flex,
  type LayoutNode,
  Text,
} from "@boundsvg/core";
import { structureRevealAnimation } from "./animations.js";
import {
  hexToRgba,
  MONO_FALLBACK,
  MONO_FONT,
  type RenderedBlock,
  SANS_FALLBACK,
  SANS_FONT,
  type SceneEnv,
  TUI_CHAR_RATIO,
} from "./env.js";
import { draftGraphemes } from "./graphemes.js";
import {
  blockTypography,
  CHIP_PAD_PX,
  type LineTextOptions,
  lineText,
  type RevealAt,
  strongStroke,
  wholeCells,
} from "./markdown-inline-render.js";
import type { MarkdownBlock, MarkdownTableAlignment } from "./markdown-model.js";
import type { MarkdownRenderContext } from "./markdown-render.js";
import {
  type DisplayLine,
  displayLineLength,
  markdownDisplayLines,
  tableCellRevealLength,
  tableRows,
} from "./markdown-traversal.js";
import {
  measureLineWidthPx,
  measureWrappedLineCount,
  PROBE_CANVAS_HEIGHT_PX,
  PROBE_CANVAS_MIN_WIDTH_PX,
} from "./measure.js";

type TableBlock = Extract<MarkdownBlock, { type: "table" }>;

/** How a table is drawn at one width. */
type TableLayout = {
  mode: "grid" | "stacked";
  /** Content width of each column, excluding padding and rules. */
  columnWidths: number[];
  /** The width the drawing occupies; never more than the width offered. */
  width: number;
};

type Surface = "app" | "tui";

/** Sans measurements without an engine lean slightly wide, as elsewhere. */
const SANS_FALLBACK_RATIO = 0.62;
/** An app cell's horizontal padding. */
const APP_CELL_PAD_X = 10;
/** An app cell's vertical padding. */
const APP_CELL_PAD_Y = 6;
/** Thickness of the app table's rules. */
const APP_RULE_PX = 1;
/** How strongly the app tints a table's header row. */
const APP_HEADER_FILL_ALPHA = 0.06;
/** Line height of a stacked table's column labels, against their font size. */
const STACKED_LABEL_LINE_RATIO = 1.4;
/** Space between a stacked cell's label and its text, and between cells. */
const STACKED_CELL_GAP_PX = 4;
/** Columns keep at least this many characters' width when their content has it. */
const READABLE_MIN_CHARACTERS = 4;

/** Label for a column whose header cell is empty. Fixed English ASCII. */
function genericColumnLabel(column: number): string {
  return `Column ${column + 1}`;
}

function textFont(
  env: SceneEnv,
  surface: Surface,
  kind: DisplayLine[number]["kind"],
): {
  font: string;
  fontSizePx: number;
  fallbackRatio: number;
  fallback: string[];
  chipPad: number;
} {
  const { metrics } = env;
  if (kind === "code") {
    return {
      font: MONO_FONT,
      fallback: MONO_FALLBACK,
      fontSizePx: surface === "tui" ? metrics.tuiFontPx : metrics.codePx,
      fallbackRatio: TUI_CHAR_RATIO,
      chipPad: CHIP_PAD_PX * 2,
    };
  }
  return surface === "tui"
    ? {
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: metrics.tuiFontPx,
        fallbackRatio: TUI_CHAR_RATIO,
        chipPad: 0,
      }
    : {
        font: SANS_FONT,
        fallback: SANS_FALLBACK,
        fontSizePx: metrics.prosePx,
        fallbackRatio: SANS_FALLBACK_RATIO,
        chipPad: 0,
      };
}

type CellMeasure = { natural: number; minimum: number };

/**
 * A cell's single-line width, and the narrowest width it can still wrap into
 * by characters: its widest cluster, with a chip's padding when that cluster
 * sits in one. An empty cell still claims one character.
 */
function measureCell(
  line: DisplayLine,
  target: { env: SceneEnv; surface: Surface },
  clusterWidths: Map<string, number>,
): CellMeasure {
  const { env, surface } = target;
  const engine = env.engine;
  let natural = 0;
  let minimum = 0;
  for (const run of line) {
    const font = textFont(env, surface, run.kind);
    // Spaces at a run's edges sit inside the cell's line, but a measurement
    // of the run alone would drop them; a no-break space keeps their width.
    const text = run.text.replace(/^ +| +$/gu, (spaces) => "\u00a0".repeat(spaces.length));
    natural += measureLineWidthPx(engine, { ...font, text }) + font.chipPad;
    for (const cluster of draftGraphemes(run.text)) {
      const key = `${font.font}|${font.fontSizePx}|${cluster}`;
      let width = clusterWidths.get(key);
      if (width === undefined) {
        width = measureLineWidthPx(engine, { ...font, text: cluster });
        clusterWidths.set(key, width);
      }
      minimum = Math.max(minimum, width + font.chipPad);
    }
  }
  const oneCharacter = measureLineWidthPx(engine, { ...textFont(env, surface, "text"), text: "0" });
  return { natural: Math.max(natural, oneCharacter), minimum: Math.max(minimum, oneCharacter) };
}

/** The horizontal space a grid spends outside its column contents. */
function gridChrome(env: SceneEnv, surface: Surface, columns: number): number {
  return surface === "tui"
    ? env.metrics.tuiCharPx * (columns * 2 + columns + 1)
    : APP_CELL_PAD_X * 2 * columns + APP_RULE_PX * (columns + 1);
}

/**
 * Shrink columns from their natural widths toward their minimums, taking
 * from each in proportion to how much it can give. Units are whole terminal
 * cells on the TUI and pixels on the app; rounding leftovers go to the
 * leftmost columns so the total never exceeds what is available.
 */
function distributeWidths(natural: number[], minimum: number[], available: number): number[] {
  const slack = natural.map((width, index) => Math.max(0, width - (minimum[index] ?? 0)));
  const totalSlack = slack.reduce((sum, value) => sum + value, 0);
  const spare = Math.max(0, available - minimum.reduce((sum, value) => sum + value, 0));
  const widths = minimum.map((width, index) =>
    totalSlack > 0 ? width + Math.floor(((slack[index] ?? 0) * spare) / totalSlack) : width,
  );
  let leftover = available - widths.reduce((sum, value) => sum + value, 0);
  for (let index = 0; leftover >= 1 && index < widths.length; index += 1) {
    if ((widths[index] ?? 0) < (natural[index] ?? 0)) {
      widths[index] = (widths[index] ?? 0) + 1;
      leftover -= 1;
    }
  }
  return widths;
}

const layoutCache = new WeakMap<object, Map<string, TableLayout>>();
/** Table layouts kept per engine before the cache starts over. */
const LAYOUT_CACHE_LIMIT = 500;
/** Cache owner for layouts measured without an engine. */
const ENGINELESS = {};

/** Column widths and mode for one table at one available width. */
export function layoutMarkdownTable(
  block: TableBlock,
  target: { env: SceneEnv; surface: Surface; width: number },
): TableLayout {
  const { env, surface, width: availableWidth } = target;
  const cacheKey = `${surface}|${availableWidth}|${JSON.stringify(env.metrics)}|${JSON.stringify(block)}`;
  const cacheOwner = env.engine ?? ENGINELESS;
  let cache = layoutCache.get(cacheOwner);
  if (cache === undefined) {
    cache = new Map();
    layoutCache.set(cacheOwner, cache);
  }
  const cached = cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const columns = block.header.length;
  const clusterWidths = new Map<string, number>();
  const natural = new Array<number>(columns).fill(0);
  const minimum = new Array<number>(columns).fill(0);
  for (const row of tableRows(block)) {
    row.forEach((cell, column) => {
      const measured = measureCell(
        markdownDisplayLines(cell)[0] ?? [],
        { env, surface },
        clusterWidths,
      );
      natural[column] = Math.max(natural[column] ?? 0, measured.natural);
      minimum[column] = Math.max(minimum[column] ?? 0, measured.minimum);
    });
  }
  // A column narrower than a few characters stacks its words a letter per
  // line; below that the single-column layout reads better, so no column
  // shrinks past this unless its content is narrower still.
  const readable = measureLineWidthPx(env.engine, {
    ...textFont(env, surface, "text"),
    text: "0".repeat(READABLE_MIN_CHARACTERS),
  });
  for (let column = 0; column < columns; column += 1) {
    minimum[column] = Math.max(minimum[column] ?? 0, Math.min(natural[column] ?? 0, readable));
  }
  const chrome = gridChrome(env, surface, columns);
  let layout: TableLayout;
  if (surface === "tui") {
    const cell = env.metrics.tuiCharPx;
    const toCells = (px: number) => Math.max(1, wholeCells(px, cell));
    const naturalCells = natural.map(toCells);
    const minimumCells = minimum.map(toCells);
    const availableCells = Math.floor(availableWidth / cell) - (columns * 3 + 1);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    if (sum(naturalCells) <= availableCells) {
      layout = gridLayout(
        naturalCells.map((cells) => cells * cell),
        chrome,
      );
    } else if (sum(minimumCells) <= availableCells) {
      const cells = distributeWidths(naturalCells, minimumCells, availableCells);
      layout = gridLayout(
        cells.map((count) => count * cell),
        chrome,
      );
    } else {
      layout = {
        mode: "stacked",
        columnWidths: [],
        width: Math.floor(availableWidth / cell) * cell,
      };
    }
  } else {
    const naturalPx = natural.map((width) => Math.ceil(width));
    const minimumPx = minimum.map((width) => Math.ceil(width));
    const availablePx = Math.floor(availableWidth - chrome);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    if (sum(naturalPx) <= availablePx) {
      layout = gridLayout(naturalPx, chrome);
    } else if (sum(minimumPx) <= availablePx) {
      layout = gridLayout(distributeWidths(naturalPx, minimumPx, availablePx), chrome);
    } else {
      layout = { mode: "stacked", columnWidths: [], width: availableWidth };
    }
  }
  if (cache.size >= LAYOUT_CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(cacheKey, layout);
  return layout;
}

function gridLayout(columnWidths: number[], chrome: number): TableLayout {
  return {
    mode: "grid",
    columnWidths,
    width: columnWidths.reduce((sum, width) => sum + width, 0) + chrome,
  };
}

function textAlign(alignment: MarkdownTableAlignment): "start" | "center" | "end" {
  if (alignment === "center") {
    return "center";
  }
  return alignment === "right" ? "end" : "start";
}

type CellEntry = { line: DisplayLine; offset: number; column: number };

/**
 * When a stacked block's closing rule may show: with the last character of
 * its last cell. That cell may wrap over several lines, and the rule sits
 * under all of them.
 */
function closingTick(entries: CellEntry[], fallback: number): number {
  const last = entries.at(-1);
  return last === undefined
    ? fallback
    : last.offset + Math.max(0, displayLineLength(last.line) - 1);
}

/** Every row's cells with the tick each one starts at. */
function cellEntries(block: TableBlock, offset: number): CellEntry[][] {
  let cursor = offset;
  return tableRows(block).map((row) =>
    row.map((cell, column) => {
      const entry = { line: markdownDisplayLines(cell)[0] ?? [], offset: cursor, column };
      cursor += tableCellRevealLength(cell);
      return entry;
    }),
  );
}

const heightCache = new WeakMap<object, Map<string, number[] | null>>();
/** TUI row heights kept per engine before the cache starts over. */
const HEIGHT_CACHE_LIMIT = 500;

/**
 * Heights of text nodes as the engine lays them out, or `null` without an
 * engine. The TUI needs them to draw its `|` rules exactly as tall as the
 * wrapped cells beside them. `key` names what the heights depend on, so an
 * unchanged table is not laid out again on the next build.
 */
function measureTextHeights(
  engine: Engine | undefined,
  probe: { nodes: AnyVNode[]; width: number; key: string },
): number[] | null {
  const { nodes, width, key } = probe;
  if (engine === undefined || nodes.length === 0) {
    return null;
  }
  let cache = heightCache.get(engine);
  if (cache === undefined) {
    cache = new Map();
    heightCache.set(engine, cache);
  }
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let heights: number[] | null = null;
  try {
    const layout = engine.renderToLayoutTree(
      Canvas(
        {
          width: Math.max(PROBE_CANVAS_MIN_WIDTH_PX, Math.ceil(width)),
          height: PROBE_CANVAS_HEIGHT_PX,
        },
        Flex(
          { position: "absolute", left: 0, top: 0, width, direction: "column", gap: 0 },
          ...nodes.map((node, index) =>
            Flex({ direction: "column", width, meta: { tableProbe: String(index) } }, node),
          ),
        ),
      ),
      { skipValidation: true },
    );
    const measured = new Array<number>(nodes.length).fill(0);
    const walk = (node: LayoutNode): void => {
      const meta = (node.vnode as { props?: { meta?: Record<string, string> } }).props?.meta;
      const index = meta?.tableProbe;
      if (index !== undefined) {
        measured[Number(index)] = node.bbox.height;
        return;
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(layout.root);
    heights = measured;
  } catch {
    heights = null;
  }
  if (cache.size >= HEIGHT_CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(key, heights);
  return heights;
}

function lineCountEstimate(
  line: DisplayLine,
  target: { env: SceneEnv; surface: Surface },
  width: number,
): number {
  const { env, surface } = target;
  const font = textFont(env, surface, "text");
  return measureWrappedLineCount(undefined, {
    text: line.map((run) => run.text).join("") || " ",
    font: font.font,
    fontSizePx: font.fontSizePx,
    maxWidthPx: width,
    wrap: "char",
    fallbackRatio: font.fallbackRatio,
  });
}

// ————————————————————————————————————————————————————————————————————————————
// App drawing
// ————————————————————————————————————————————————————————————————————————————

function appRule(context: MarkdownRenderContext, width: number, offset: number): AnyVNode {
  const animate = structureRevealAnimation(context, offset);
  return Box({
    width,
    height: APP_RULE_PX,
    background: context.env.palette.border,
    ...(animate ? { animate } : {}),
  });
}

function appHeaderFill(context: MarkdownRenderContext): string {
  return hexToRgba(context.env.palette.text, APP_HEADER_FILL_ALPHA);
}

function appGrid(block: TableBlock, layout: TableLayout, at: RevealAt): RenderedBlock {
  const { context, offset } = at;
  const { palette } = context.env;
  const typography = blockTypography(context);
  const rows = cellEntries(block, offset);
  const nodes: AnyVNode[] = [appRule(context, layout.width, offset)];
  let estimatedHeight = APP_RULE_PX;
  rows.forEach((row, rowIndex) => {
    const isHeader = rowIndex === 0;
    const rowOffset = row[0]?.offset ?? offset;
    const animate = structureRevealAnimation(context, rowOffset);
    const vertical = () => Box({ width: APP_RULE_PX, background: palette.border });
    const children: AnyVNode[] = [vertical()];
    let rowLines = 1;
    for (const entry of row) {
      const contentWidth = layout.columnWidths[entry.column] ?? 0;
      rowLines = Math.max(
        rowLines,
        lineCountEstimate(entry.line, { env: context.env, surface: "app" }, contentWidth),
      );
      children.push(
        Box(
          {
            width: contentWidth + APP_CELL_PAD_X * 2,
            padding: [APP_CELL_PAD_Y, APP_CELL_PAD_X, APP_CELL_PAD_Y, APP_CELL_PAD_X],
          },
          lineText(
            entry.line,
            { context, offset: entry.offset },
            {
              ...typography,
              width: contentWidth,
              color: palette.text,
              textAlign: textAlign(block.align[entry.column] ?? null),
              ...(isHeader ? strongStroke(context, palette.text) : {}),
            },
          ),
        ),
        vertical(),
      );
    }
    nodes.push(
      Flex(
        {
          direction: "row",
          width: layout.width,
          alignItems: "stretch",
          gap: 0,
          ...(isHeader ? { background: appHeaderFill(context) } : {}),
          ...(animate ? { animate } : {}),
        },
        ...children,
      ),
      appRule(context, layout.width, rowOffset),
    );
    estimatedHeight += rowLines * typography.lineHeightPx + APP_CELL_PAD_Y * 2 + APP_RULE_PX;
  });
  return {
    node: Flex({ direction: "column", width: layout.width, gap: 0 }, ...nodes),
    estimatedHeight,
  };
}

/**
 * The single-column fallback: each header cell on its own row, then for every
 * body row each cell as its column label with the cell's text beneath it.
 */
function appStacked(block: TableBlock, layout: TableLayout, at: RevealAt): RenderedBlock {
  const { context, offset } = at;
  const { palette, metrics } = context.env;
  const typography = blockTypography(context);
  const rows = cellEntries(block, offset);
  const contentWidth = Math.max(0, layout.width - APP_CELL_PAD_X * 2);
  const padding: [number, number, number, number] = [
    APP_CELL_PAD_Y,
    APP_CELL_PAD_X,
    APP_CELL_PAD_Y,
    APP_CELL_PAD_X,
  ];
  const header = rows[0] ?? [];
  const nodes: AnyVNode[] = [appRule(context, layout.width, offset)];
  let estimatedHeight = APP_RULE_PX;
  for (const entry of header) {
    const animate = structureRevealAnimation(context, entry.offset);
    nodes.push(
      Box(
        {
          width: layout.width,
          padding,
          background: appHeaderFill(context),
          ...(animate ? { animate } : {}),
        },
        lineText(
          columnLabel(header, entry.column),
          { context, offset: entry.offset },
          {
            ...typography,
            width: contentWidth,
            color: palette.text,
            ...strongStroke(context, palette.text),
            revealWhole: isBlank(entry.line),
          },
        ),
      ),
    );
    estimatedHeight +=
      lineCountEstimate(entry.line, { env: context.env, surface: "app" }, contentWidth) *
        typography.lineHeightPx +
      APP_CELL_PAD_Y * 2;
  }
  nodes.push(appRule(context, layout.width, closingTick(header, offset)));
  estimatedHeight += APP_RULE_PX;
  const labelOptions: LineTextOptions = {
    fontSizePx: metrics.uiPx,
    lineHeightPx: Math.round(metrics.uiPx * STACKED_LABEL_LINE_RATIO),
    family: typography.family,
    width: contentWidth,
    color: palette.muted,
    revealWhole: true,
  };
  for (const row of rows.slice(1)) {
    const lastOffset = closingTick(row, offset);
    const cells: AnyVNode[] = [];
    for (const entry of row) {
      cells.push(
        lineText(
          columnLabel(header, entry.column),
          { context, offset: entry.offset },
          labelOptions,
        ),
        lineText(
          entry.line,
          { context, offset: entry.offset },
          {
            ...typography,
            width: contentWidth,
            color: palette.text,
            textAlign: textAlign(block.align[entry.column] ?? null),
          },
        ),
      );
      estimatedHeight +=
        labelOptions.lineHeightPx +
        lineCountEstimate(entry.line, { env: context.env, surface: "app" }, contentWidth) *
          typography.lineHeightPx +
        STACKED_CELL_GAP_PX;
    }
    nodes.push(
      Box(
        { width: layout.width, padding },
        Flex({ direction: "column", width: contentWidth, gap: STACKED_CELL_GAP_PX }, ...cells),
      ),
      appRule(context, layout.width, lastOffset),
    );
    estimatedHeight += APP_CELL_PAD_Y * 2 + APP_RULE_PX;
  }
  return {
    node: Flex({ direction: "column", width: layout.width, gap: 0 }, ...nodes),
    estimatedHeight,
  };
}

function isBlank(line: DisplayLine): boolean {
  return line.every((run) => run.text.trim().length === 0);
}

/**
 * A stacked column's label: its header's text, or a generic one when that is
 * empty. The generic label is decoration and is shown whole with its cell.
 */
function columnLabel(header: CellEntry[], column: number): DisplayLine {
  const line = header[column]?.line ?? [];
  return !isBlank(line)
    ? line
    : [
        {
          text: genericColumnLabel(column),
          kind: "text",
          strong: false,
          emphasis: false,
          strikethrough: false,
          link: false,
        },
      ];
}

// ————————————————————————————————————————————————————————————————————————————
// TUI drawing: ASCII rules on the cell grid
// ————————————————————————————————————————————————————————————————————————————

function tuiText(
  context: MarkdownRenderContext,
  text: string,
  options: { width: number; offset: number; color: string },
): AnyVNode {
  const { metrics } = context.env;
  const animate = structureRevealAnimation(context, options.offset);
  return Text(
    {
      width: options.width,
      font: MONO_FONT,
      fallback: MONO_FALLBACK,
      fontSizePx: metrics.tuiFontPx,
      lineHeightPx: metrics.tuiLinePx,
      color: options.color,
      whiteSpace: "pre-wrap",
      wrap: "none",
      ...(animate ? { animate } : {}),
    },
    text,
  );
}

function tuiBorder(columnCells: number[]): string {
  return `+${columnCells.map((cells) => "-".repeat(cells + 2)).join("+")}+`;
}

function tuiGrid(block: TableBlock, layout: TableLayout, at: RevealAt): RenderedBlock {
  const { context, offset } = at;
  const { palette, metrics } = context.env;
  const typography = blockTypography(context);
  const cell = metrics.tuiCharPx;
  const columnCells = layout.columnWidths.map((width) => Math.round(width / cell));
  const rows = cellEntries(block, offset);
  const cellText = (entry: CellEntry, isHeader: boolean) =>
    lineText(
      entry.line,
      { context, offset: entry.offset },
      {
        ...typography,
        width: layout.columnWidths[entry.column] ?? cell,
        color: palette.text,
        textAlign: textAlign(block.align[entry.column] ?? null),
        ...(isHeader ? strongStroke(context, palette.text) : {}),
      },
    );
  const texts = rows.map((row, rowIndex) => row.map((entry) => cellText(entry, rowIndex === 0)));
  const measured = measureTextHeights(context.env.engine, {
    nodes: texts.flat(),
    width: Math.max(...layout.columnWidths, cell),
    // Streamed and instant cells are built differently, so both are keyed.
    key: JSON.stringify([block, layout.columnWidths, metrics, context.reveal]),
  });
  let measuredIndex = 0;
  const rowLines = rows.map((row) =>
    row.reduce((most, entry) => {
      const height = measured?.[measuredIndex];
      measuredIndex += 1;
      const count =
        height !== undefined
          ? Math.max(1, Math.round(height / metrics.tuiLinePx))
          : lineCountEstimate(
              entry.line,
              { env: context.env, surface: "tui" },
              layout.columnWidths[entry.column] ?? cell,
            );
      return Math.max(most, count);
    }, 1),
  );
  // Without rules between body rows, a wrapped row and a row that opens with
  // an empty cell read as one. Once any row wraps, every row gets a rule.
  const ruleEveryRow = rowLines.some((lines) => lines > 1);
  const border = tuiBorder(columnCells);
  const borderWidth = border.length * cell;
  const nodes: AnyVNode[] = [
    tuiText(context, border, { width: borderWidth, offset, color: palette.faint }),
  ];
  let lineCount = 1;
  rows.forEach((row, rowIndex) => {
    const rowOffset = row[0]?.offset ?? offset;
    const lines = rowLines[rowIndex] ?? 1;
    const rule = Array.from({ length: lines }, () => "|").join("\n");
    const children: AnyVNode[] = [
      tuiText(context, rule, { width: cell, offset: rowOffset, color: palette.faint }),
    ];
    row.forEach((_entry, column) => {
      children.push(
        Box(
          { width: ((columnCells[column] ?? 1) + 2) * cell, padding: [0, cell, 0, cell] },
          texts[rowIndex]?.[column] ?? Box({}),
        ),
        tuiText(context, rule, { width: cell, offset: rowOffset, color: palette.faint }),
      );
    });
    const animate = structureRevealAnimation(context, rowOffset);
    nodes.push(
      Flex(
        { direction: "row", width: borderWidth, gap: 0, ...(animate ? { animate } : {}) },
        ...children,
      ),
    );
    lineCount += lines;
    // A rule under the header and one closing the table, plus one under
    // every row when rows wrap.
    if (rowIndex === 0 || rowIndex === rows.length - 1 || ruleEveryRow) {
      nodes.push(
        tuiText(context, border, { width: borderWidth, offset: rowOffset, color: palette.faint }),
      );
      lineCount += 1;
    }
  });
  return {
    node: Flex({ direction: "column", width: borderWidth, gap: 0 }, ...nodes),
    estimatedHeight: lineCount * metrics.tuiLinePx,
  };
}

function tuiStacked(block: TableBlock, layout: TableLayout, at: RevealAt): RenderedBlock {
  const { context, offset } = at;
  const { palette, metrics } = context.env;
  const typography = blockTypography(context);
  const rows = cellEntries(block, offset);
  const header = rows[0] ?? [];
  const rule = `+${"-".repeat(Math.max(0, Math.round(layout.width / metrics.tuiCharPx) - 2))}+`;
  const ruleNode = (ruleOffset: number) =>
    tuiText(context, rule, { width: layout.width, offset: ruleOffset, color: palette.faint });
  const nodes: AnyVNode[] = [ruleNode(offset)];
  let lineCount = 1;
  for (const entry of header) {
    nodes.push(
      lineText(
        columnLabel(header, entry.column),
        { context, offset: entry.offset },
        {
          ...typography,
          width: layout.width,
          color: palette.text,
          ...strongStroke(context, palette.text),
          revealWhole: isBlank(entry.line),
        },
      ),
    );
    lineCount += lineCountEstimate(entry.line, { env: context.env, surface: "tui" }, layout.width);
  }
  nodes.push(ruleNode(closingTick(header, offset)));
  lineCount += 1;
  for (const row of rows.slice(1)) {
    const lastOffset = closingTick(row, offset);
    for (const entry of row) {
      nodes.push(
        lineText(
          columnLabel(header, entry.column),
          { context, offset: entry.offset },
          {
            ...typography,
            width: layout.width,
            color: palette.muted,
            revealWhole: true,
          },
        ),
        lineText(
          entry.line,
          { context, offset: entry.offset },
          {
            ...typography,
            width: layout.width,
            color: palette.text,
            textAlign: textAlign(block.align[entry.column] ?? null),
          },
        ),
      );
      lineCount +=
        1 + lineCountEstimate(entry.line, { env: context.env, surface: "tui" }, layout.width);
    }
    nodes.push(ruleNode(lastOffset));
    lineCount += 1;
  }
  return {
    node: Flex({ direction: "column", width: layout.width, gap: 0 }, ...nodes),
    estimatedHeight: lineCount * metrics.tuiLinePx,
  };
}

export function renderMarkdownTable(
  block: TableBlock,
  context: MarkdownRenderContext,
  offset: number,
): RenderedBlock {
  const layout = layoutMarkdownTable(block, context);
  const at = { context, offset };
  if (context.surface === "tui") {
    return layout.mode === "grid" ? tuiGrid(block, layout, at) : tuiStacked(block, layout, at);
  }
  return layout.mode === "grid" ? appGrid(block, layout, at) : appStacked(block, layout, at);
}
