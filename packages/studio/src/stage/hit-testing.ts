/**
 * Mapping pointer positions on the rendered stage back to SVG elements,
 * and the stage element's own style. Pure DOM math: it reads the painted
 * document, never the scene model.
 */

import type { AppearanceSettings } from "@svgent/scene";
import type React from "react";
import type { StageFlight } from "../stage-flight.js";

/**
 * The metadata attributes boundsvg stamps onto the rendered scene. They
 * are this module's contract with the renderer — naming them here keeps
 * the dependency visible when the Studio becomes its own package.
 */
export const META_EDIT_ATTR = "data-boundsvg-meta-edit";
export const META_ACTION_ATTR = "data-boundsvg-meta-action";
export const NODE_ID_ATTR = "data-boundsvg-node-id";
export const META_MESSAGE_ID_ATTR = "data-boundsvg-meta-message-id";
export const META_OPTION_INDEX_ATTR = "data-boundsvg-meta-option-index";
export const META_IMAGE_INDEX_ATTR = "data-boundsvg-meta-image-index";

/** A rect in stage-local coordinates, used to draw the overlays. */
export type OutlineRect = { left: number; top: number; width: number; height: number };

/** A stage hit-test request: the pointer position and what to look for. */
type StageProbe = { x: number; y: number; selector: string };

/**
 * Value-equal updater for OutlineRect state: returning the previous
 * reference lets React bail out of the re-render, which matters for the
 * stage hover outlines fed by every mousemove.
 */
export function sameOutlineRect(
  current: OutlineRect | null,
  next: OutlineRect | null,
): OutlineRect | null {
  if (
    current !== null &&
    next !== null &&
    current.left === next.left &&
    current.top === next.top &&
    current.width === next.width &&
    current.height === next.height
  ) {
    return current;
  }
  return next;
}

export function outlineRectFor(element: Element, stage: HTMLElement): OutlineRect {
  const elementRect = element.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  return {
    left: elementRect.left - stageRect.left,
    top: elementRect.top - stageRect.top,
    width: elementRect.width,
    height: elementRect.height,
  };
}

export function findInspectable(target: Element): Element | null {
  const node = target.closest(`[${NODE_ID_ATTR}]`);
  // The root <svg> would just outline the whole canvas — skip it.
  return node && node.tagName.toLowerCase() !== "svg" ? node : null;
}

function isVisibleStageElement(element: Element, stage: HTMLElement): boolean {
  let current: Element | null = element;
  while (current && current !== stage) {
    const style = window.getComputedStyle(current);
    const opacity = Number.parseFloat(style.opacity);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      (Number.isFinite(opacity) && opacity <= 0.01)
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

/**
 * Metadata targets are resolved by their painted rects, never by the
 * browser's own hit-testing, for two reasons. Chromium's SVG hit-test
 * data lags a CSS-animated transform mid-glide, so with the camera
 * moving a click would land on stale geometry — getBoundingClientRect
 * always reports the painted position. And a bounding box is the right
 * target size: glyph-exact hits make small chrome text (the clock, the
 * footer) nearly impossible to press. Later document order paints on
 * top, so the last visible match wins.
 */
export function rectHitMetaTarget(stage: HTMLElement, probe: StageProbe): Element | null {
  const candidates = [...stage.querySelectorAll(probe.selector)].filter((el) => {
    const rect = el.getBoundingClientRect();
    return (
      probe.x >= rect.left && probe.x <= rect.right && probe.y >= rect.top && probe.y <= rect.bottom
    );
  });
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    if (candidate && isVisibleStageElement(candidate, stage)) {
      return candidate;
    }
  }
  return null;
}

/** Where a stage popover opens, clamped so it stays inside the canvas. */
export function stageInputPosition(event: React.MouseEvent<HTMLDivElement>): {
  x: number;
  y: number;
} {
  const stage = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(Math.max(8, event.clientX - stage.left - 190), Math.max(8, stage.width - 396)),
    y: Math.min(Math.max(8, event.clientY - stage.top + 14), Math.max(8, stage.height - 276)),
  };
}

/** The stage element's style: zoom custom properties, flight box, caps. */
export function stageStyleFor(options: {
  appearance: AppearanceSettings;
  /**
   * The margin ratio the phone stage sizes itself from. Passed in rather than
   * read off `appearance` so it can be held steady mid-drag: see
   * `useSteadyMarginRatio`.
   */
  marginRatio: number;
  stageZoom: { scale: number; txPx: number; tyPx: number };
  stageFlight: StageFlight | null;
  showSvgInspector: boolean;
  sourceHeight: number;
}): React.CSSProperties {
  const { appearance, marginRatio, stageZoom, stageFlight, showSvgInspector, sourceHeight } =
    options;
  return {
    aspectRatio: `${appearance.canvasWidth} / ${appearance.canvasHeight}`,
    // Custom CSS properties drive the touch zoom transform without
    // touching the memoized SVG node; touch-action flips to none while
    // zoomed so one-finger pans stay on the canvas instead of scrolling
    // the page.
    ["--stage-zoom" as string]: stageZoom.scale,
    ["--stage-tx" as string]: `${stageZoom.txPx}px`,
    ["--stage-ty" as string]: `${stageZoom.tyPx}px`,
    // Lets the phone stage cap its height at what the canvas actually
    // needs, so wide canvases leave no letterbox slack above the grip.
    ["--canvas-aspect" as string]: appearance.canvasHeight / appearance.canvasWidth,
    // The window margin renders inside the SVG as empty border; the phone
    // slides that strip under the floating rows so the window itself, not
    // its margin, is what meets the toolbar.
    ["--canvas-margin-ratio" as string]: marginRatio,
    ...(stageZoom.scale > 1 ? { touchAction: "none" } : {}),
    ...(stageFlight !== null
      ? {
          position: "fixed",
          left: stageFlight.base.left,
          top: stageFlight.base.top,
          width: stageFlight.base.width,
          height: stageFlight.base.height,
          transform: stageFlight.transform,
        }
      : {}),
    ...(showSvgInspector
      ? { maxHeight: `calc(100vh - var(--header-h) - 190px - ${sourceHeight + 10}px)` }
      : {}),
  };
}
