/**
 * The export surface: the overlay dialog with its format radios, scale
 * and scope choices, run button, progress row, and finished-file rows.
 * The wizard's download step reuses the format groups, run button, and
 * progress row without mounting the dialog.
 */

import type { Engine } from "@boundsvg/core";
import {
  type AnimatedSvgIterations,
  type MotionExportQuality,
  resolveMotionExportSettings,
  resolveRasterScale,
} from "@svgent/render";
import type { BuiltScene, SvgentProject } from "@svgent/scene";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import {
  assessBrowserMotionExport,
  type BrowserMotionAssessment,
  browserMotionAssessmentMessage,
  isBrowserMotionKind,
} from "./export-policy.js";
import {
  canShareExport,
  downloadExport,
  type ExportKind,
  type ExportResourceMode,
  type ExportResult,
  type ExportUrls,
  exceedsMp4FrameLimit,
  isMp4Supported,
  mp4FrameSizeFor,
  pickH264Codec,
  resolveExportWorkerConcurrency,
  shareExport,
  splitExportFileName,
} from "./exports.js";
import { SegmentedField } from "./fields.js";
import type { UiStrings } from "./i18n.js";
import { ArrowIcon, DownloadIcon } from "./icons.js";
import { exportMotionTitleId } from "./instance.js";
import { useRaisedOverlay } from "./overlays.js";
import { formatDuration } from "./playback.js";
import { STAGE_FLIGHT_GLIDE_MS } from "./stage-flight.js";
import { HintTip } from "./widgets.js";

/**
 * What the export run button can act on: a rendered artifact, or the
 * script JSON itself — a radio like the rest, so no chip ever downloads
 * on first tap.
 */
type ExportChoice = ExportKind | "script";

/** Whether the run button can act on the selected choice right now. */
export function exportRunDisabled(options: {
  kind: ExportChoice;
  engineReady: boolean;
  busy: boolean;
  issueCount: number;
  entryBlocked?: boolean;
}): boolean {
  if (options.busy) {
    return true;
  }
  // The script needs no engine and no valid scene — it is the document.
  if (options.kind === "script") {
    return false;
  }
  return (
    !options.engineReady ||
    options.issueCount > 0 ||
    options.entryBlocked === true ||
    (options.kind === "mp4" && !isMp4Supported())
  );
}

type ExportFormatGroup = "still" | "animated-svg" | "motion-files";

const EXPORT_LABELS: Array<{ kind: ExportKind; label: string; group: ExportFormatGroup }> = [
  { kind: "poster-svg", label: "SVG", group: "still" },
  { kind: "poster-png", label: "PNG", group: "still" },
  { kind: "poster-webp", label: "WebP", group: "still" },
  { kind: "transcript-svg", label: "Transcript SVG", group: "still" },
  { kind: "transcript-png", label: "Transcript PNG", group: "still" },
  { kind: "animated-svg", label: "SVG", group: "animated-svg" },
  { kind: "mp4", label: "MP4", group: "motion-files" },
  { kind: "gif", label: "GIF", group: "motion-files" },
  { kind: "animated-webp", label: "WebP", group: "motion-files" },
];

export function isSimpleExportChoice(kind: ExportChoice): boolean {
  return kind === "script" || !isBrowserMotionKind(kind);
}

/**
 * Whether the scale factor changes anything for this choice. Scale is a
 * raster resolution multiplier, so the vector formats and the script
 * document ignore it — the buttons go dead rather than promising a
 * bigger file the export would not produce.
 */
export function exportScaleApplies(kind: ExportChoice): boolean {
  return (
    kind === "poster-png" ||
    kind === "poster-webp" ||
    kind === "transcript-png" ||
    isBrowserMotionKind(kind)
  );
}

/** Motion may only downscale; still rasters retain their enlargement choices. */
export function exportScaleOptions(kind: ExportChoice): readonly number[] {
  return isBrowserMotionKind(kind) ? [0.5, 0.75, 1] : [0.5, 0.75, 1, 2, 3];
}

/** Sampling presets change only raster/video motion formats. */
export function exportMotionQualityApplies(kind: ExportChoice): boolean {
  return kind === "animated-webp" || kind === "gif" || kind === "mp4";
}

/** Parallel raster workers are used only by the browser MP4 path. */
export function exportResourceModeApplies(kind: ExportChoice): boolean {
  return kind === "mp4";
}

/** "16:9"-style label; odd canvas sizes fall back to a decimal ratio. */
function aspectRatioLabel(width: number, height: number): string {
  let a = width;
  let b = height;
  while (b > 0) {
    [a, b] = [b, a % b];
  }
  const w = width / a;
  const h = height / a;
  return w <= 40 && h <= 40 ? `${w}:${h}` : `${(width / height).toFixed(2)}:1`;
}

function formatBytes(size: number): string {
  return size < 1_048_576
    ? `${Math.max(1, Math.round(size / 1_024))} KB`
    : `${(size / 1_048_576).toFixed(1)} MB`;
}

/**
 * The export surface is a wizard-style overlay, not a native <dialog>:
 * the live canvas flies into its slot on every screen size (a real
 * dialog's top layer would sit above anything outside it). Live, not a
 * snapshot, so the camera off-ramp and the pager show their effect right
 * where they are toggled. One decision, one action: a format radio and a
 * single run button.
 */
export function useExportOverlay(options: { glideHome: () => void }) {
  const [kind, setKind] = useState<ExportChoice>("animated-svg");
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const slotRef = useRef<HTMLDivElement | null>(null);
  // Tracked so reopening within the glide cancels the pending close —
  // an orphaned timeout would slam the fresh dialog shut mid-open.
  const closeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current !== null) {
        window.clearTimeout(closeTimer.current);
      }
    },
    [],
  );
  const openDialog = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    setOpen(true);
  }, []);
  /**
   * Unmount without gliding home when another overlay takes ownership of
   * the same live stage. Keeping the closing overlay around for the normal
   * fade would put two backdrops and panels on screen during the handoff.
   */
  const dismissDialog = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setOpen(false);
    setClosing(false);
  }, []);
  const { glideHome } = options;
  const closeDialog = useCallback(() => {
    // A second close during the glide would leave the first close's timeout
    // untracked, and it would shut whatever dialog is open when it fires.
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    // Fly the canvas home first; the overlay unmounts after the glide.
    // The flight itself is torn down once no overlay owns it.
    glideHome();
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setClosing(false);
    }, STAGE_FLIGHT_GLIDE_MS);
  }, [glideHome]);
  // Closes like the guide: Escape, ✕, or the backdrop — and Escape reaches it
  // only while it is the overlay on top. Raised through the glide too, so the
  // page stays held until the panel is actually gone.
  useRaisedOverlay(open || closing, () => {
    if (open && !closing) {
      closeDialog();
    }
  });
  return { kind, setKind, open, closing, slotRef, openDialog, closeDialog, dismissDialog };
}

type ExportOverlayHandle = ReturnType<typeof useExportOverlay>;

/** The one action the whole dialog configures. */
export function ExportRunButton({
  disabled,
  running,
  t,
  onRun,
}: {
  disabled: boolean;
  running: boolean;
  t: UiStrings;
  onRun: () => void;
}) {
  return (
    <button type="button" className="export-run" disabled={disabled} onClick={onRun}>
      {running ? t.exportRunning : `↓ ${t.exportStart}`}
    </button>
  );
}

/**
 * Slide pager inside the export dialog, mirroring the canvas pager: the
 * preview and the "this page" scope both point at a page the dialog must
 * be able to change. Single-flow scripts never mount it.
 */
function ExportPager({
  pageIndex,
  pageCount,
  t,
  onPageChange,
}: {
  pageIndex: number;
  pageCount: number;
  t: UiStrings;
  onPageChange: (pageIndex: number) => void;
}) {
  if (pageCount <= 1) {
    return null;
  }
  return (
    <div className="page-controls export-pager">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
        disabled={pageIndex === 0}
      >
        <ArrowIcon direction="left" />
      </button>
      <span>{t.pageIndicator(pageIndex + 1, pageCount)}</span>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(pageCount - 1, pageIndex + 1))}
        disabled={pageIndex >= pageCount - 1}
      >
        <ArrowIcon direction="right" />
      </button>
    </div>
  );
}

/**
 * Whether MP4 can take the frame the current settings ask for. The spec
 * table rules out the impossible immediately; the encoder itself gets the
 * final word because hardware declines sizes H.264 permits, and that
 * answer only arrives asynchronously.
 */
function Mp4SizeWarning({
  appearance,
  exportScale,
  note,
}: {
  appearance: SvgentProject["appearance"];
  exportScale: number;
  note: string;
}) {
  const { canvasWidth, canvasHeight } = appearance;
  const beyondSpec = exceedsMp4FrameLimit(canvasWidth, canvasHeight, exportScale);
  const [encodable, setEncodable] = useState(true);
  useEffect(() => {
    if (beyondSpec) {
      setEncodable(false);
      return;
    }
    let live = true;
    const frame = mp4FrameSizeFor(canvasWidth, canvasHeight, exportScale);
    pickH264Codec(frame.width, frame.height)
      .then((codec) => {
        if (live) {
          setEncodable(codec !== null);
        }
      })
      .catch(() => {
        // Probe unavailable: stay quiet and let the export report instead.
        if (live) {
          setEncodable(true);
        }
      });
    return () => {
      live = false;
    };
  }, [beyondSpec, canvasWidth, canvasHeight, exportScale]);
  return encodable ? null : <small className="export-warning">{note}</small>;
}

/**
 * The scale factor row and the pixel readout it drives. A vector or script
 * choice emits at the canvas size whatever the factor says, so the buttons
 * go dead and the readout reports ×1 rather than quoting a size the export
 * would never produce.
 */
function ExportScaleControls({
  kind,
  appearance,
  durationMs,
  exportScale,
  motionExportScale,
  busy,
  onExportScaleChange,
  onMotionExportScaleChange,
  t,
}: {
  kind: ExportChoice;
  appearance: SvgentProject["appearance"];
  durationMs: number;
  exportScale: number;
  motionExportScale: number;
  busy: boolean;
  onExportScaleChange: (scale: number) => void;
  onMotionExportScaleChange: (scale: number) => void;
  t: UiStrings;
}) {
  const { canvasWidth, canvasHeight } = appearance;
  const motion = isBrowserMotionKind(kind);
  const applies = exportScaleApplies(kind);
  const unavailableNote = motion ? t.exportScaleMotionNote : t.exportScaleVectorNote;
  const selectedScale = motion ? motionExportScale : exportScale;
  const requestedScale = applies ? selectedScale : 1;
  const scaleOptions = exportScaleOptions(kind);
  const onScaleChange = motion ? onMotionExportScaleChange : onExportScaleChange;
  // The engine caps raster output and quietly renders smaller, so a factor it
  // would swallow is offered as dead rather than as a bigger file.
  const resolved = resolveRasterScale({
    width: canvasWidth,
    height: canvasHeight,
    requestedScale,
  });
  return (
    <>
      <div className="export-scale">
        <span>
          {t.exportScaleLabel}
          <HintTip text={t.tipExportScale} />
        </span>
        {scaleOptions.map((factor) => {
          const capped =
            applies &&
            resolveRasterScale({ width: canvasWidth, height: canvasHeight, requestedScale: factor })
              .adjusted;
          return (
            <button
              type="button"
              key={factor}
              className={requestedScale === factor ? "is-active" : ""}
              disabled={busy || !applies || capped}
              title={applies ? (capped ? t.exportScaleCappedNote : undefined) : unavailableNote}
              onClick={() => onScaleChange(factor)}
            >
              ×{factor}
            </button>
          );
        })}
      </div>
      {/* The numbers the scale choice actually changes, kept off the
      button row so it stays short. */}
      <small className="export-meta">
        {aspectRatioLabel(canvasWidth, canvasHeight)} · {resolved.outputWidth}×
        {resolved.outputHeight}px · {formatDuration(durationMs)}
        {applies ? "" : ` · ${unavailableNote}`}
      </small>
      {resolved.adjusted ? (
        <small className="export-warning">{t.exportScaleCappedNote}</small>
      ) : null}
      {/* H.264 has a hard frame-size ceiling, so say so while the choice is
      still cheap to change rather than after a long encode throws. */}
      {kind === "mp4" ? (
        <Mp4SizeWarning
          appearance={appearance}
          exportScale={resolved.appliedScale}
          note={t.exportMp4TooLargeNote}
        />
      ) : null}
    </>
  );
}

function ExportMotionControls({
  kind,
  motionQuality,
  resourceMode,
  assessment,
  busy,
  onMotionQualityChange,
  onResourceModeChange,
  t,
}: {
  kind: ExportChoice;
  motionQuality: MotionExportQuality;
  resourceMode: ExportResourceMode;
  assessment: BrowserMotionAssessment | null;
  busy: boolean;
  onMotionQualityChange: (quality: MotionExportQuality) => void;
  onResourceModeChange: (mode: ExportResourceMode) => void;
  t: UiStrings;
}) {
  if (!exportMotionQualityApplies(kind)) {
    return null;
  }
  const qualityOptions: MotionExportQuality[] = ["economy", "balanced", "high"];
  const settings = resolveMotionExportSettings(motionQuality);
  const frameRate = kind === "mp4" ? settings.mp4FrameRate : settings.animatedRasterFps;
  const resourceApplies = exportResourceModeApplies(kind);
  const workerCount = resolveExportWorkerConcurrency(
    resourceMode,
    globalThis.navigator?.hardwareConcurrency ?? 4,
  );
  return (
    <>
      <div className="export-scale">
        <span>
          {t.exportMotionQualityLabel}
          <HintTip text={t.tipExportMotionQuality} />
        </span>
        {qualityOptions.map((option) => {
          const optionSettings = resolveMotionExportSettings(option);
          const optionFps =
            kind === "mp4" ? optionSettings.mp4FrameRate : optionSettings.animatedRasterFps;
          const fpsUnavailable =
            kind !== "mp4" && assessment !== null && optionFps > assessment.maximumEffectiveFps;
          return (
            <button
              type="button"
              key={option}
              className={motionQuality === option ? "is-active" : ""}
              disabled={busy || fpsUnavailable}
              title={fpsUnavailable ? t.exportMotionQualityUnavailable(optionFps) : undefined}
              onClick={() => onMotionQualityChange(option)}
            >
              {optionFps} fps
            </button>
          );
        })}
      </div>
      <small className="export-meta">{t.exportMotionQualityNote(frameRate)}</small>
      {resourceApplies ? (
        <>
          <div className="export-scale">
            <span>
              {t.exportResourceModeLabel}
              <HintTip text={t.tipExportResourceMode} />
            </span>
            {(
              [
                { value: "memory", label: t.exportResourceModeMemory },
                { value: "balanced", label: t.exportResourceModeBalanced },
                { value: "speed", label: t.exportResourceModeSpeed },
              ] as const
            ).map((option) => (
              <button
                type="button"
                key={option.value}
                className={resourceMode === option.value ? "is-active" : ""}
                disabled={busy}
                onClick={() => onResourceModeChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <small className="export-meta">{t.exportResourceModeNote(workerCount)}</small>
        </>
      ) : null}
    </>
  );
}

type BrowserMotionAssessmentState = {
  checking: boolean;
  assessment: BrowserMotionAssessment | null;
  failed: boolean;
};

function useBrowserMotionAssessment(options: {
  active: boolean;
  engine: Engine | null;
  scene: BuiltScene;
  kind: ExportChoice;
  scale: number;
  motionQuality: MotionExportQuality;
  resourceMode: ExportResourceMode;
}): BrowserMotionAssessmentState {
  const [state, setState] = useState<BrowserMotionAssessmentState>({
    checking: false,
    assessment: null,
    failed: false,
  });
  useEffect(() => {
    if (!options.active || options.engine === null || !isBrowserMotionKind(options.kind)) {
      setState({ checking: false, assessment: null, failed: false });
      return;
    }
    let live = true;
    setState({ checking: true, assessment: null, failed: false });
    const timer = window.setTimeout(() => {
      if (!live || options.engine === null || !isBrowserMotionKind(options.kind)) {
        return;
      }
      try {
        const assessment = assessBrowserMotionExport({
          engine: options.engine,
          scene: options.scene,
          kind: options.kind,
          scale: options.scale,
          motionQuality: options.motionQuality,
          workerCount: resolveExportWorkerConcurrency(
            options.resourceMode,
            globalThis.navigator?.hardwareConcurrency ?? 4,
          ),
        });
        if (live) {
          setState({ checking: false, assessment, failed: false });
        }
      } catch {
        if (live) {
          setState({ checking: false, assessment: null, failed: true });
        }
      }
    }, 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [
    options.active,
    options.engine,
    options.kind,
    options.motionQuality,
    options.resourceMode,
    options.scale,
    options.scene,
  ]);
  return state;
}

function ExportMotionAssessmentNote({
  state,
  t,
}: {
  state: BrowserMotionAssessmentState;
  t: UiStrings;
}) {
  if (state.checking) {
    return <p className="stage-note">{t.exportMotionPreflightChecking}</p>;
  }
  if (state.failed) {
    return <div className="issue-list">{t.exportMotionPreflightFailed}</div>;
  }
  if (state.assessment === null) {
    return null;
  }
  const blocked = state.assessment.status === "blocked";
  const warning = state.assessment.status === "warning";
  return (
    <div className={`issue-list${blocked ? "" : " is-warning"}`}>
      <p>{browserMotionAssessmentMessage(state.assessment, t)}</p>
      {blocked || warning ? <p>{t.exportMotionCliNote}</p> : null}
      <p>{t.exportMotionBrowserLifecycleNote}</p>
    </div>
  );
}

/**
 * What a finished render offers: the artifact itself, then a row per file with
 * the ways to take it away.
 *
 * Both the wizard and the detailed dialog render this one component. They used
 * to differ — the wizard saved every file the moment it finished and showed
 * nothing — which left the reader least likely to go looking for options with
 * the fewest of them, and no way to see what had been made without opening it
 * from wherever the browser had put it.
 */
export function ExportResultsBlock({
  results,
  urls,
  endRef,
  svgPlaysOnce,
  t,
}: {
  results: ExportResult[] | null;
  urls: ExportUrls;
  /** Where the reveal should stop when something follows the rows. */
  endRef?: RefObject<HTMLDivElement | null>;
  /** The dialog exported a once-through animated SVG, so its preview rests. */
  svgPlaysOnce?: boolean;
  t: UiStrings;
}) {
  const lastRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (results === null) {
      return;
    }
    // A finished render appends its rows below the run button, which is where
    // the surface is scrolled to by the time it finishes — so the file and the
    // ways to take it away arrive off screen, with nothing to say the work is
    // done. Bring the last of them the minimum distance into view;
    // `block: "nearest"` leaves a row that is already visible alone, so this
    // does not become a panel that scrolls itself while being read.
    const frame = window.requestAnimationFrame(() => {
      (endRef?.current ?? lastRowRef.current)?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [results, endRef]);
  return (
    <>
      <ExportPreview results={results} urls={urls} svgPlaysOnce={svgPlaysOnce === true} t={t} />
      <ExportResultRows results={results} urls={urls} endRef={endRef ?? lastRowRef} t={t} />
    </>
  );
}

/**
 * The artifact itself, played where it was made.
 *
 * Saving used to be the only way to see what came out, and on a phone that
 * means leaving the page: the reader taps through a download sheet into a
 * full-screen viewer, and iOS reclaims the backgrounded tab while they are
 * looking. They came back to a studio that had reloaded. The fix is not to
 * make leaving safer but to remove the reason for it — the check they wanted
 * is a check they can do here.
 *
 * Declarative SVG animation runs inside `img`, which is how the animating SVG
 * plays without a frame of its own; only script and external resources are
 * withheld there, and this output carries neither.
 */
function ExportPreview({
  results,
  urls,
  svgPlaysOnce,
  t,
}: {
  results: ExportResult[] | null;
  urls: ExportUrls;
  svgPlaysOnce: boolean;
  t: UiStrings;
}) {
  const [replays, setReplays] = useState(0);
  const shown = results?.[0];
  if (shown === undefined) {
    return null;
  }
  const source = urls.url(shown.blob);
  const rest = (results?.length ?? 0) - 1;
  const isVideo = shown.blob.type.startsWith("video/");
  // A looping export needs no control — the animated SVG loops on its document
  // clock the way GIF and WebP are encoded to. Only a once-through SVG rests
  // on its last frame, and `img` offers no way back without this.
  const replayable = shown.kind === "animated-svg" && svgPlaysOnce;
  return (
    <>
      <figure className="export-preview">
        <figcaption>
          {t.exportPreviewLabel}
          <span className="export-preview-format">
            {splitExportFileName(shown.kind, shown.fileName).suffix}
          </span>
          {replayable ? (
            <button
              type="button"
              className="export-preview-replay"
              onClick={() => setReplays((count) => count + 1)}
            >
              ↺ {t.exportPreviewReplay}
            </button>
          ) : null}
        </figcaption>
        {isVideo ? (
          // Muted and inline: a phone otherwise takes the video full screen on
          // play, which is the departure this preview exists to avoid.
          <video src={source} controls muted playsInline preload="metadata" />
        ) : (
          // Keyed on the replay count as well as the source: assigning the same
          // URL again leaves a decoded image where it stopped, so the element
          // has to be built anew for the animation to start over.
          <img key={`${source}#${replays}`} src={source} alt={shown.fileName} />
        )}
      </figure>
      {rest > 0 ? <p className="export-soft-note">{t.exportPreviewMore(rest)}</p> : null}
    </>
  );
}

/**
 * Saving and sending are different wants, so both stay: the share sheet on iOS
 * can write a file too, but it asks where first, and someone who only wants the
 * file should not have to answer that. The share button is present only where
 * the browser says it would work, so nothing changes meaning between devices.
 */
function ExportResultActions({
  file,
  urls,
  t,
}: {
  file: ExportResult;
  urls: ExportUrls;
  t: UiStrings;
}) {
  const [shareable] = useState(() => canShareExport(file));
  return (
    <span className="export-result-actions">
      <button type="button" onClick={() => downloadExport(urls, file)}>
        ↓ {t.exportDownload}
      </button>
      {shareable ? (
        <button
          type="button"
          onClick={() => {
            // A cancelled sheet is an answer, not a failure. Anything else
            // leaves the reader with nothing, so the save they could have had
            // happens instead.
            shareExport(file).catch((error: unknown) => {
              if (!(error instanceof DOMException) || error.name !== "AbortError") {
                downloadExport(urls, file);
              }
            });
          }}
        >
          ↗ {t.exportShare}
        </button>
      ) : null}
    </span>
  );
}

/** Finished renders, each with its size and the ways to take it away. */
function ExportResultRows({
  results,
  urls,
  endRef,
  t,
}: {
  results: ExportResult[] | null;
  urls: ExportUrls;
  endRef?: RefObject<HTMLDivElement | null>;
  t: UiStrings;
}) {
  if (!results) {
    return null;
  }
  return (
    <>
      {results.map((file, index) => (
        <div
          className="export-result"
          key={file.fileName}
          ref={endRef !== undefined && index === results.length - 1 ? endRef : undefined}
        >
          {/* The name is the row's only elastic part, and the title carries
              what the ellipsis takes: wrapping it grew the row past the
              download button it sits beside, three lines deep on a phone. */}
          <span className="export-result-name" title={file.fileName}>
            {/* The suffix is the only part that says what was rendered, and
                truncation takes the name from the end — so it is carried
                beside the stem rather than inside what gets cut. */}
            <span className="export-result-file">
              <span className="export-result-stem">
                {splitExportFileName(file.kind, file.fileName).stem}
              </span>
              <span className="export-result-ext">
                {splitExportFileName(file.kind, file.fileName).suffix}
              </span>
            </span>
            <small>{formatBytes(file.blob.size)}</small>
          </span>
          <ExportResultActions file={file} urls={urls} t={t} />
        </div>
      ))}
    </>
  );
}

/** Script stays a separate user gesture so browsers never see a download burst. */
function ExportScriptResultRow({
  onDownload,
  endRef,
  t,
}: {
  onDownload: () => void;
  endRef?: RefObject<HTMLDivElement | null>;
  t: UiStrings;
}) {
  return (
    <div className="export-result export-script-result" ref={endRef}>
      <span className="export-result-name">svgent-script.json</span>
      <button type="button" onClick={onDownload}>
        ↓ {t.exportDownload}
      </button>
    </div>
  );
}

/** Mutually exclusive artifact formats; the simple wizard also offers script-only save. */
export function ExportFormatGroups({
  kind,
  onKindChange,
  t,
  mode = "all",
}: {
  kind: ExportChoice;
  onKindChange: (kind: ExportChoice) => void;
  t: UiStrings;
  mode?: "all" | "simple";
}) {
  // Format names are proper nouns; only the descriptive "Transcript" prefix
  // needs a locale.
  const exportLabel = (labelKind: ExportKind, label: string): string =>
    labelKind === "transcript-svg"
      ? t.exportTranscriptSvg
      : labelKind === "transcript-png"
        ? t.exportTranscriptPng
        : labelKind === "animated-svg"
          ? t.exportAnimatedSvgRecommended
          : label;
  const groups: ExportFormatGroup[] =
    mode === "simple" ? ["still", "animated-svg"] : ["still", "animated-svg", "motion-files"];
  const groupLabel = (group: ExportFormatGroup): string => {
    switch (group) {
      case "still":
        return t.exportGroupStill;
      case "animated-svg":
        return t.exportGroupAnimatedSvg;
      case "motion-files":
        return t.exportGroupMotionFiles;
    }
  };
  return (
    <div className="export-groups">
      {groups.map((group) => (
        <div
          className="export-chip-group"
          role="radiogroup"
          aria-label={groupLabel(group)}
          key={group}
        >
          <span>{groupLabel(group)}</span>
          {/* Chips wrap inside their own column so a second line starts
              under the first chip, never under the group label. */}
          <div className="export-chips">
            {EXPORT_LABELS.filter((entry) => entry.group === group).map(
              ({ kind: entryKind, label }) => (
                // biome-ignore lint/a11y/useSemanticElements: chip-styled buttons that only select; the group carries radiogroup and aria-checked, and a native input cannot render the chip visuals
                <button
                  type="button"
                  role="radio"
                  aria-checked={kind === entryKind}
                  className={kind === entryKind ? "is-active" : ""}
                  key={entryKind}
                  disabled={entryKind === "mp4" && !isMp4Supported()}
                  onClick={() => onKindChange(entryKind)}
                >
                  {exportLabel(entryKind, label)}
                </button>
              ),
            )}
          </div>
        </div>
      ))}
      {mode === "simple" ? (
        // The simple wizard still permits saving only the authored document.
        <div className="export-chip-group" role="radiogroup" aria-label={t.exportGroupScript}>
          <span>{t.exportGroupScript}</span>
          <div className="export-chips">
            {/* biome-ignore lint/a11y/useSemanticElements: chip-styled button that only selects; the group carries radiogroup and aria-checked, and a native input cannot render the chip visuals */}
            <button
              type="button"
              role="radio"
              aria-checked={kind === "script"}
              className={kind === "script" ? "is-active" : ""}
              onClick={() => onKindChange("script")}
            >
              JSON
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** In-flight render feedback: frame progress or ETA, and cancel for the slow kinds. */
export function ExportProgressRow({
  pendingExport,
  exportProgress,
  exportEta,
  exportElapsed,
  onAbort,
  t,
}: {
  pendingExport: ExportKind | null;
  exportProgress: { done: number; total: number } | null;
  exportEta: number | null;
  exportElapsed: number;
  onAbort: () => void;
  t: UiStrings;
}) {
  if (pendingExport === null) {
    return null;
  }
  return (
    <div className="export-progress-row">
      <div className={`export-progress${exportProgress ? "" : " is-indeterminate"}`}>
        <span
          style={
            exportProgress
              ? { width: `${(exportProgress.done / exportProgress.total) * 100}%` }
              : undefined
          }
        />
        <output>
          {exportProgress
            ? `${exportProgress.done}/${exportProgress.total} frames`
            : exportEta !== null
              ? t.exportEta(exportElapsed, Math.max(1, Math.round(exportEta / 1_000)))
              : t.exportRunning}
        </output>
      </div>
      {pendingExport === "mp4" || pendingExport === "animated-webp" || pendingExport === "gif" ? (
        <button type="button" className="export-cancel" onClick={onAbort}>
          ✕ {t.cancelExport}
        </button>
      ) : null}
    </div>
  );
}

/** Transcript stills can open highlighted thinking notes in flow. */
function OpenNotesToggle({
  kind,
  project,
  exportOpenNotes,
  onChange,
  t,
}: {
  kind: ExportChoice;
  project: SvgentProject;
  exportOpenNotes: boolean;
  onChange: (openNotes: boolean) => void;
  t: UiStrings;
}) {
  const applies =
    project.surface === "app" && (kind === "transcript-svg" || kind === "transcript-png");
  const hasHighlight = project.messages.some(
    (message) => message.role === "thinking" && message.highlight === true,
  );
  if (!applies || !hasHighlight) {
    return null;
  }
  return (
    <label className="export-script-toggle">
      <input
        type="checkbox"
        checked={exportOpenNotes}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>
        <strong>{t.exportOpenNotes}</strong>
      </span>
    </label>
  );
}

/** The full export overlay; mounts only while open or gliding closed. */
export function ExportDialog({
  instance,
  overlay,
  engine,
  scene,
  project,
  issues,
  engineReady,
  pendingExport,
  exportProgress,
  exportEta,
  exportElapsed,
  exportResult,
  exportUrls,
  exportScale,
  onExportScaleChange,
  motionExportScale,
  onMotionExportScaleChange,
  motionQuality,
  onMotionQualityChange,
  animatedSvgIterations,
  onAnimatedSvgIterationsChange,
  resourceMode,
  onResourceModeChange,
  exportAllPages,
  onExportScopeChange,
  exportOpenNotes,
  onExportOpenNotesChange,
  onPageChange,
  onBasisChange,
  onCameraFollowChange,
  onRun,
  onAbort,
  onExportScript,
  t,
}: {
  /**
   * The owning studio's identity. `aria-labelledby` resolves against the whole
   * document, so a second dialog would otherwise be labelled by the first
   * studio's heading.
   */
  instance: string;
  overlay: ExportOverlayHandle;
  engine: Engine | null;
  scene: BuiltScene;
  project: SvgentProject;
  issues: string[];
  engineReady: boolean;
  pendingExport: ExportKind | null;
  exportProgress: { done: number; total: number } | null;
  exportEta: number | null;
  exportElapsed: number;
  exportResult: ExportResult[] | null;
  exportUrls: ExportUrls;
  exportScale: number;
  onExportScaleChange: (scale: number) => void;
  motionExportScale: number;
  onMotionExportScaleChange: (scale: number) => void;
  motionQuality: MotionExportQuality;
  onMotionQualityChange: (quality: MotionExportQuality) => void;
  animatedSvgIterations: AnimatedSvgIterations;
  onAnimatedSvgIterationsChange: (iterations: AnimatedSvgIterations) => void;
  resourceMode: ExportResourceMode;
  onResourceModeChange: (mode: ExportResourceMode) => void;
  exportAllPages: boolean;
  onExportScopeChange: (allPages: boolean) => void;
  exportOpenNotes: boolean;
  onExportOpenNotesChange: (openNotes: boolean) => void;
  onPageChange: (pageIndex: number) => void;
  onBasisChange: (basis: SvgentProject["basis"]) => void;
  onCameraFollowChange: (follow: boolean) => void;
  onRun: () => void;
  onAbort: () => void;
  onExportScript: () => void;
  t: UiStrings;
}) {
  const [includeScript, setIncludeScript] = useState(false);
  const motionOptionsRef = useRef<HTMLElement | null>(null);
  const resultsEndRef = useRef<HTMLDivElement | null>(null);
  const previousKindRef = useRef<ExportChoice>(overlay.kind);
  const motionAssessment = useBrowserMotionAssessment({
    active: overlay.open && !overlay.closing && pendingExport === null,
    engine,
    scene,
    kind: overlay.kind,
    scale: motionExportScale,
    motionQuality,
    resourceMode,
  });
  const motionEntryBlocked =
    isBrowserMotionKind(overlay.kind) &&
    (motionAssessment.checking ||
      motionAssessment.failed ||
      motionAssessment.assessment?.status === "blocked");
  useEffect(() => {
    if (!overlay.open || overlay.kind !== "script") {
      return;
    }
    // The simple wizard can still select a script-only save. In the detailed
    // dialog, preserve that intent as the independent JSON toggle and restore
    // an actual artifact choice for the mutually exclusive format radios.
    setIncludeScript(true);
    overlay.setKind("animated-svg");
  }, [overlay.kind, overlay.open, overlay.setKind]);
  useEffect(() => {
    const kindChanged = previousKindRef.current !== overlay.kind;
    previousKindRef.current = overlay.kind;
    if (!overlay.open || !kindChanged || !isBrowserMotionKind(overlay.kind)) {
      return;
    }
    // The extra controls can be inserted below a short dialog's fold. Reveal
    // only the minimum hidden portion so the user sees what their format
    // choice added, without flashing or moving a block that is already shown.
    const frame = window.requestAnimationFrame(() => {
      motionOptionsRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [overlay.kind, overlay.open]);
  if (!overlay.open && !overlay.closing) {
    return null;
  }
  const emptyMessageCount = project.messages.filter(
    (message) => message.content.trim() === "",
  ).length;
  const scriptRowShown = includeScript && pendingExport === null && exportResult !== null;
  // Only the first artifact is played. A deck exports one file per page, and
  // holding every one of them in a media element is the memory pressure that
  // gets the tab reclaimed — the very thing this preview is here to prevent.
  const finishedResults = pendingExport === null ? exportResult : null;
  return (
    <div className={`wizard-overlay export-overlay${overlay.closing ? " is-closing" : ""}`}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close mirrors dialog::backdrop behavior; Escape handles keyboards */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes via the window listener */}
      <div className="wizard-backdrop" onClick={overlay.closeDialog} />
      <div className="export-dialog" role="dialog" aria-label={t.exportTitle}>
        <header className="export-head">
          <DownloadIcon />
          <strong>{t.exportTitle}</strong>
          <span className="export-file">{scene.fileStem}.*</span>
          <button
            type="button"
            className="export-close"
            aria-label={t.exportClose}
            onClick={overlay.closeDialog}
          >
            ✕
          </button>
        </header>
        <div className="wizard-stage-slot export-stage-slot" ref={overlay.slotRef} />
        <div className="export-dialog-options">
          <ExportPager
            pageIndex={scene.pageIndex}
            pageCount={scene.pageCount}
            t={t}
            onPageChange={onPageChange}
          />
          <ExportFormatGroups kind={overlay.kind} onKindChange={overlay.setKind} t={t} />
          {overlay.kind === "animated-svg" ? (
            <SegmentedField
              label={t.exportSvgPlaybackLabel}
              value={animatedSvgIterations}
              options={[
                { value: "infinite", label: t.exportSvgPlaybackLoop },
                { value: "once", label: t.exportSvgPlaybackOnce },
              ]}
              onChange={onAnimatedSvgIterationsChange}
            />
          ) : null}
          <OpenNotesToggle
            kind={overlay.kind}
            project={project}
            exportOpenNotes={exportOpenNotes}
            onChange={onExportOpenNotesChange}
            t={t}
          />
          <label className="export-script-toggle">
            <input
              type="checkbox"
              checked={includeScript}
              onChange={(event) => setIncludeScript(event.currentTarget.checked)}
            />
            <span>
              <strong>{t.exportIncludeScriptLabel}</strong>
              <small>{t.exportIncludeScriptNote}</small>
            </span>
          </label>
          {!isBrowserMotionKind(overlay.kind) ? (
            <ExportScaleControls
              kind={overlay.kind}
              appearance={project.appearance}
              durationMs={scene.durationMs}
              exportScale={exportScale}
              motionExportScale={motionExportScale}
              busy={pendingExport !== null}
              onExportScaleChange={onExportScaleChange}
              onMotionExportScaleChange={onMotionExportScaleChange}
              t={t}
            />
          ) : null}
          {isBrowserMotionKind(overlay.kind) ? (
            <section
              className="export-motion-options"
              aria-labelledby={exportMotionTitleId(instance)}
              ref={motionOptionsRef}
            >
              <header className="export-motion-options-head">
                <h3 id={exportMotionTitleId(instance)}>{t.exportMotionSettingsLabel}</h3>
                <small>{t.exportMotionSettingsNote}</small>
              </header>
              <ExportScaleControls
                kind={overlay.kind}
                appearance={project.appearance}
                durationMs={scene.durationMs}
                exportScale={exportScale}
                motionExportScale={motionExportScale}
                busy={pendingExport !== null}
                onExportScaleChange={onExportScaleChange}
                onMotionExportScaleChange={onMotionExportScaleChange}
                t={t}
              />
              <ExportMotionControls
                kind={overlay.kind}
                motionQuality={motionQuality}
                resourceMode={resourceMode}
                assessment={motionAssessment.assessment}
                busy={pendingExport !== null}
                onMotionQualityChange={onMotionQualityChange}
                onResourceModeChange={onResourceModeChange}
                t={t}
              />
              <ExportMotionAssessmentNote state={motionAssessment} t={t} />
            </section>
          ) : null}
          {/* The basis declaration lives where it takes effect: what the
        exported artifact records as model-kind. svgent does not verify
        the claim (it cannot see any session) — it records it. */}
          <SegmentedField
            label={t.fieldBasis}
            value={project.basis}
            options={[
              { value: "fictional", label: t.basisFictional },
              { value: "reenactment", label: t.basisReenactment },
            ]}
            onChange={onBasisChange}
          />
          <SegmentedField
            label={t.cameraModeLabel}
            value={project.camera.follow ? "follow" : "off"}
            options={[
              { value: "off", label: t.cameraOff },
              { value: "follow", label: t.cameraFollow },
            ]}
            onChange={(value) => onCameraFollowChange(value === "follow")}
          />
          {scene.pageCount > 1 ? (
            <SegmentedField
              label={t.exportScopeLabel}
              value={exportAllPages ? "all" : "current"}
              options={[
                { value: "current", label: t.exportScopeCurrent(scene.pageIndex + 1) },
                { value: "all", label: t.exportScopeAll(scene.pageCount) },
              ]}
              onChange={(value) => onExportScopeChange(value === "all")}
            />
          ) : null}
          <p className="stage-note">
            {t.exportLocalNote} {t.exportNote}
            {!isMp4Supported() ? t.mp4Note : ""}
          </p>
          {/* The line that matters gets reading size; spec notes stay small. */}
          <p className="export-use-note">{t.exportUseNote}</p>
          {emptyMessageCount > 0 ? (
            <p className="export-soft-note">{t.emptyExportNote(emptyMessageCount)}</p>
          ) : null}
          {issues.length > 0 ? (
            <div className="issue-list" role="alert">
              {issues.map((issue) => (
                <p key={issue}>• {issue}</p>
              ))}
            </div>
          ) : null}
          <ExportRunButton
            disabled={exportRunDisabled({
              kind: overlay.kind,
              engineReady,
              busy: pendingExport !== null,
              issueCount: issues.length,
              entryBlocked: motionEntryBlocked,
            })}
            running={pendingExport !== null}
            t={t}
            onRun={onRun}
          />
          <ExportProgressRow
            pendingExport={pendingExport}
            exportProgress={exportProgress}
            exportEta={exportEta}
            exportElapsed={exportElapsed}
            onAbort={onAbort}
            t={t}
          />
          <ExportResultsBlock
            results={finishedResults}
            urls={exportUrls}
            endRef={scriptRowShown ? undefined : resultsEndRef}
            svgPlaysOnce={animatedSvgIterations === "once"}
            t={t}
          />
          {scriptRowShown ? (
            <ExportScriptResultRow onDownload={onExportScript} endRef={resultsEndRef} t={t} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
