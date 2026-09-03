import { Canvas, type Engine, Flex, type LayoutNode, Text } from "@boundsvg/core";
import { wasmUax14LineBreaks } from "@boundsvg/core/wasm";
import { draftGraphemeCount, draftGraphemes } from "./graphemes.js";

/** Contextual shaping is disabled so prefix line counts are monotone. */
export const DRAFT_FONT_FEATURES = '"liga" 0, "clig" 0, "calt" 0, "kern" 0';

export type DraftWrapOptions = {
  widthPx: number;
  fontPx: number;
  lineHeightPx: number;
  font: string;
  fallback: string[];
  fallbackRatio: number;
  engine?: Engine | undefined;
};

export type ComposerDraftPlan = {
  lines: string[];
  /** Grapheme offset of each visual line in the normalized finished draft. */
  lineStartOffsets: number[];
  lineEndOffsets: number[];
  /** Prefix-wrap times; populated only for a resolved full-draft timing. */
  newlineTimesMs: number[];
};

const draftWrapCaches = new WeakMap<Engine, Map<string, Array<string[] | null>>>();
const draftMetricCaches = new WeakMap<Engine, Map<string, number[]>>();
const DRAFT_WRAP_CACHE_LIMIT = 500;

export function estimatedClusterWidth(cluster: string, wrap: DraftWrapOptions): number {
  const code = cluster.codePointAt(0) ?? 0;
  return code > 0x2e7f ? wrap.fontPx : wrap.fontPx * wrap.fallbackRatio;
}

function wrapDraftLine(hardLine: string, wrap: DraftWrapOptions): string[] {
  const pieces: string[] = [];
  let piece = "";
  let pieceWidth = 0;
  for (const cluster of draftGraphemes(hardLine)) {
    const clusterWidth = estimatedClusterWidth(cluster, wrap);
    if (pieceWidth + clusterWidth > wrap.widthPx && piece.length > 0) {
      pieces.push(piece);
      piece = cluster;
      pieceWidth = clusterWidth;
    } else {
      piece += cluster;
      pieceWidth += clusterWidth;
    }
  }
  pieces.push(piece);
  return pieces;
}

function draftWrapCache(engine: Engine): Map<string, Array<string[] | null>> {
  let cache = draftWrapCaches.get(engine);
  if (cache === undefined) {
    cache = new Map();
    draftWrapCaches.set(engine, cache);
  }
  return cache;
}

function draftWrapCacheKey(hardLines: string[], wrap: DraftWrapOptions): string {
  return JSON.stringify([
    wrap.widthPx,
    wrap.fontPx,
    wrap.lineHeightPx,
    wrap.font,
    wrap.fallback,
    wrap.fallbackRatio,
    DRAFT_FONT_FEATURES,
    hardLines,
  ]);
}

/**
 * Resolve many independent prefixes in one engine traversal. Word wrapping
 * can move an already-painted word when a later word arrives, so the final
 * layout alone cannot reveal the transition time. Batching the binary-search
 * probes keeps the exact engine semantics without one WASM round trip per
 * grapheme.
 */
function measureDraftWrapBatch(
  engine: Engine,
  texts: readonly string[],
  wrap: DraftWrapOptions,
): Map<string, Array<string[] | null>> {
  const cache = draftWrapCache(engine);
  const results = new Map<string, Array<string[] | null>>();
  const pending: Array<{ text: string; hardLines: string[]; cacheKey: string }> = [];
  for (const text of new Set(texts)) {
    const hardLines = text.split("\n");
    const cacheKey = draftWrapCacheKey(hardLines, wrap);
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      results.set(text, cached);
    } else {
      pending.push({ text, hardLines, cacheKey });
    }
  }
  if (pending.length === 0) {
    return results;
  }
  try {
    const probe = Canvas(
      { width: Math.max(60, Math.ceil(wrap.widthPx)), height: 32_000 },
      ...pending.map((entry, textIndex) =>
        Flex(
          {
            position: "absolute",
            left: 0,
            top: 0,
            width: wrap.widthPx,
            direction: "column",
            gap: 0,
          },
          ...entry.hardLines.map((hardLine, hardIndex) =>
            Text(
              {
                width: wrap.widthPx,
                font: wrap.font,
                fallback: wrap.fallback,
                fontSizePx: wrap.fontPx,
                lineHeightPx: wrap.lineHeightPx,
                fontFeatureSettings: DRAFT_FONT_FEATURES,
                wrap: "char",
                whiteSpace: "pre-wrap",
                meta: { edit: `draft:${textIndex}:${hardIndex}` },
              },
              hardLine.length > 0 ? hardLine : " ",
            ),
          ),
        ),
      ),
    );
    const layout = engine.renderToLayoutTree(probe, { skipValidation: true });
    const linesById = new Map<string, string[]>();
    const walk = (node: LayoutNode): void => {
      const meta = (node.vnode as { props?: { meta?: Record<string, string> } }).props?.meta;
      const id = meta?.edit;
      const resolved = node.textLayout?.resolvedTextLayout;
      if (id !== undefined && resolved !== undefined && !linesById.has(id)) {
        linesById.set(
          id,
          resolved.lines.map((line) => line.text),
        );
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(layout.root);
    if (cache.size + pending.length > DRAFT_WRAP_CACHE_LIMIT) {
      cache.clear();
    }
    pending.forEach((entry, textIndex) => {
      const result = entry.hardLines.map(
        (_hardLine, hardIndex) => linesById.get(`draft:${textIndex}:${hardIndex}`) ?? null,
      );
      cache.set(entry.cacheKey, result);
      results.set(entry.text, result);
    });
  } catch {
    for (const entry of pending) {
      const result = entry.hardLines.map(() => null);
      cache.set(entry.cacheKey, result);
      results.set(entry.text, result);
    }
  }
  return results;
}

function alignMeasuredLines(
  hardLine: string,
  measuredLines: string[],
): { pieces: string[]; offsets: number[] } | null {
  const source = draftGraphemes(hardLine);
  const pieces: string[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of measuredLines) {
    const clusters = draftGraphemes(line);
    while (
      cursor < source.length &&
      source[cursor] !== clusters[0] &&
      /^ +$/u.test(source[cursor] ?? "")
    ) {
      cursor += 1;
    }
    offsets.push(cursor);
    for (const cluster of clusters) {
      if (source[cursor] !== cluster) {
        return null;
      }
      cursor += 1;
    }
    pieces.push(line);
  }
  while (cursor < source.length && /^ +$/u.test(source[cursor] ?? "")) {
    cursor += 1;
  }
  return cursor === source.length && pieces.length > 0 ? { pieces, offsets } : null;
}

function planHardLine(hardLine: string, measured: string[] | null, wrap: DraftWrapOptions) {
  if (hardLine.length === 0) {
    return { pieces: [""], offsets: [0] };
  }
  const aligned = measured === null ? null : alignMeasuredLines(hardLine, measured);
  if (aligned !== null) {
    return aligned;
  }
  const pieces = wrapDraftLine(hardLine, wrap);
  const offsets: number[] = [];
  let local = 0;
  for (const piece of pieces) {
    offsets.push(local);
    local += draftGraphemeCount(piece);
  }
  return { pieces, offsets };
}

function buildDraftPlan(
  text: string,
  measured: Array<string[] | null> | undefined,
  wrap: DraftWrapOptions,
): ComposerDraftPlan {
  const hardLines = text.split("\n");
  const lines: string[] = [];
  const lineStartOffsets: number[] = [];
  const lineEndOffsets: number[] = [];
  let offset = 0;
  hardLines.forEach((hardLine, hardIndex) => {
    const { pieces, offsets } = planHardLine(hardLine, measured?.[hardIndex] ?? null, wrap);
    pieces.forEach((piece, pieceIndex) => {
      const start = offset + (offsets[pieceIndex] ?? 0);
      lines.push(piece);
      lineStartOffsets.push(start);
      lineEndOffsets.push(start + draftGraphemeCount(piece));
    });
    offset += draftGraphemeCount(hardLine);
    if (hardIndex < hardLines.length - 1) {
      offset += 1;
    }
  });
  return {
    lines,
    lineStartOffsets,
    lineEndOffsets,
    newlineTimesMs: [],
  };
}

export function planDraftTexts(
  texts: readonly string[],
  wrap: DraftWrapOptions,
): Map<string, ComposerDraftPlan> {
  const unique = [...new Set(texts)];
  const measured = wrap.engine ? measureDraftWrapBatch(wrap.engine, unique, wrap) : new Map();
  return new Map(unique.map((text) => [text, buildDraftPlan(text, measured.get(text), wrap)]));
}

/** Exact visual lines for one already-normalized draft state. */
export function planDraftText(text: string, wrap: DraftWrapOptions): ComposerDraftPlan {
  const plan = planDraftTexts([text], wrap).get(text);
  if (plan === undefined) {
    throw new Error("Draft layout planner did not return the requested text");
  }
  return plan;
}

function draftMetricCache(engine: Engine): Map<string, number[]> {
  let cache = draftMetricCaches.get(engine);
  if (cache === undefined) {
    cache = new Map();
    draftMetricCaches.set(engine, cache);
  }
  return cache;
}

/** One exact inline advance per grapheme, shaped in a single engine probe. */
export function measuredClusterWidths(
  engine: Engine,
  text: string,
  wrap: DraftWrapOptions,
): number[] {
  const clusters = draftGraphemes(text);
  const cache = draftMetricCache(engine);
  const key = JSON.stringify([
    wrap.fontPx,
    wrap.font,
    wrap.fallback,
    wrap.fallbackRatio,
    DRAFT_FONT_FEATURES,
    text,
  ]);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const fallback = clusters.map((cluster) =>
    cluster === "\n" ? 0 : estimatedClusterWidth(cluster, wrap),
  );
  try {
    const probe = Canvas(
      { width: Math.max(60, Math.ceil(wrap.widthPx)), height: 32_000 },
      Text(
        {
          width: wrap.widthPx,
          font: wrap.font,
          fallback: wrap.fallback,
          fontSizePx: wrap.fontPx,
          lineHeightPx: wrap.lineHeightPx,
          fontFeatureSettings: DRAFT_FONT_FEATURES,
          wrap: "none",
          whiteSpace: "pre-wrap",
          meta: { edit: "draft-metrics" },
        },
        text.length > 0 ? text : " ",
      ),
    );
    const layout = engine.renderToLayoutTree(probe, { skipValidation: true });
    const widths = Array.from({ length: clusters.length }, () => 0);
    const seen = new Set<number>();
    const walk = (node: LayoutNode): void => {
      const meta = (node.vnode as { props?: { meta?: Record<string, string> } }).props?.meta;
      if (meta?.edit === "draft-metrics") {
        for (const line of node.textLayout?.resolvedTextLayout.lines ?? []) {
          for (const glyph of line.positionedGlyphs ?? []) {
            const sourceStart = glyph.sourceStart;
            if (
              sourceStart !== undefined &&
              sourceStart >= 0 &&
              sourceStart < widths.length &&
              clusters[sourceStart] !== "\n"
            ) {
              widths[sourceStart] = (widths[sourceStart] ?? 0) + glyph.xAdvance;
              seen.add(sourceStart);
            }
          }
        }
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(layout.root);
    for (let index = 0; index < widths.length; index += 1) {
      if (!seen.has(index)) {
        widths[index] = fallback[index] ?? 0;
      }
    }
    if (cache.size >= DRAFT_WRAP_CACHE_LIMIT) {
      cache.clear();
    }
    cache.set(key, widths);
    return widths;
  } catch {
    cache.set(key, fallback);
    return fallback;
  }
}

const UTF8_ENCODER = new TextEncoder();

/** UAX14 reports UTF-8 byte offsets; translate them to grapheme prefixes. */
export function breakablePrefixes(clusters: readonly string[]): Set<number> {
  let breaks: Set<number>;
  try {
    breaks = new Set(wasmUax14LineBreaks(clusters.join("")));
  } catch {
    breaks = new Set();
  }
  const prefixes = new Set<number>();
  let byteOffset = 0;
  for (let index = 0; index < clusters.length; index += 1) {
    byteOffset += UTF8_ENCODER.encode(clusters[index] ?? "").length;
    if (breaks.has(byteOffset) || /^\s$/u.test(clusters[index] ?? "")) {
      prefixes.add(index + 1);
    }
  }
  return prefixes;
}

export type StreamingWrapState = { prefixLength: number; lineStarts: number[] };

export function streamingWrapStates(options: {
  clusters: readonly string[];
  widths: readonly number[];
  breakAfter: ReadonlySet<number>;
  widthPx: number;
}): StreamingWrapState[] {
  const { clusters, widths, breakAfter, widthPx } = options;
  const cumulative = [0];
  for (const width of widths) {
    cumulative.push((cumulative.at(-1) ?? 0) + width);
  }
  const inlineWidth = (from: number, to: number): number =>
    (cumulative[to] ?? 0) - (cumulative[from] ?? 0);
  const lineStarts = [0];
  const states: StreamingWrapState[] = [{ prefixLength: 0, lineStarts: [0] }];
  let lineStart = 0;
  for (let index = 0; index < clusters.length; index += 1) {
    const end = index + 1;
    if (clusters[index] === "\n") {
      lineStart = end;
      lineStarts.push(lineStart);
      states.push({ prefixLength: end, lineStarts: [...lineStarts] });
      continue;
    }
    let changed = false;
    while (inlineWidth(lineStart, end) > widthPx && end - lineStart > 1) {
      let breakAt: number | undefined;
      for (let candidate = end - 1; candidate > lineStart; candidate -= 1) {
        if (breakAfter.has(candidate) && inlineWidth(lineStart, candidate) <= widthPx) {
          breakAt = candidate;
          break;
        }
      }
      breakAt ??= end - 1;
      lineStart = breakAt;
      lineStarts.push(lineStart);
      changed = true;
    }
    if (changed) {
      states.push({ prefixLength: end, lineStarts: [...lineStarts] });
    }
  }
  return states;
}

export function planDraftStreamingPrefix(options: {
  clusters: readonly string[];
  prefixLength: number;
  lineStarts: readonly number[];
}): ComposerDraftPlan {
  const { clusters, prefixLength, lineStarts } = options;
  const lines: string[] = [];
  const lineStartOffsets: number[] = [];
  const lineEndOffsets: number[] = [];
  for (let index = 0; index < lineStarts.length; index += 1) {
    const start = lineStarts[index] ?? 0;
    const boundary = Math.min(prefixLength, lineStarts[index + 1] ?? prefixLength);
    const end = boundary > start && clusters[boundary - 1] === "\n" ? boundary - 1 : boundary;
    lines.push(clusters.slice(start, end).join(""));
    lineStartOffsets.push(start);
    lineEndOffsets.push(end);
  }
  return { lines, lineStartOffsets, lineEndOffsets, newlineTimesMs: [] };
}

export function sameVisualLines(left: ComposerDraftPlan, right: ComposerDraftPlan): boolean {
  return (
    JSON.stringify(left.lines) === JSON.stringify(right.lines) &&
    JSON.stringify(left.lineStartOffsets) === JSON.stringify(right.lineStartOffsets) &&
    JSON.stringify(left.lineEndOffsets) === JSON.stringify(right.lineEndOffsets)
  );
}
