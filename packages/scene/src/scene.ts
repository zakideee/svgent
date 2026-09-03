import type { AnyVNode, Engine } from "@boundsvg/core";
import { appScene } from "./app-scene.js";
import { userLandingMs } from "./composer.js";
import type { GeneratorIdentity } from "./env.js";
import type { AttachedImage, SvgentProject } from "./model.js";
import { buildTimeline, type MessageTiming, paginateMessages } from "./timeline.js";
import { tuiScene } from "./tui-scene.js";

export type BuiltScene = {
  vnode: AnyVNode;
  durationMs: number;
  pageCount: number;
  pageIndex: number;
  fileStem: string;
  /** Reveal-complete moment per message on this page — lets the editor jump
   *  the preview straight to whatever is being typed. */
  messageRevealMs: Record<string, number>;
  /** Which page each message of the whole script lives on. */
  messagePage: Record<string, number>;
  /** Page-local timings for scrub interaction and authoring UI only. */
  messageTimings: MessageTiming[];
  /**
   * Whether an engine measured this scene's blocks. Without one, every wrapped
   * line count and block height is ratio arithmetic, while the engine that
   * finally draws the scene lays the glyphs out for real — an over-estimate
   * opens a gap inside a block, an under-estimate runs one block into the
   * next. Rendering paths refuse an unmeasured scene rather than ship the
   * disagreement; only counting pages and reading timings is safe without one.
   */
  measured: boolean;
  /** Runtime-owned identity stamped into exported artifacts. */
  generator?: GeneratorIdentity;
  /**
   * How many layout values the final clamp had to floor. Zero on every shipped
   * script — a nonzero count on ordinary input means a builder computed a
   * negative size, and without this number the clamp would hide that silently.
   */
  clampedPropCount: number;
};

/** A place in the rendered page where the product names itself. */
export type ProductMarkPlacement = "banner" | "footer";

/**
 * Where a rendered page names the product, top to bottom. Attribution is a
 * property of the output, not of one checkbox: dropping the footer takes a
 * placement away just as surely as clearing the mark by name. It is asked per
 * page because that is the unit that gets shared — a terminal greets once, so
 * the TUI's opening banner belongs to the first page and no other, and page
 * three of a footerless deck carries no mark at all.
 */
export function productMarkPlacements(
  project: SvgentProject,
  pageIndex: number,
): ProductMarkPlacement[] {
  if (!project.display.productMark) {
    return [];
  }
  const placements: ProductMarkPlacement[] = [];
  if (project.surface === "tui" && pageIndex === 0) {
    placements.push("banner");
  }
  if (project.display.footer) {
    placements.push("footer");
  }
  return placements;
}

/**
 * Layout props the engine refuses to see negative — the same list its own
 * validation walks, `NON_NEGATIVE_NUMBER_PROPS` plus `flexBasis` in
 * `@boundsvg/core`. Anything narrower leaves a prop the clamp promises to
 * cover but does not.
 */
const NON_NEGATIVE_LAYOUT_PROPS = [
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "gap",
  "rowGap",
  "columnGap",
  "flexGrow",
  "flexShrink",
  "flexBasis",
] as const;

/**
 * Takes every negative layout value out of a finished scene, in place, and
 * says how many it touched.
 *
 * The `sizeLeft` floors hold each subtraction where it is written, which is
 * what keeps a cramped layout sensible rather than merely legal. This is the
 * promise over all of them: whatever a builder computes, and by whatever route
 * a project reached it — the importer, the studio's own edits, a patch, a
 * caller constructing one in TypeScript — the scene handed out does not carry
 * a value the engine will refuse, because a refused scene renders nothing at
 * all.
 *
 * It clamps rather than throws for the same reason: an artifact missing one
 * degenerate box is worth more to whoever asked for it than no artifact. The
 * count is what keeps that from hiding a defect — shipped scripts pin it at
 * zero, so only authored extremes ever spend it.
 */
function clampNegativeLayoutProps(node: unknown, depth = 0): number {
  if (depth > 200 || node === null || typeof node !== "object") {
    return 0;
  }
  let clamped = 0;
  if (Array.isArray(node)) {
    for (const child of node) {
      clamped += clampNegativeLayoutProps(child, depth + 1);
    }
    return clamped;
  }
  const record = node as Record<string, unknown>;
  const props = record.props;
  if (props !== null && typeof props === "object") {
    const values = props as Record<string, unknown>;
    for (const key of NON_NEGATIVE_LAYOUT_PROPS) {
      const value = values[key];
      if (typeof value === "number" && value < 0) {
        values[key] = 0;
        clamped += 1;
      }
    }
  }
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === "object") {
      clamped += clampNegativeLayoutProps(value, depth + 1);
    }
  }
  return clamped;
}

export function buildSvgentScene(
  project: SvgentProject,
  requestedPageIndex: number,
  options: {
    fullHeight?: boolean;
    /** Render highlighted thinking notes open, in flow — for report stills. */
    openNotes?: boolean;
    engine?: Engine;
    generator?: GeneratorIdentity;
    fallbackImage?: AttachedImage;
  } = {},
): BuiltScene {
  const pages = paginateMessages(project);
  const pageIndex = Math.max(0, Math.min(requestedPageIndex, pages.length - 1));
  const messages = pages[pageIndex] ?? [];
  const fullHeight = options.fullHeight === true;
  // Open notes are a stills concern; without the grown fullHeight canvas the
  // in-flow notes would push content past a fixed viewport's clip.
  const openNotes = options.openNotes === true && fullHeight;
  const engine = options.engine;
  const generator = options.generator;
  const fallbackImage = options.fallbackImage;
  const product = generator ?? { name: "svgent", version: "" };
  const built =
    project.surface === "app"
      ? appScene(project, {
          messages,
          pageIndex,
          pageCount: pages.length,
          fullHeight,
          openNotes,
          engine,
          product,
          fallbackImage,
        })
      : tuiScene(project, {
          messages,
          pageIndex,
          pageCount: pages.length,
          fullHeight,
          engine,
          product,
          fallbackImage,
        });
  const messagePage: Record<string, number> = {};
  pages.forEach((pageMessages, page) => {
    for (const message of pageMessages) {
      messagePage[message.id] = page;
    }
  });
  const timeline = buildTimeline(project, messages);
  const messageRevealMs: Record<string, number> = {};
  for (const timing of timeline.messages) {
    // User messages land in the transcript only after the pre-send beat,
    // so the editor pin samples past that moment.
    const revealMs = timing.message.role === "user" ? userLandingMs(timing) : timing.revealEndMs;
    messageRevealMs[timing.message.id] = Math.min(revealMs, built.durationMs);
  }
  // The last word on sizes: whatever route the project took to get here, the
  // scene that leaves does not carry a value the engine will refuse.
  const clampedPropCount = clampNegativeLayoutProps(built.vnode);
  return {
    ...built,
    vnode: built.vnode,
    clampedPropCount,
    messageRevealMs,
    messagePage,
    messageTimings: timeline.messages,
    pageCount: pages.length,
    pageIndex,
    fileStem: `svgent-${project.surface}-${String(pageIndex + 1).padStart(2, "0")}`,
    measured: engine !== undefined,
    ...(generator ? { generator } : {}),
  };
}
