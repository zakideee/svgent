import { type AnyVNode, Canvas, type Engine, Flex, type LayoutNode } from "@boundsvg/core";
import { fallbackFor } from "./env.js";
import { draftGraphemes } from "./graphemes.js";
import type { ContentAlign } from "./model.js";

export function measureLineWidthPx(
  engine: Engine | undefined,
  probe: {
    text: string;
    font: string;
    fontSizePx: number;
    fallbackRatio: number;
    fallback?: string[];
    fontFeatureSettings?: string;
  },
): number {
  const { text, font, fontSizePx, fallbackRatio, fallback, fontFeatureSettings } = probe;
  if (engine) {
    try {
      return engine.measureTextBlock({
        text,
        fontFamily: font,
        fallback: fallback ?? fallbackFor(font),
        fontSizePx,
        ...(fontFeatureSettings === undefined ? {} : { fontFeatureSettings }),
        wrap: "none",
        maxWidth: 1_000_000,
      }).usedWidth;
    } catch {
      // No measurement API on this engine build — use the ratio estimate.
    }
  }
  return draftGraphemes(text).reduce((width, cluster) => {
    const code = cluster.codePointAt(0) ?? 0;
    return width + fontSizePx * (code > 0x2e7f ? 1 : fallbackRatio);
  }, 0);
}

/**
 * How many visual lines one run of text takes at a given wrap width.
 *
 * Blocks that stack their in-progress and settled states at the same origin
 * cannot let the engine grow a container for them — they have to know the
 * height before laying the states out. The ratio estimate keeps engine-free
 * paths (validation, tests) from collapsing every such block back to one
 * line, and leans slightly wide so a row reserves space rather than clipping.
 */
export function measureWrappedLineCount(
  engine: Engine | undefined,
  probe: {
    text: string;
    font: string;
    fontSizePx: number;
    maxWidthPx: number;
    wrap: "word" | "char";
    fallbackRatio: number;
    /** "pre-wrap" keeps authored newlines as breaks instead of spaces. */
    whiteSpace?: "normal" | "pre-wrap";
  },
): number {
  const { text, font, fontSizePx, maxWidthPx, wrap, fallbackRatio, whiteSpace } = probe;
  if (maxWidthPx <= 0 || text.length === 0) {
    return 1;
  }
  if (engine) {
    try {
      return Math.max(
        1,
        engine.measureTextBlock({
          text,
          fontFamily: font,
          fallback: fallbackFor(font),
          fontSizePx,
          wrap,
          maxWidth: maxWidthPx,
          ...(whiteSpace !== undefined ? { whiteSpace } : {}),
        }).lineCount,
      );
    } catch {
      // No measurement API on this engine build — use the ratio estimate.
    }
  }
  let lines = 1;
  let used = 0;
  for (const character of Array.from(text)) {
    if (whiteSpace === "pre-wrap" && character === "\n") {
      lines += 1;
      used = 0;
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    // Fullwidth/CJK glyphs run ~1em, latin/ASCII the caller's ratio.
    const charWidth = (code > 0x2e7f ? 1 : fallbackRatio) * fontSizePx;
    if (used + charWidth > maxWidthPx && used > 0) {
      lines += 1;
      used = charWidth;
    } else {
      used += charWidth;
    }
  }
  return lines;
}

// Measured heights keyed by content+context, per engine (fonts are baked
// into the engine, so a font change means a new engine and a fresh cache).
// An edit re-probes only the changed message instead of the whole page.
const heightCaches = new WeakMap<Engine, Map<string, number>>();
const HEIGHT_CACHE_LIMIT = 4_000;

export function measureMessageHeights(
  engine: Engine,
  probeInput: { nodes: AnyVNode[]; ids: string[]; width: number; cacheKeys?: string[] },
): Array<number | null> | null {
  const { nodes, ids, width, cacheKeys } = probeInput;
  let cache: Map<string, number> | undefined;
  if (cacheKeys !== undefined) {
    cache = heightCaches.get(engine);
    if (cache === undefined) {
      cache = new Map();
      heightCaches.set(engine, cache);
    }
  }
  const results: Array<number | null> = ids.map((_id, index) => {
    const key = cacheKeys?.[index];
    return key !== undefined ? (cache?.get(key) ?? null) : null;
  });
  const missing = results.flatMap((height, index) => (height === null ? [index] : []));
  if (missing.length === 0) {
    return results;
  }
  try {
    const probe = Canvas(
      { width: Math.max(60, Math.ceil(width)), height: 32_000 },
      Flex(
        { position: "absolute", left: 0, top: 0, width, direction: "column", gap: 0 },
        ...missing.map((index) => nodes[index]).filter((node) => node !== undefined),
      ),
    );
    const layout = engine.renderToLayoutTree(probe, { skipValidation: true });
    const heightsById = new Map<string, number>();
    const walk = (node: LayoutNode): void => {
      const meta = (node.vnode as { props?: { meta?: Record<string, string> } }).props?.meta;
      const id = meta?.edit;
      if (id !== undefined && !heightsById.has(id)) {
        heightsById.set(id, Math.ceil(node.bbox.height));
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    walk(layout.root);
    for (const index of missing) {
      const id = ids[index];
      const height = id !== undefined ? heightsById.get(id) : undefined;
      if (height !== undefined) {
        results[index] = height;
        const key = cacheKeys?.[index];
        if (cache !== undefined && key !== undefined) {
          if (cache.size >= HEIGHT_CACHE_LIMIT) {
            cache.clear();
          }
          cache.set(key, height);
        }
      }
    }
    return results;
  } catch {
    return null;
  }
}

/**
 * Stable cache key for one message's measured height: everything that can
 * change the laid-out box — content, role, width, type metrics, and the
 * timing values that appear in rendered labels ("Thought for 1.8s").
 * Colors and animations never affect layout and stay out of the key.
 */
export function messageHeightCacheKey(options: {
  contextKey: string;
  message: {
    role: string;
    content: string;
    language?: string | undefined;
    options?: string[] | undefined;
    afterSelection?: string | undefined;
    images?:
      | Array<{
          width: number;
          height: number;
          fit?: string | undefined;
          focus?: string | undefined;
          size?: string | undefined;
          dataUrl: string;
        }>
      | undefined;
  };
}): string {
  const { contextKey, message } = options;
  const images = (message.images ?? []).map((image) => [
    image.width,
    image.height,
    image.fit ?? "cover",
    image.focus ?? "center",
    image.size ?? "standard",
    image.dataUrl.length,
  ]);
  // A choice card's height is a function of how many options it lists, so two
  // choices with the same question but different menus must not share a
  // measurement — nor may two with the same menu that keep and retire it.
  // `choiceCollapses` reads `afterSelection` as well as the composer, and a
  // standing card is several times the height of the two-row record it
  // becomes; sharing one key lets the last one measured decide for both, and
  // the next render lays the tall one into the short one's slot.
  return `${contextKey}|${JSON.stringify([
    message.role,
    message.content,
    message.language ?? "",
    message.options ?? [],
    message.afterSelection ?? "collapse",
    images,
  ])}`;
}

/**
 * Slack to spend above the transcript when it does not fill its viewport.
 *
 * A chat and a terminal both fill from the top, so "start" is the honest
 * default and returns nothing. "center" composes the frame instead, for an
 * artifact meant as artwork rather than as a replayed session. Full-height
 * transcripts have no slack by construction.
 */
export function contentAlignOffset(options: {
  align: ContentAlign;
  fullHeight: boolean;
  viewportHeight: number;
  insetTop: number;
  contentHeight: number;
}): number {
  const { align, fullHeight, viewportHeight, insetTop, contentHeight } = options;
  if (fullHeight || align !== "center") {
    return 0;
  }
  return Math.max(0, Math.round((viewportHeight - insetTop - contentHeight) / 2));
}

/** Smallest transcript viewport a scene will shrink its chrome to preserve. */
const MIN_VIEWPORT_PX = 90;

/**
 * Largest chrome scale that still leaves the transcript a viewport.
 *
 * Chrome follows its own scale so an SNS-size transcript can keep the
 * surrounding UI legible, but header, composer, and footer together can eat
 * the whole canvas. `viewportAt` is the scene's exact layout at a candidate
 * scale rather than a cost model, so both surfaces bisect the real geometry.
 */
export function fitChromeScale(options: {
  requested: number;
  viewportAt: (scale: number) => number;
}): number {
  const { requested, viewportAt } = options;
  if (viewportAt(requested) >= MIN_VIEWPORT_PX) {
    return requested;
  }
  let low = 0.8;
  let high = Math.max(0.8, requested);
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (viewportAt(mid) >= MIN_VIEWPORT_PX) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}
