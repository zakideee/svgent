import { type AnyVNode, Box, Image } from "@boundsvg/core";
import { hexToRgb, type SceneEnv, sizeLeft } from "./env.js";
import type { SvgentProject } from "./model.js";

type GradientStop = { at: number; color: readonly [number, number, number] };

/**
 * Vertical wash as a single native linear-gradient fill — boundsvg parses
 * CSS gradient strings straight into SVG <linearGradient> paint.
 */
function gradientBandNodes(width: number, height: number, stops: GradientStop[]): AnyVNode[] {
  // stop.at runs bottom (0) → top (1): CSS 0deg starts on the bottom edge.
  const css = `linear-gradient(0deg, ${stops
    .map(
      (stop) =>
        `rgb(${stop.color[0]},${stop.color[1]},${stop.color[2]}) ${Math.round(stop.at * 100)}%`,
    )
    .join(", ")})`;
  return [Box({ position: "absolute", left: 0, top: 0, width, height, background: css })];
}

/**
 * Decorative canvas backdrop behind the floating window. Soft glows are faked
 * with huge blurred box shadows — no gradients needed in vector output.
 */
/**
 * Canvas backdrop, clipped to the canvas box. Glows are deliberately
 * anchored past the edges so their falloff covers the corners, and an SVG
 * paints outside its viewBox up to the viewport — without this clip those
 * overflowing glows bleed into the letterbox whenever the output is shown
 * or embedded at a different aspect ratio.
 */
export function backdropNodes(env: SceneEnv, width: number, height: number): AnyVNode[] {
  const nodes = backdropLayerNodes(env, width, height);
  return nodes.length === 0
    ? nodes
    : [
        Box(
          {
            position: "absolute",
            left: 0,
            top: 0,
            width,
            height,
            overflow: "clip",
            // Named so a geometry check can tell decoration behind the window
            // from content that has escaped its band.
            meta: { band: "backdrop" },
          },
          ...nodes,
        ),
      ];
}

function backdropLayerNodes(env: SceneEnv, width: number, height: number): AnyVNode[] {
  const { project, palette } = env;
  if (project.appearance.transparentCanvas) {
    return [];
  }
  // A user-supplied wallpaper replaces the generated preset entirely.
  const backdropImage = project.appearance.backdropImage;
  if (backdropImage) {
    return [
      Image({
        position: "absolute",
        left: 0,
        top: 0,
        src: backdropImage.dataUrl,
        width,
        height,
        objectFit: "cover",
        objectPosition: "center",
        meta: { alt: backdropImage.alt },
      }),
    ];
  }
  const accent = project.appearance.accent;
  switch (project.appearance.backdrop) {
    case "sky":
      // Fresh morning sky: airy blue wash + a low sun glow.
      return [
        ...gradientBandNodes(width, height, [
          { at: 0, color: [116, 169, 228] },
          { at: 0.55, color: [166, 210, 244] },
          { at: 1, color: [232, 246, 252] },
        ]),
        ...glowNodes({
          centerX: width * 0.28,
          centerY: height * 1.02,
          radiusX: width * 0.38,
          radiusY: height * 0.42,
          color: [255, 255, 255],
          totalAlpha: 0.55,
        }),
      ];
    case "peach":
      // Lavender → pink → peach: a soft three-stop gradient wash.
      return [
        ...gradientBandNodes(width, height, [
          { at: 0, color: [188, 170, 235] },
          { at: 0.5, color: [242, 178, 197] },
          { at: 1, color: [249, 218, 187] },
        ]),
        ...glowNodes({
          centerX: width * 0.78,
          centerY: -height * 0.02,
          radiusX: width * 0.34,
          radiusY: height * 0.38,
          color: [255, 240, 230],
          totalAlpha: 0.55,
        }),
      ];
    case "abyss":
      // Deep space violet. The glow is sized so
      // its zero-alpha edge lands past the far canvas edge — a smaller disc
      // ends mid-canvas and reads as a drawn arc.
      return [
        ...gradientBandNodes(width, height, [
          { at: 0, color: [9, 14, 38] },
          { at: 0.55, color: [33, 44, 96] },
          { at: 1, color: [72, 60, 138] },
        ]),
        ...glowNodes({
          centerX: width * 0.5,
          centerY: height * 1.05,
          radiusX: width * 0.95,
          radiusY: height * 1.1,
          color: hexToRgb(accent),
          totalAlpha: 0.42,
        }),
      ];
    case "aurora":
      // Night sky with three colored curtains. Like peach, a full-canvas
      // band grounds the glows so their falloff never shows as a disc.
      return [
        ...gradientBandNodes(width, height, [
          { at: 0, color: [12, 16, 34] },
          { at: 0.55, color: [24, 30, 58] },
          { at: 1, color: [36, 30, 72] },
        ]),
        ...glowNodes({
          centerX: width * 0.08,
          centerY: -height * 0.02,
          radiusX: width * 0.72,
          radiusY: height * 0.9,
          color: hexToRgb(accent),
          totalAlpha: 0.4,
        }),
        ...glowNodes({
          centerX: width * 1.02,
          centerY: height * 0.22,
          radiusX: width * 0.66,
          radiusY: height * 0.85,
          color: hexToRgb(palette.success),
          totalAlpha: 0.24,
        }),
        ...glowNodes({
          centerX: width * 0.5,
          centerY: height * 1.04,
          radiusX: width * 0.8,
          radiusY: height * 0.85,
          color: hexToRgb(palette.danger),
          totalAlpha: 0.2,
        }),
      ];
    case "dawn":
      // First light: a warm band low on the canvas with a red-shifted
      // corner, grounded the same way peach is.
      return [
        ...gradientBandNodes(width, height, [
          { at: 0, color: [58, 34, 46] },
          { at: 0.5, color: [38, 30, 52] },
          { at: 1, color: [24, 24, 44] },
        ]),
        ...glowNodes({
          centerX: width * 0.5,
          centerY: height * 1.12,
          radiusX: width * 1.05,
          radiusY: height * 1.15,
          color: hexToRgb(palette.warning),
          totalAlpha: 0.34,
        }),
        ...glowNodes({
          centerX: width * 0.92,
          centerY: -height * 0.08,
          radiusX: width * 0.7,
          radiusY: height * 0.85,
          color: hexToRgb(palette.danger),
          totalAlpha: 0.26,
        }),
      ];
    default:
      return [];
  }
}

function backdropLuminance(project: SvgentProject): number {
  switch (project.appearance.backdrop) {
    case "sky":
      return 0.75;
    case "peach":
      return 0.72;
    default: {
      const [red, green, blue] = hexToRgb(project.appearance.background);
      return (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    }
  }
}

/** Marks the halo tiles as decoration around the window rather than content. */
const SHADOW_META = Object.freeze({ band: "shadow" });

export function windowShadowNodes(
  env: SceneEnv,
  {
    left,
    top,
    width,
    height,
    radius,
  }: { left: number; top: number; width: number; height: number; radius: number },
): AnyVNode[] {
  const rawStrength = env.project.appearance.shadowStrength;
  // Guard against stale in-memory projects from before this field existed.
  const strength = Number.isFinite(rawStrength) ? rawStrength : 0.6;
  if (strength <= 0.01) {
    return [];
  }
  // A black shadow disappears on a near-black backdrop, so switch to a
  // light halo there — the same trick dark-mode UIs use for elevation.
  const darkBackdrop = backdropLuminance(env.project) < 0.22;
  const [red, green, blue] = darkBackdrop ? [225, 232, 255] : [0, 0, 0];
  const peakAlpha = (darkBackdrop ? 0.5 : 0.7) * strength;
  const spread = 20;
  // Nine-slice halo out of native gradients: four edge bands (linear) and
  // four corner quarters (radial). The previous 22 stacked full-window
  // rings rasterized ~2.7x slower per video frame; gradients cost almost
  // nothing and the multi-stop falloff keeps the gaussian-ish tail.
  const rgba = (alpha: number): string => `rgba(${red},${green},${blue},${alpha.toFixed(3)})`;
  const stops = (direction: string): string =>
    `linear-gradient(${direction}, ${rgba(peakAlpha)} 0%, ${rgba(peakAlpha * 0.42)} 35%, ${rgba(
      peakAlpha * 0.12,
    )} 68%, ${rgba(0)} 100%)`;
  const inset = radius;
  const cornerSize = radius + spread;
  // Each corner is a quadrant of a halo circle centred on the window's
  // corner-radius pivot. Naming the centre and extent explicitly keeps this
  // tied to CSS semantics rather than to whatever the renderer defaults to.
  const cornerStop = (distance: number): string => ((distance / cornerSize) * 100).toFixed(1);
  // Everything nearer the pivot than `radius` is inside the window's own
  // rounded corner, so the halo has to start empty there. Filling it at peak
  // and trusting the window to cover it only works while the window is
  // opaque — turn its opacity down and the fill reads as a dark square
  // pasted over the corner. The last transparent stop sits half a pixel
  // inside the arc so the window still hides the seam.
  const cornerGradient = (originX: string, originY: string): string =>
    `radial-gradient(circle farthest-side at ${originX} ${originY}, ${rgba(0)} 0%, ${rgba(
      0,
    )} ${cornerStop(Math.max(0, radius - 0.5))}%, ${rgba(peakAlpha)} ${cornerStop(
      radius,
    )}%, ${rgba(peakAlpha * 0.42)} ${cornerStop(radius + spread * 0.35)}%, ${rgba(
      peakAlpha * 0.12,
    )} ${cornerStop(radius + spread * 0.68)}%, ${rgba(0)} 100%)`;
  // A corner tile paints its own quadrant directly: the gradient centre is
  // the window's corner pivot, so no oversized child needs clipping.
  const cornerQuadrant = ({
    quadrantLeft,
    quadrantTop,
    originX,
    originY,
  }: {
    quadrantLeft: number;
    quadrantTop: number;
    originX: "left" | "right";
    originY: "top" | "bottom";
  }): AnyVNode =>
    Box({
      position: "absolute",
      // Decoration around the window, not content in it. Named so a geometry
      // check can tell a halo tile from a block that has escaped its band.
      meta: SHADOW_META,
      left: quadrantLeft,
      top: quadrantTop,
      width: cornerSize,
      height: cornerSize,
      background: cornerGradient(originX, originY),
    });
  const shadowTop = top;
  return [
    // Edges: each band's first (peak) stop sits on the window edge.
    Box({
      position: "absolute",
      left: left + inset,
      top: shadowTop - spread,
      width: sizeLeft(width, inset * 2),
      height: spread,
      background: stops("to top"),
      meta: SHADOW_META,
    }),
    Box({
      position: "absolute",
      left: left + inset,
      top: shadowTop + height,
      width: sizeLeft(width, inset * 2),
      height: spread,
      background: stops("to bottom"),
      meta: SHADOW_META,
    }),
    Box({
      position: "absolute",
      left: left - spread,
      top: shadowTop + inset,
      width: spread,
      height: sizeLeft(height, inset * 2),
      background: stops("to left"),
      meta: SHADOW_META,
    }),
    Box({
      position: "absolute",
      left: left + width,
      top: shadowTop + inset,
      width: spread,
      height: sizeLeft(height, inset * 2),
      background: stops("to right"),
      meta: SHADOW_META,
    }),
    // Corner quarters, halo circle centered on the corner-radius pivot
    cornerQuadrant({
      quadrantLeft: left - spread,
      quadrantTop: shadowTop - spread,
      originX: "right",
      originY: "bottom",
    }),
    cornerQuadrant({
      quadrantLeft: left + width - inset,
      quadrantTop: shadowTop - spread,
      originX: "left",
      originY: "bottom",
    }),
    cornerQuadrant({
      quadrantLeft: left - spread,
      quadrantTop: shadowTop + height - inset,
      originX: "right",
      originY: "top",
    }),
    cornerQuadrant({
      quadrantLeft: left + width - inset,
      quadrantTop: shadowTop + height - inset,
      originX: "left",
      originY: "top",
    }),
  ];
}

function glowNodes(options: {
  centerX: number;
  centerY: number;
  radiusX: number;
  radiusY: number;
  color: readonly [number, number, number];
  totalAlpha: number;
}): AnyVNode[] {
  const { centerX, centerY, radiusX, radiusY, color, totalAlpha } = options;
  const rgba = (alpha: number): string =>
    `rgba(${color[0]},${color[1]},${color[2]},${alpha.toFixed(3)})`;
  return [
    Box({
      position: "absolute",
      left: centerX - radiusX,
      top: centerY - radiusY,
      width: radiusX * 2,
      height: radiusY * 2,
      borderRadius: 999,
      // Alpha must reach 0 by 70%: a radial gradient's 100% sits at the
      // box's farthest corner, so stopping there leaves the edge midpoints
      // still tinted — which paints the glow's bounding box as hard seams.
      background: `radial-gradient(${rgba(totalAlpha)} 0%, ${rgba(totalAlpha * 0.5)} 32%, ${rgba(0)} 70%)`,
    }),
  ];
}
