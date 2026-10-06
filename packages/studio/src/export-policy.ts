/**
 * Browser-only admission policy for expensive motion exports.
 *
 * This module deliberately sits in Studio rather than @svgent/render. The
 * renderer and CLI remain able to run the exact stress workloads used by the
 * performance baseline; only the browser UI decides whether it is responsible
 * to start one on the current device.
 */

import type { Engine } from "@boundsvg/core";
import {
  type MotionExportQuality,
  resolveMotionExportSettings,
  resolveSceneRasterScale,
} from "@svgent/render";
import type { BuiltScene } from "@svgent/scene";
import type { UiStrings } from "./i18n.js";

type BrowserMotionKind = "animated-webp" | "gif" | "mp4";

const BROWSER_MOTION_MAX_LONG_EDGE = 1_920;
const BROWSER_MOTION_MAX_PIXELS = 1_920 * 1_080;
const BROWSER_MOTION_MIN_SCALE = 0.5;
const BROWSER_MOTION_MAX_SCALE = 1;
const BROWSER_MOTION_WARNING_MS = 60_000;

/**
 * A browser motion job as this device would run it: refused for a resolution
 * past the ceiling before any frame is probed, otherwise admitted with an
 * estimate that may warn.
 */
export type BrowserMotionAssessment = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
} & (
  | { status: "blocked"; reason: "resolution"; estimatedMs: null }
  | { status: "ready" | "warning"; reason: "none"; estimatedMs: number }
);

export function isBrowserMotionKind(kind: string): kind is BrowserMotionKind {
  return kind === "animated-webp" || kind === "gif" || kind === "mp4";
}

/** Browser motion may be reduced, but never enlarged past the authored canvas. */
export function studioEntryExportScale(kind: string, requestedScale: number): number {
  if (!isBrowserMotionKind(kind)) {
    return requestedScale;
  }
  if (!Number.isFinite(requestedScale)) {
    return BROWSER_MOTION_MAX_SCALE;
  }
  return Math.min(BROWSER_MOTION_MAX_SCALE, Math.max(BROWSER_MOTION_MIN_SCALE, requestedScale));
}

function browserMotionResolutionAllowed(width: number, height: number): boolean {
  return (
    Math.max(width, height) <= BROWSER_MOTION_MAX_LONG_EDGE &&
    width * height <= BROWSER_MOTION_MAX_PIXELS
  );
}

/** A long estimate warns; how long to wait is the person's call. */
export function browserMotionEstimateStatus(estimatedMs: number): "ready" | "warning" {
  return estimatedMs > BROWSER_MOTION_WARNING_MS ? "warning" : "ready";
}

/**
 * Price one frame on this device, then classify the complete browser job.
 * No result from this function changes renderer options: it admits the
 * request unchanged, with an estimate, or refuses a resolution beyond the
 * browser ceiling before the expensive work starts.
 */
export function assessBrowserMotionExport(options: {
  engine: Engine;
  scene: BuiltScene;
  kind: BrowserMotionKind;
  scale: number;
  motionQuality: MotionExportQuality;
  workerCount: number;
}): BrowserMotionAssessment {
  const { engine, scene, kind, motionQuality } = options;
  const scale = studioEntryExportScale(kind, options.scale);
  const settings = resolveMotionExportSettings(motionQuality);
  const fps = kind === "mp4" ? settings.mp4FrameRate : settings.animatedRasterFps;
  const resolved = resolveSceneRasterScale(scene, scale);
  const base = {
    width: resolved.outputWidth,
    height: resolved.outputHeight,
    fps,
    frameCount: Math.max(2, Math.ceil((scene.durationMs / 1_000) * fps)),
  };

  if (!browserMotionResolutionAllowed(base.width, base.height)) {
    return { ...base, status: "blocked", reason: "resolution", estimatedMs: null };
  }

  const startedAt = performance.now();
  engine.renderToPng(scene.vnode, {
    timeMs: scene.durationMs / 2,
    scale,
  });
  const frameRenderMs = Math.max(1, performance.now() - startedAt);
  const parallelism = kind === "mp4" ? Math.max(1, options.workerCount) : 1;
  // Deliberately conservative: startup and encoding sit outside the sampled
  // PNG frame, while actual Worker throughput varies by browser and device.
  const estimatedMs = (frameRenderMs * base.frameCount * 1.3) / parallelism;
  return {
    ...base,
    status: browserMotionEstimateStatus(estimatedMs),
    reason: "none",
    estimatedMs,
  };
}

export function browserMotionAssessmentMessage(
  assessment: BrowserMotionAssessment,
  t: UiStrings,
): string {
  if (assessment.reason === "resolution") {
    return t.exportMotionResolutionBlocked(assessment.width, assessment.height);
  }
  const seconds = Math.ceil(assessment.estimatedMs / 1_000);
  return assessment.status === "warning"
    ? t.exportMotionEstimateWarning(assessment.frameCount, assessment.fps, seconds)
    : t.exportMotionEstimate(assessment.frameCount, assessment.fps, seconds);
}
