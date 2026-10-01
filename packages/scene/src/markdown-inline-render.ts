/**
 * Inline Markdown as boundsvg text: the typography a block draws in, and the
 * styled runs of one display line with their reveal timing.
 *
 * Shared by block rendering and table rendering, which both lay out lines of
 * the same runs and have to time them identically.
 */

import {
  type AnyVNode,
  Box,
  Canvas,
  Flex,
  Inline,
  inspectScene,
  Text,
  type TextDecoration,
} from "@boundsvg/core";
import {
  chipRevealAnimation,
  revealUnitsFor,
  structureRevealAnimation,
  typedUnits,
} from "./animations.js";
import { MONO_FALLBACK, MONO_FONT, SANS_FALLBACK, SANS_FONT } from "./env.js";
import { draftGraphemeCount, draftGraphemes } from "./graphemes.js";
import type { MarkdownRenderContext } from "./markdown-render.js";
import type { DisplayLine, DisplayRun } from "./markdown-traversal.js";
import { PROBE_CANVAS_HEIGHT_PX } from "./measure.js";

type BlockTypography = {
  fontSizePx: number;
  lineHeightPx: number;
  family: { font: string; fallback: string[] };
};

/** Font, line height, and family for body text on the active surface. */
export function blockTypography(context: {
  env: MarkdownRenderContext["env"];
  surface: MarkdownRenderContext["surface"];
}): BlockTypography {
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

/** Synthetic bold: a thin stroke in the run's own color. */
export function strongStroke(
  context: MarkdownRenderContext,
  color: string,
): { textStrokes: Array<{ color: string; widthPx: number }> } {
  return { textStrokes: [{ color, widthPx: context.surface === "tui" ? 0.4 : 0.45 }] };
}

/** Where a piece of text starts: its render context and its first tick. */
export type RevealAt = { context: MarkdownRenderContext; offset: number };

/**
 * How far a width may run past a whole number of terminal cells and still
 * count as that many: measured widths carry floating-point noise.
 */
const CELL_ROUNDING_SLACK = 0.01;

/** Whole terminal cells a width needs. */
export function wholeCells(px: number, cellPx: number): number {
  return Math.ceil(px / cellPx - CELL_ROUNDING_SLACK);
}

/** Horizontal padding an inline-code chip adds on each side. */
export const CHIP_PAD_PX = 4;

function runColor(run: DisplayRun, context: MarkdownRenderContext): string {
  const { palette } = context.env;
  if (run.kind === "code") {
    return palette.codeText;
  }
  if (run.link) {
    return palette.accent;
  }
  return run.kind === "image" ? palette.muted : palette.text;
}

/**
 * The Inline nodes for one run, starting at `offset` ticks into the message.
 * `decorate: false` leaves the line-through off, for text whose units are
 * revealed one by one: boundsvg cannot combine the two, and the line is drawn
 * over the text instead (see `strikeOverlay`).
 */
function runInline(run: DisplayRun, at: RevealAt, decorate: boolean): ReturnType<typeof Inline> {
  const { context, offset } = at;
  const { env, surface } = context;
  const { palette, metrics } = env;
  const color = runColor(run, context);
  const strike: { textDecoration?: TextDecoration } =
    run.strikethrough && decorate ? { textDecoration: { line: "line-through", color } } : {};
  const style = {
    color,
    ...(run.strong ? strongStroke(context, color) : {}),
    ...(run.emphasis ? { fontStyle: "italic" as const } : {}),
    ...strike,
  };
  if (run.kind === "code") {
    const animate = chipRevealAnimation(context, offset);
    return Inline(
      {
        ...style,
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        background: surface === "tui" ? palette.panelStrong : palette.code,
        paddingInline: [CHIP_PAD_PX, CHIP_PAD_PX],
        borderRadius: surface === "tui" ? [2, 2, 2, 2] : [4, 4, 4, 4],
        ...(surface === "app" ? { fontSizePx: metrics.codePx } : {}),
        ...(animate ? { animate } : {}),
      },
      run.text,
    );
  }
  return Inline(style, run.text);
}

/** Inline nodes for a whole display line; an empty line keeps one empty run. */
function lineInlines(
  line: DisplayLine,
  at: RevealAt,
  decorate: boolean,
): Array<ReturnType<typeof Inline>> {
  const { context, offset } = at;
  if (line.length === 0) {
    return [Inline({ color: context.env.palette.text }, "")];
  }
  // The engine reveals a Text one cluster per tick, so a run's first tick is
  // the clusters before it, not the code points.
  let runOffset = offset;
  return line.map((run) => {
    const node = runInline(run, { context, offset: runOffset }, decorate);
    runOffset += draftGraphemeCount(run.text);
    return node;
  });
}

type ProbedLine = {
  width: number;
  baselineY: number;
  fragments: Array<{ glyphs: Array<{ xAdvance: number }> }>;
};
type ProbedUnit = {
  sourceStart: number;
  sourceEnd: number;
  members: Array<{ lineIndex: number; glyphIndex: number }>;
};
type ProbedText = {
  type: "text";
  lines: ProbedLine[];
  unitMap?: { units: ProbedUnit[] };
};

function findProbedText(node: unknown): ProbedText | undefined {
  if (node === null || typeof node !== "object") {
    return undefined;
  }
  const candidate = node as { type?: string; children?: unknown[] };
  if (candidate.type === "text") {
    return candidate as ProbedText;
  }
  for (const child of candidate.children ?? []) {
    const found = findProbedText(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Probed layouts by what decides them, per engine; fonts live in the engine. */
const probeCache = new WeakMap<object, Map<string, ProbedText | null>>();
/** Probed lines kept per engine before the cache starts over. */
const PROBE_CACHE_LIMIT = 2_000;

/** Only what the geometry reads: the rest of an inspected text node is large. */
function slimProbe(probed: ProbedText): ProbedText {
  return {
    type: "text",
    lines: probed.lines.map((line) => ({
      width: line.width,
      baselineY: line.baselineY,
      fragments: line.fragments.map((fragment) => ({
        glyphs: fragment.glyphs.map((glyph) => ({ xAdvance: glyph.xAdvance })),
      })),
    })),
    ...(probed.unitMap
      ? {
          unitMap: {
            units: probed.unitMap.units.map((unit) => ({
              sourceStart: unit.sourceStart,
              sourceEnd: unit.sourceEnd,
              members: unit.members.map((member) => ({
                lineIndex: member.lineIndex,
                glyphIndex: member.glyphIndex,
              })),
            })),
          },
        }
      : {}),
  };
}

/**
 * Lay a Text out on the engine and read back its lines and units, or
 * `undefined` without an engine or when the probe fails. `key` names
 * everything the layout depends on — the runs, their typography and the
 * width — so an unchanged line is not laid out again on the next build.
 */
function probeText(
  context: MarkdownRenderContext,
  request: { text: AnyVNode; width: number; key: string },
): ProbedText | undefined {
  const engine = context.env.engine;
  if (engine === undefined) {
    return undefined;
  }
  let cache = probeCache.get(engine);
  if (cache === undefined) {
    cache = new Map();
    probeCache.set(engine, cache);
  }
  const cached = cache.get(request.key);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let probed: ProbedText | null = null;
  try {
    const inspection = inspectScene(
      engine,
      Canvas(
        { width: Math.max(1, Math.ceil(request.width)), height: PROBE_CANVAS_HEIGHT_PX },
        request.text,
      ),
      { skipValidation: true, timeMs: 0 },
    );
    const found = findProbedText(inspection.ir.root);
    probed = found === undefined ? null : slimProbe(found);
  } catch {
    probed = null;
  }
  if (cache.size >= PROBE_CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(request.key, probed);
  return probed ?? undefined;
}

/** Everything a line's layout depends on, as a cache key. */
function layoutKey(
  line: DisplayLine,
  context: MarkdownRenderContext,
  options: LineTextOptions,
): string {
  return JSON.stringify([context.surface, context.env.metrics, options, line]);
}

type UnitGeometry = {
  /** The unit's cluster index in the line: its reveal tick after the line's first. */
  cluster: number;
  /** The unit's range in the line's joined text, in UTF-16 code units. */
  start: number;
  end: number;
  lineIndex: number;
  /** Start of the unit's first glyph, from the start of its line. */
  left: number;
  /** Summed advance of the unit's glyphs on that line. */
  width: number;
  baselineY: number;
};

/**
 * Where each probed unit sits on its line.
 *
 * The engine numbers units by cluster, not by source position, so the
 * clusters are counted here with the same segmenter to recover each unit's
 * range in the text. Glyph advances do not include an inline-code chip's side
 * padding, so every chip edge between the start of the line and a unit moves
 * that unit right by one padding. Only start-aligned text is probed, so every
 * line starts at 0.
 */
function unitGeometry(probed: ProbedText, line: DisplayLine): UnitGeometry[] {
  const source = line.map((run) => run.text).join("");
  const clusterStarts: number[] = [];
  let cursor = 0;
  for (const cluster of draftGraphemes(source)) {
    clusterStarts.push(cursor);
    cursor += cluster.length;
  }
  clusterStarts.push(cursor);
  const chipEdges: number[] = [];
  let position = 0;
  for (const run of line) {
    if (run.kind === "code") {
      chipEdges.push(position, position + run.text.length);
    }
    position += run.text.length;
  }
  const lines = probed.lines.map((probedLine) => {
    const advances = probedLine.fragments.flatMap((fragment) =>
      fragment.glyphs.map((glyph) => glyph.xAdvance),
    );
    const positions: number[] = [];
    let x = 0;
    for (const advance of advances) {
      positions.push(x);
      x += advance;
    }
    return { advances, positions, baselineY: probedLine.baselineY };
  });
  const units = (probed.unitMap?.units ?? []).map((unit) => ({
    unit,
    start: clusterStarts[unit.sourceStart] ?? cursor,
    end: clusterStarts[unit.sourceEnd] ?? cursor,
  }));
  const lineStarts = new Map<number, number>();
  for (const { unit, start } of units) {
    const lineIndex = unit.members[0]?.lineIndex;
    if (lineIndex !== undefined) {
      lineStarts.set(lineIndex, Math.min(lineStarts.get(lineIndex) ?? start, start));
    }
  }
  return units.flatMap(({ unit, start, end }) => {
    const first = unit.members[0];
    const glyphs = first ? lines[first.lineIndex] : undefined;
    if (first === undefined || glyphs === undefined) {
      return [];
    }
    const lineStart = lineStarts.get(first.lineIndex) ?? 0;
    // A chip's opening edge counts once reached; its closing edge once passed.
    const padding =
      chipEdges.filter((edge, index) =>
        index % 2 === 0 ? edge >= lineStart && edge <= start : edge > lineStart && edge <= start,
      ).length * CHIP_PAD_PX;
    const width = unit.members.reduce(
      (sum, member) =>
        member.lineIndex === first.lineIndex
          ? sum + (glyphs.advances[member.glyphIndex] ?? 0)
          : sum,
      0,
    );
    return [
      {
        cluster: unit.sourceStart,
        start,
        end,
        lineIndex: first.lineIndex,
        left: (glyphs.positions[first.glyphIndex] ?? 0) + padding,
        width,
        baselineY: glyphs.baselineY,
      },
    ];
  });
}

/** Where a strike sits above the baseline, as a share of the font size. */
const STRIKE_RAISE_EM = 0.3;

/**
 * A line-through drawn over streamed text, one stroke per cluster, each shown
 * with its own cluster.
 *
 * The strokes are placed from the engine's own layout of the same Text, so
 * they follow its wraps and alignment exactly; an inline placeholder would be
 * left at the end of the previous line whenever a struck cluster wraps.
 * Returns `null` when there is nothing to place against: no engine, or a
 * probe that failed.
 */
function strikeOverlay(
  subject: { text: AnyVNode; line: DisplayLine; options: LineTextOptions },
  at: RevealAt,
): AnyVNode | null {
  const { text, line, options } = subject;
  const { context, offset } = at;
  const probed = probeText(context, {
    text,
    width: options.width,
    key: layoutKey(line, context, options),
  });
  if (probed?.unitMap === undefined) {
    return null;
  }
  // Struck ranges of the line's joined text, in UTF-16 code units.
  const struck: Array<{ start: number; end: number; color: string }> = [];
  let position = 0;
  for (const run of line) {
    if (run.strikethrough) {
      struck.push({
        start: position,
        end: position + run.text.length,
        color: runColor(run, context),
      });
    }
    position += run.text.length;
  }
  const thickness = Math.max(1, Math.round(options.fontSizePx / 14));
  const strokes: AnyVNode[] = [];
  for (const placed of unitGeometry(probed, line)) {
    const range = struck.find((entry) => placed.start >= entry.start && placed.end <= entry.end);
    if (range === undefined) {
      continue;
    }
    // The engine reveals one cluster per tick from the line's first.
    const animate = structureRevealAnimation(context, offset + placed.cluster);
    strokes.push(
      Box({
        position: "absolute",
        left: placed.left,
        top: placed.baselineY - options.fontSizePx * STRIKE_RAISE_EM - thickness / 2,
        width: placed.width,
        height: thickness,
        background: range.color,
        ...(animate ? { animate } : {}),
      }),
    );
  }
  return Box({ position: "relative", width: options.width }, text, ...strokes);
}

export type LineTextOptions = {
  width: number;
  fontSizePx: number;
  lineHeightPx: number;
  family: { font: string; fallback: string[] };
  color: string;
  textAlign?: "start" | "center" | "end";
  textStrokes?: Array<{ color: string; widthPx: number }>;
  whiteSpace?: "normal" | "pre-wrap";
  /** "none" for text already cut to one visual line; defaults to "char". */
  wrap?: "char" | "none";
  /** Show the whole line when its first tick comes up instead of streaming it. */
  revealWhole?: boolean;
};

/** One display line as a single wrapping Text that reveals from `offset`. */
function singleLineText(line: DisplayLine, at: RevealAt, options: LineTextOptions): AnyVNode {
  const { context, offset } = at;
  const units = options.revealWhole ? undefined : revealUnitsFor(context, offset);
  const whole = options.revealWhole ? structureRevealAnimation(context, offset) : undefined;
  const overlayStrike = units !== undefined && line.some((run) => run.strikethrough);
  const text = Text(
    {
      width: options.width,
      font: options.family.font,
      fallback: options.family.fallback,
      fontSizePx: options.fontSizePx,
      lineHeightPx: options.lineHeightPx,
      color: options.color,
      wrap: options.wrap ?? "char",
      ...(options.textAlign !== undefined ? { textAlign: options.textAlign } : {}),
      ...(options.textStrokes !== undefined ? { textStrokes: options.textStrokes } : {}),
      ...(options.whiteSpace !== undefined ? { whiteSpace: options.whiteSpace } : {}),
      ...(units ? { animateUnits: units } : {}),
      ...(whole ? { animate: whole } : {}),
    },
    ...lineInlines(
      line,
      { context: options.revealWhole ? { ...context, reveal: "instant" } : context, offset },
      !overlayStrike,
    ),
  );
  if (!overlayStrike) {
    return text;
  }
  // Without a layout to place strokes on, the line keeps its line-through by
  // showing whole with its first tick instead of streaming.
  return (
    strikeOverlay({ text, line, options }, at) ??
    singleLineText(line, at, { ...options, revealWhole: true })
  );
}

/** The runs of a line between two UTF-16 positions of its joined text. */
function sliceLine(line: DisplayLine, start: number, end: number): DisplayLine {
  const slice: DisplayLine = [];
  let position = 0;
  for (const run of line) {
    const runStart = Math.max(start, position);
    const runEnd = Math.min(end, position + run.text.length);
    if (runEnd > runStart) {
      slice.push({ ...run, text: run.text.slice(runStart - position, runEnd - position) });
    }
    position += run.text.length;
  }
  return slice;
}

/**
 * Reveal timing for a probe. The unit map the wraps are read from only exists
 * on unit-animated text; when the units play does not change where they sit.
 */
const PROBE_UNITS = typedUnits(0, 1, 0);

/**
 * Centred or end-aligned text, one Text per visual line.
 *
 * The wraps are read from the engine, each line becomes a Text exactly as wide
 * as its words, and the column aligns those. A terminal moves them by whole
 * cells, which the engine's own centring does not. Streamed text needs the
 * split on both surfaces: its strike strokes are placed on a start-aligned
 * layout (see `strikeOverlay`). Returns `null` when there is nothing to probe
 * with.
 */
function alignedLineText(
  line: DisplayLine,
  at: RevealAt,
  options: LineTextOptions,
): AnyVNode | null {
  const { context, offset } = at;
  const probe = Text(
    {
      animateUnits: PROBE_UNITS,
      width: options.width,
      font: options.family.font,
      fallback: options.family.fallback,
      fontSizePx: options.fontSizePx,
      lineHeightPx: options.lineHeightPx,
      color: options.color,
      wrap: "char",
      ...(options.textStrokes !== undefined ? { textStrokes: options.textStrokes } : {}),
      ...(options.whiteSpace !== undefined ? { whiteSpace: options.whiteSpace } : {}),
    },
    ...lineInlines(line, { context: { ...context, reveal: "instant" }, offset }, false),
  );
  const probed = probeText(context, {
    text: probe,
    width: options.width,
    key: layoutKey(line, context, { ...options, textAlign: "start" }),
  });
  const probedUnits = probed?.unitMap?.units;
  if (probed === undefined || probedUnits === undefined || probed.lines.length === 0) {
    return null;
  }
  const source = line.map((run) => run.text).join("");
  const chips: Array<{ start: number; end: number }> = [];
  let position = 0;
  for (const run of line) {
    if (run.kind === "code") {
      chips.push({ start: position, end: position + run.text.length });
    }
    position += run.text.length;
  }
  const chipEnds = new Set(chips.map((chip) => chip.end));
  /** A chip cut by a line boundary: each piece is drawn with its own padding. */
  const cutsChip = (at: number) => chips.some((chip) => chip.start < at && at < chip.end);
  const spans = probed.lines.map(() => ({
    start: Number.POSITIVE_INFINITY,
    end: -1,
    cluster: 0,
    width: 0,
  }));
  for (const placed of unitGeometry(probed, line)) {
    const span = spans[placed.lineIndex];
    if (span === undefined) {
      continue;
    }
    if (placed.start < span.start) {
      span.start = placed.start;
      span.cluster = placed.cluster;
    }
    span.end = Math.max(span.end, placed.end);
    // Trailing blanks hang past the line; they do not move it. A chip's
    // closing padding follows its last glyph.
    if (/\S/u.test(source.slice(placed.start, placed.end))) {
      const closesChip = chipEnds.has(placed.end);
      span.width = Math.max(
        span.width,
        placed.left + placed.width + (closesChip ? CHIP_PAD_PX : 0),
      );
    }
  }
  const lines = spans.flatMap((span) => {
    if (span.end < 0) {
      return [];
    }
    const trimmedEnd = span.start + source.slice(span.start, span.end).trimEnd().length;
    const inked =
      span.width +
      (cutsChip(span.start) ? CHIP_PAD_PX : 0) +
      (cutsChip(trimmedEnd) ? CHIP_PAD_PX : 0);
    const width = alignedWidth(context, inked, options.width);
    // The piece is already one visual line; it must not wrap again however
    // its measured width rounds.
    const segment = singleLineText(
      sliceLine(line, span.start, trimmedEnd),
      // One tick per cluster from the line's first, as the unsplit text had.
      { context, offset: offset + span.cluster },
      { ...options, width, textAlign: "start", wrap: "none" },
    );
    return [
      Box(
        {
          width: options.width,
          padding: [0, 0, 0, alignedInset(context, options.width - width, options.textAlign)],
        },
        segment,
      ),
    ];
  });
  return Flex({ direction: "column", width: options.width, gap: 0 }, ...lines);
}

/**
 * A visual line's own width, never past the column. Terminal text sits on
 * whole cells; app text gets a pixel of slack so it cannot wrap again.
 */
function alignedWidth(context: MarkdownRenderContext, inked: number, available: number): number {
  const cell = context.env.metrics.tuiCharPx;
  const width = context.surface === "tui" ? wholeCells(inked, cell) * cell : Math.ceil(inked) + 1;
  return Math.min(available, width);
}

/** How far a line moves right to centre or end-align it; whole cells on the TUI. */
function alignedInset(
  context: MarkdownRenderContext,
  slack: number,
  align: LineTextOptions["textAlign"],
): number {
  const inset = align === "center" ? slack / 2 : slack;
  if (context.surface !== "tui") {
    return Math.max(0, inset);
  }
  const cell = context.env.metrics.tuiCharPx;
  return Math.max(0, Math.floor(inset / cell + CELL_ROUNDING_SLACK) * cell);
}

/** One display line as wrapping text that reveals from `offset`. */
export function lineText(line: DisplayLine, at: RevealAt, options: LineTextOptions): AnyVNode {
  const streamed = !options.revealWhole && at.context.reveal !== "instant";
  const aligned = options.textAlign === "center" || options.textAlign === "end";
  if ((streamed || at.context.surface === "tui") && aligned && line.length > 0) {
    const split = alignedLineText(line, at, options);
    if (split !== null) {
      return split;
    }
  }
  return singleLineText(line, at, options);
}
