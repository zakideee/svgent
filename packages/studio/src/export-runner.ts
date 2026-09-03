/**
 * The export run: scene expansion per format, the artifact loop with
 * progress/ETA/elapsed state, cancellation, the script JSON download,
 * and the one-time use-note toast for dialog-less exports.
 */

import type { ResolvedBrowserFont } from "@boundsvg/browser";
import type { Engine } from "@boundsvg/core";
import {
  type AnimatedSvgIterations,
  DEFAULT_MOTION_EXPORT_QUALITY,
  type MotionExportQuality,
} from "@svgent/render";
import {
  type AttachedImage,
  type BuiltScene,
  buildSvgentScene,
  type GeneratorIdentity,
  type ScriptProvenance,
  type SvgentProject,
  serializeProject,
} from "@svgent/scene";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  assessBrowserMotionExport,
  BROWSER_MOTION_MAX_ESTIMATE_MS,
  browserMotionAssessmentMessage,
  isBrowserMotionKind,
  studioEntryExportScale,
} from "./export-policy.js";
import {
  createExportUrls,
  DEFAULT_EXPORT_RESOURCE_MODE,
  downloadBlob,
  downloadExport,
  type ExportKind,
  type ExportResourceMode,
  type ExportResult,
  exportArtifact,
  exportTimestamp,
  resolveExportWorkerConcurrency,
} from "./exports.js";
import type { UiStrings } from "./i18n.js";
import type { StudioPersistence } from "./persistence.js";
import { nextAnimationFrame } from "./playback.js";
import type { StudioExportResult } from "./public-types.js";

/** The use note was shown once for a dialog-less export; never nag again. */
const USE_NOTE_SEEN_KEY = "use-note-seen";
/** Long enough to read one sentence; the toast never blocks anything. */
const USE_NOTE_TOAST_MS = 12_000;

/** Gap between auto-saved files; same-tick clicks lose all but the first. */
const DOWNLOAD_STAGGER_MS = 300;

function requestedStudioExportScale(
  kind: ExportKind,
  stillScale: number,
  motionScale: number,
): number {
  const requestedScale = isBrowserMotionKind(kind) ? motionScale : stillScale;
  return studioEntryExportScale(kind, requestedScale);
}

function assertBrowserMotionAdmission(options: {
  engine: Engine;
  scenes: BuiltScene[];
  kind: ExportKind;
  scale: number;
  motionQuality: MotionExportQuality;
  resourceMode: ExportResourceMode;
  t: UiStrings;
}): void {
  if (!isBrowserMotionKind(options.kind)) {
    return;
  }
  const kind = options.kind;
  const workerCount = resolveExportWorkerConcurrency(
    options.resourceMode,
    globalThis.navigator?.hardwareConcurrency ?? 4,
  );
  const assessments = options.scenes.map((scene) =>
    assessBrowserMotionExport({
      engine: options.engine,
      scene,
      kind,
      scale: options.scale,
      motionQuality: options.motionQuality,
      workerCount,
    }),
  );
  const blocked = assessments.find((assessment) => assessment.status === "blocked");
  if (blocked) {
    throw new Error(browserMotionAssessmentMessage(blocked, options.t));
  }
  const totalEstimatedMs = assessments.reduce(
    (total, assessment) => total + (assessment.estimatedMs ?? 0),
    0,
  );
  if (totalEstimatedMs > BROWSER_MOTION_MAX_ESTIMATE_MS) {
    throw new Error(options.t.exportMotionTooLong(Math.ceil(totalEstimatedMs / 1_000)));
  }
}

/**
 * Whether this dialog-less export is the one that shows the use note.
 * First time ever via localStorage; once per session when storage is
 * unavailable (the ref).
 */
function claimUseNoteShowing(
  shownRef: React.RefObject<boolean>,
  persistence: StudioPersistence | null,
): boolean {
  if (shownRef.current) {
    return false;
  }
  shownRef.current = true;
  try {
    if (persistence?.getItem(USE_NOTE_SEEN_KEY)) {
      return false;
    }
    persistence?.setItem(USE_NOTE_SEEN_KEY, "1");
  } catch {
    // Storage unavailable — the ref still limits it to once per session.
  }
  return true;
}

export function useExportRunner(options: {
  /** Ready engine, or null while loading/errored — exports need it. */
  engine: Engine | null;
  project: SvgentProject;
  /** The currently previewed page's scene; single-page exports reuse it. */
  scene: BuiltScene;
  /** Export gates: any issue disables artifact runs (script JSON exempt). */
  issues: string[];
  resolvedFonts: ResolvedBrowserFont[] | null;
  /** The export dialog shows the use note inline; only dialog-less exports toast it. */
  dialogOpen: boolean;
  /** Stamped on a written-out script; read at the moment of writing. */
  provenance: () => ScriptProvenance;
  persistence: StudioPersistence | null;
  generator: GeneratorIdentity;
  fallbackImage: AttachedImage;
  t: UiStrings;
  onUiError: (error: Error | null) => void;
  onExport?: (result: StudioExportResult) => void;
}) {
  const { engine, project, scene, t, onUiError } = options;
  const [pendingExport, setPendingExport] = useState<ExportKind | null>(null);
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const exportAbortRef = useRef<AbortController | null>(null);
  const [exportEta, setExportEta] = useState<number | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult[] | null>(null);
  // This runner's own blob URLs — preview, download and the script JSON alike.
  // Released as a set at the start of the next export, which is the same moment
  // as before and well after the click a download URL has to survive.
  const [exportUrls] = useState(createExportUrls);
  // Page scope for split-flow exports; single-flow scripts never see it.
  // Splitting into slides means the deck is the artifact, so the whole
  // deck is the default and "this page" is the deliberate narrowing.
  const [exportAllPages, setExportAllPages] = useState(true);
  const [exportOpenNotes, setExportOpenNotes] = useState(false);
  const [exportScale, setExportScale] = useState(1);
  const [motionExportScale, setMotionExportScale] = useState(1);
  const [motionQuality, setMotionQuality] = useState<MotionExportQuality>(
    DEFAULT_MOTION_EXPORT_QUALITY,
  );
  const [animatedSvgIterations, setAnimatedSvgIterations] =
    useState<AnimatedSvgIterations>("infinite");
  const [resourceMode, setResourceMode] = useState<ExportResourceMode>(
    DEFAULT_EXPORT_RESOURCE_MODE,
  );
  const [exportElapsed, setExportElapsed] = useState(0);

  useEffect(() => {
    if (pendingExport === null) {
      setExportElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setExportElapsed(Math.round((Date.now() - startedAt) / 1_000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [pendingExport]);

  // The export dialog shows the use note inline; every dialog-less entry
  // (the quick canvas buttons, the wizard's download step) surfaces it
  // once as a toast that never blocks the download.
  const [useNoteToastOpen, setUseNoteToastOpen] = useState(false);
  const useNoteShownRef = useRef(false);
  const useNoteToastTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(useNoteToastTimer.current), []);
  const maybeShowUseNote = () => {
    if (options.dialogOpen || !claimUseNoteShowing(useNoteShownRef, options.persistence)) {
      return;
    }
    setUseNoteToastOpen(true);
    window.clearTimeout(useNoteToastTimer.current);
    useNoteToastTimer.current = window.setTimeout(
      () => setUseNoteToastOpen(false),
      USE_NOTE_TOAST_MS,
    );
  };
  const dismissUseNoteToast = () => setUseNoteToastOpen(false);

  /**
   * Transcript exports drop the scroll viewport and grow the canvas until
   * every message fits. They rebuild as single-flow regardless of split so
   * "full transcript" means the whole script, not the current page. Other
   * formats export the current page, or every page when the scope says so.
   */
  const exportScenes = (kind: ExportKind, allPages: boolean): BuiltScene[] => {
    if (kind === "transcript-svg" || kind === "transcript-png") {
      return [
        buildSvgentScene({ ...project, pagination: { ...project.pagination, flow: "scroll" } }, 0, {
          fullHeight: true,
          openNotes: exportOpenNotes,
          engine: engine ?? undefined,
          generator: options.generator,
          fallbackImage: options.fallbackImage,
        }),
      ];
    }
    if (allPages && scene.pageCount > 1) {
      return Array.from({ length: scene.pageCount }, (_, page) =>
        buildSvgentScene(project, page, {
          engine: engine ?? undefined,
          generator: options.generator,
          fallbackImage: options.fallbackImage,
        }),
      );
    }
    return [scene];
  };

  // The quick toolbar button saves immediately; dialog exports wait for
  // an explicit download click so nothing lands unasked. Multi-page
  // saves are staggered — same-tick anchor clicks make browsers drop
  // every download after the first.
  const deliverExportResults = async (results: ExportResult[], autoDownload: boolean) => {
    for (const result of results) {
      options.onExport?.(result);
    }
    if (!autoDownload) {
      setExportResult(results);
      return;
    }
    for (const [index, result] of results.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_STAGGER_MS));
      }
      downloadExport(exportUrls, result);
    }
  };

  const runExport = async (
    kind: ExportKind,
    runOptions: { autoDownload?: boolean; allPages?: boolean } = {},
  ) => {
    if (engine === null || options.issues.length > 0) {
      return;
    }
    maybeShowUseNote();
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setPendingExport(kind);
    setExportProgress(null);
    // The rows about to be replaced hold the only references to their URLs.
    exportUrls.releaseAll();
    setExportResult(null);
    onUiError(null);
    await nextAnimationFrame();
    try {
      const scenes = exportScenes(kind, runOptions.allPages ?? exportAllPages);
      const appliedScale = requestedStudioExportScale(kind, exportScale, motionExportScale);
      assertBrowserMotionAdmission({
        engine,
        scenes,
        kind,
        scale: appliedScale,
        motionQuality,
        resourceMode,
        t,
      });
      const results: ExportResult[] = [];
      for (const exportScene of scenes) {
        results.push(
          await exportArtifact({
            engine,
            scene: exportScene,
            kind,
            mp4Background: project.appearance.background,
            fonts: options.resolvedFonts ?? [],
            scale: appliedScale,
            motionQuality,
            animatedSvgIterations,
            resourceMode,
            onProgress: setExportProgress,
            onEstimate: setExportEta,
            signal: controller.signal,
            allowInProcessMotionFallback: false,
            t,
          }),
        );
      }
      await deliverExportResults(results, runOptions.autoDownload ?? false);
    } catch (cause) {
      if (!(cause instanceof Error && cause.name === "AbortError")) {
        onUiError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    } finally {
      exportAbortRef.current = null;
      setPendingExport(null);
      setExportProgress(null);
      setExportEta(null);
    }
  };

  const abortExport = () => exportAbortRef.current?.abort();

  const exportScript = () => {
    // Same stamp the clipboard copy carries: a downloaded script is the other
    // half of a hand-off, and it has to say as much about itself.
    const blob = new Blob([serializeProject(project, options.provenance())], {
      type: "application/json",
    });
    downloadBlob(exportUrls, blob, `svgent-script-${exportTimestamp()}.json`);
  };

  return {
    exportUrls,
    pendingExport,
    exportProgress,
    exportEta,
    exportResult,
    exportElapsed,
    exportAllPages,
    setExportAllPages,
    exportOpenNotes,
    setExportOpenNotes,
    exportScale,
    setExportScale,
    motionExportScale,
    setMotionExportScale,
    motionQuality,
    setMotionQuality,
    animatedSvgIterations,
    setAnimatedSvgIterations,
    resourceMode,
    setResourceMode,
    exportScenes,
    runExport,
    abortExport,
    exportScript,
    useNoteToastOpen,
    dismissUseNoteToast,
  };
}
