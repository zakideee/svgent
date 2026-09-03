import type { AnyVNode, Engine } from "@boundsvg/core";
import {
  type AttachedImage,
  FALLBACK_FONT_ALIAS,
  FONT_ALIAS,
  type SvgentProject,
} from "./model.js";

/** Product identity is supplied by the runtime that owns the artifact. */
export type GeneratorIdentity = Readonly<{
  name: string;
  version: string;
}>;

export const SANS_FONT = FONT_ALIAS.sans;
export const MONO_FONT = FONT_ALIAS.mono;
const FALLBACK_SANS_FONT = FALLBACK_FONT_ALIAS.sans;
const FALLBACK_MONO_FONT = FALLBACK_FONT_ALIAS.mono;

/**
 * Fallback chains, named for the font that leads them. The other slot comes
 * first — the surfaces have always leaned on each other, the terminal font for
 * box drawing and the text font for kana — and the bundled pair closes both
 * chains so a gap in a chosen font is filled rather than drawn as tofu.
 */
export const SANS_FALLBACK = [MONO_FONT, FALLBACK_SANS_FONT, FALLBACK_MONO_FONT];
export const MONO_FALLBACK = [SANS_FONT, FALLBACK_MONO_FONT, FALLBACK_SANS_FONT];

/** The chain for a font picked at runtime rather than written into the call. */
export function fallbackFor(font: string): string[] {
  return font === MONO_FONT ? MONO_FALLBACK : SANS_FALLBACK;
}

// Base sizes at fontScale = 1. A terminal has exactly one cell size; the app
// has a small typographic scale. Both multiply by appearance.fontScale.
const TUI_BASE_FONT_PX = 13;
export const TUI_LINE_RATIO = 20 / 13;
export const TUI_CHAR_RATIO = 0.6;
const APP_BASE_PROSE_PX = 14;
const APP_PROSE_LINE_RATIO = 22 / 14;
const APP_BASE_CODE_PX = 13;
const APP_CODE_LINE_RATIO = 20 / 13;

export type ScenePalette = {
  canvas: string;
  panel: string;
  panelStrong: string;
  panelSoft: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  code: string;
  codeText: string;
  user: string;
};

export type Metrics = {
  scale: number;
  /** TUI cell grid. */
  tuiFontPx: number;
  tuiLinePx: number;
  tuiCharPx: number;
  /** App typographic scale. */
  prosePx: number;
  proseLinePx: number;
  codePx: number;
  codeLinePx: number;
  /** Small UI text (status rows, buttons). */
  uiPx: number;
  /** Window chrome (header/footer/composer buttons), decoupled from fontScale. */
  chromeScale: number;
  /** Meta labels / timestamps. */
  metaPx: number;
  /**
   * Multiplier for the transcript's own spacing. A plain number rather than a
   * helper because the measured-height cache keys on `JSON.stringify(metrics)`
   * and would not notice a function changing.
   */
  spaceScale: number;
};

/** A rendered transcript piece with the height the layout will give it. */
export type RenderedBlock = { node: AnyVNode; estimatedHeight: number };

export type SceneEnv = {
  project: SvgentProject;
  product: GeneratorIdentity;
  fallbackImage?: AttachedImage;
  palette: ScenePalette;
  metrics: Metrics;
  /** Measurement engine; absent on validation-only paths. */
  engine?: Engine | undefined;
};

/**
 * How spacing follows type size. Padding tuned for 14px text is a quarter of
 * its optical value beside 56px text, but matching type one-for-one overshoots
 * — display sizes read better with proportionally tighter spacing than body
 * text does. The exponent damps the growth, and dividing by the default
 * fontScale anchors the curve there, so the shipped default renders exactly as
 * it did before spacing scaled at all.
 */
const SPACING_EXPONENT = 0.6;
const SPACING_ANCHOR_SCALE = 1.5;

/**
 * Spacing multiplier for a font scale and the author's own adjustment.
 *
 * The curve only ever adds room. Nothing suggested the tuned values were too
 * generous below the default — they read as a floor, and taking space away
 * from small type is where labels start colliding — so scales at or under the
 * anchor render exactly as before. An author who wants it tighter says so
 * through spacingScale rather than by shrinking the type.
 */
export function spaceScaleFor(fontScale: number, spacingScale: number): number {
  const grown = Math.max(1, (fontScale / SPACING_ANCHOR_SCALE) ** SPACING_EXPONENT);
  return grown * spacingScale;
}

/**
 * How prose leading tightens as type grows. Body copy wants air between lines;
 * a headline set at four times the size does not, and 1.57 there reads as a
 * gap rather than as a paragraph. Only the app surface gets this — a terminal's
 * cell is a fixed grid whose aspect does not change with the font size, and
 * loosening or tightening it would break the geometry the TUI is built on.
 */
const LEADING_TIGHTEN_EXPONENT = 0.18;
const MIN_PROSE_LINE_RATIO = 1.28;

function proseLineRatioFor(fontScale: number): number {
  const tighten = Math.min(1, (SPACING_ANCHOR_SCALE / fontScale) ** LEADING_TIGHTEN_EXPONENT);
  return Math.max(MIN_PROSE_LINE_RATIO, APP_PROSE_LINE_RATIO * tighten);
}

/**
 * One spacing value in px. Rounded, because half-pixel padding shows up as a
 * soft edge against the crisp ones beside it.
 */
export function spacePx(metrics: Metrics, px: number): number {
  return Math.round(px * metrics.spaceScale);
}

/**
 * A hairline that keeps its weight against larger type. One pixel beside 56px
 * text reads as a scratch rather than as an edge, and an export scale thins it
 * further. Never below the authored width.
 */
/**
 * Screen-space width of the terminal's four frames — window, composer, and
 * each drawn picker.
 *
 * Canvas-stable strokes hold their width in device pixels, which fixed the
 * camera scaling them. What remains is subpixel translation: as the camera
 * pans, a line's centre drifts across the pixel grid, and a 1px stroke that
 * lands on a boundary splits its coverage between two columns — the same ink
 * at half the peak, which reads as the line going thin. Both vertical frames
 * do it together because one camera transform moves them both.
 *
 * The real answer is pixel snapping in the engine, and that is not built. This
 * is a stopgap: a slightly wider line keeps enough peak density to survive the
 * split. It does not remove the effect.
 */
export const TUI_FRAME_STROKE_PX = 1.25;

export function strokePx(metrics: Metrics, px = 1): number {
  return Math.max(px, Math.round(px * metrics.spaceScale));
}

export function metricsFor(project: SvgentProject): Metrics {
  const scale = project.appearance.fontScale > 0 ? project.appearance.fontScale : 1;
  const chromeScale = project.appearance.chromeScale > 0 ? project.appearance.chromeScale : 1;
  const tuiFontPx = Math.round(TUI_BASE_FONT_PX * scale);
  const prosePx = Math.round(APP_BASE_PROSE_PX * scale);
  const codePx = Math.round(APP_BASE_CODE_PX * scale);
  return {
    scale,
    tuiFontPx,
    tuiLinePx: Math.round(tuiFontPx * TUI_LINE_RATIO),
    tuiCharPx: tuiFontPx * TUI_CHAR_RATIO,
    prosePx,
    proseLinePx: Math.round(prosePx * proseLineRatioFor(scale)),
    codePx,
    codeLinePx: Math.round(codePx * APP_CODE_LINE_RATIO),
    uiPx: Math.round(13 * scale),
    spaceScale: spaceScaleFor(
      scale,
      project.appearance.spacingScale > 0 ? project.appearance.spacingScale : 1,
    ),
    metaPx: Math.max(9, Math.round(10 * scale)),
    chromeScale,
  };
}

type ThemePaint = Omit<ScenePalette, "canvas" | "accent">;

const THEME_PAINTS: Record<SvgentProject["appearance"]["theme"], ThemePaint> = {
  ink: {
    panel: "#11141b",
    panelStrong: "#181c25",
    panelSoft: "#0d1016",
    border: "#2b303c",
    text: "#ecedf1",
    muted: "#9ca3af",
    faint: "#646b78",
    accentSoft: "#292440",
    success: "#64d79f",
    warning: "#f0b35a",
    danger: "#f37b83",
    code: "#090c12",
    codeText: "#dce2ef",
    user: "#29243f",
  },
  paper: {
    panel: "#f7f5ef",
    panelStrong: "#ffffff",
    panelSoft: "#efede7",
    border: "#d4d0c7",
    text: "#202329",
    muted: "#656a73",
    faint: "#8b9098",
    accentSoft: "#e7e2ff",
    success: "#16794a",
    warning: "#a35d00",
    danger: "#b13a3a",
    code: "#e4e0d2",
    codeText: "#23272f",
    user: "#e9e4ff",
  },
  nordic: {
    panel: "#151b24",
    panelStrong: "#1d242f",
    panelSoft: "#10151d",
    border: "#2e3947",
    text: "#d8dee9",
    muted: "#93a1b3",
    faint: "#5d6b7d",
    accentSoft: "#253044",
    success: "#a3be8c",
    warning: "#ebcb8b",
    danger: "#bf616a",
    code: "#0e131a",
    codeText: "#d8dee9",
    user: "#2b3345",
  },
  phosphor: {
    panel: "#04130a",
    panelStrong: "#072114",
    panelSoft: "#020b06",
    border: "#0f3a22",
    text: "#6dffa8",
    muted: "#3ecb78",
    faint: "#1f7a48",
    accentSoft: "#06331d",
    success: "#6dffa8",
    warning: "#ffd75f",
    danger: "#ff6d6d",
    code: "#010804",
    codeText: "#57e68f",
    user: "#06331d",
  },
  ember: {
    panel: "#150c02",
    panelStrong: "#1f1305",
    panelSoft: "#0d0701",
    border: "#4a2e0d",
    text: "#ffb75e",
    muted: "#cc8f3f",
    faint: "#7a5624",
    accentSoft: "#33200a",
    success: "#ffc851",
    warning: "#ff9d3c",
    danger: "#ff6d5e",
    code: "#0a0500",
    codeText: "#f5a742",
    user: "#33200a",
  },
  synth: {
    panel: "#1b1226",
    panelStrong: "#241834",
    panelSoft: "#120b1b",
    border: "#3c2b55",
    text: "#f4ecff",
    muted: "#b39cd6",
    faint: "#77639c",
    accentSoft: "#33204d",
    success: "#72f1b8",
    warning: "#fede5d",
    danger: "#fe4450",
    code: "#0d0716",
    codeText: "#e9d9ff",
    user: "#2e1d45",
  },
};

export function paletteFor(project: SvgentProject): ScenePalette {
  const paint = THEME_PAINTS[project.appearance.theme] ?? THEME_PAINTS.ink;
  return {
    ...paint,
    canvas: project.appearance.background,
    accent: project.appearance.accent,
    user: project.appearance.userBubbleColor,
  };
}

/** Ink that stays readable on the accent: dark on light accents. */
export function accentInk(accent: string): string {
  const [red, green, blue] = hexToRgb(accent);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.62 ? "#101319" : "#ffffff";
}

/** Session clock, advanced by the elapsed scene time. Blank hides it. */
export function sessionClockLabel(offsetMs: number, clockTime: string): string {
  if (clockTime.trim().length === 0) {
    return "";
  }
  const match = /^(\d{1,2}):(\d{2})$/u.exec(clockTime.trim());
  const baseMinutes = match ? Number(match[1]) * 60 + Number(match[2]) : 10 * 60;
  const totalMinutes = baseMinutes + Math.floor(offsetMs / 60_000);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function secondsLabel(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function messageSurfaceAlpha(project: SvgentProject): number {
  return Math.min(1, 0.35 + 0.65 * project.appearance.terminalOpacity);
}

/** Hard square-wave blink for terminal cursors; soft breathing for app carets. */

export function estimateTextWidthPx(text: string, fontPx: number): number {
  let width = 0;
  for (const character of Array.from(text)) {
    const code = character.codePointAt(0) ?? 0;
    width += code > 0x2e7f ? fontPx : fontPx * 0.6;
  }
  return width;
}

/**
 * Split one hard line into visual lines at an estimated wrap width. The
 * estimate leans conservative (breaks slightly early) so a piece never
 * overruns the real text band.
 */

export function hexToRgb(hex: string): readonly [number, number, number] {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(hex);
  if (!match) {
    return [139, 124, 246];
  }
  return [
    Number.parseInt(match[1] ?? "00", 16),
    Number.parseInt(match[2] ?? "00", 16),
    Number.parseInt(match[3] ?? "00", 16),
  ];
}

/** Blend two hex colors; amount 0 keeps base, 1 reaches target. */
function mixHex(base: string, target: string, amount: number): string {
  const from = hexToRgb(base);
  const to = hexToRgb(target);
  const channel = (index: 0 | 1 | 2): number =>
    Math.round(from[index] + (to[index] - from[index]) * amount);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

/**
 * Ink that survives panel translucency. At the minimum panel opacity the
 * backdrop dominates, so muted/accent colors need to move close to the theme
 * text color; otherwise Peach and user images can erase them completely.
 */
export function chromeInk(env: SceneEnv, base: string): string {
  const boost = Math.min(0.9, (1 - env.project.appearance.terminalOpacity) * 2);
  return boost <= 0.01 ? base : mixHex(base, env.palette.text, boost);
}

/**
 * Soft radial glow as one native radial-gradient fill. Blur filters are
 * far too slow to rasterize per video frame; a gradient costs nothing.
 */

export function hexToRgba(hex: string, alpha: number): string {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu.exec(hex);
  if (!match) {
    return hex;
  }
  const red = Number.parseInt(match[1] ?? "00", 16);
  const green = Number.parseInt(match[2] ?? "00", 16);
  const blue = Number.parseInt(match[3] ?? "00", 16);
  return `rgba(${red},${green},${blue},${alpha.toFixed(2)})`;
}

/**
 * What is left of `available` once everything in `taken` has come out of it.
 *
 * Sizes here are derived by subtraction the whole way down — a canvas gives a
 * window, a window gives a column, a column gives a row, a row gives a code
 * block — and every step takes something that scales with the type. A step that
 * takes more than it was handed does not draw something cramped: the engine
 * refuses a negative size and the artifact does not render at all. Nothing in
 * the chain can be less than nothing, so the subtraction stops there.
 *
 * Where a builder needs more than nothing to draw anything worth drawing, it
 * says so with its own floor over this one.
 */
export function sizeLeft(available: number, ...taken: number[]): number {
  let left = available;
  for (const part of taken) {
    left -= part;
  }
  return Math.max(0, left);
}
