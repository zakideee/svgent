/**
 * The step-by-step guide that overlays the editor from the header
 * button: format → look → size → script → edit → export. The live
 * canvas flies into its slot, so every choice is seen on the real
 * canvas, in place.
 */

import {
  AGENT_BEHAVIOR_PRESETS,
  DISPLAY_PRESETS,
  MAX_MESSAGE_CHARS,
  SIZE_PRESETS,
  type SvgentProject,
  USER_INPUT_PRESETS,
} from "@svgent/scene";
import type React from "react";
import { useEffect, useRef } from "react";
import {
  BackdropChips,
  isTimingPresetActive,
  ThemePresetGrid,
  turnCameraOff,
} from "./appearance-controls.js";
import {
  ExportFormatGroups,
  ExportProgressRow,
  ExportResultsBlock,
  ExportRunButton,
  exportRunDisabled,
  isSimpleExportChoice,
  type useExportOverlay,
} from "./export-panel.js";
import type { ExportKind, ExportResult, ExportUrls } from "./exports.js";
import type { Lang, UiStrings } from "./i18n.js";
import { ArrowIcon, SurfaceArtApp, SurfaceArtTui } from "./icons.js";
import { ROLE_LABELS } from "./message-editor.js";
import { CameraOffRamp } from "./notices.js";
import type { useProjectActions } from "./project-actions.js";
import { PresetSkeleton } from "./widgets.js";

/** Wizard step that offers the script sources (AI assist and the gallery). */
export const WIZARD_SCRIPT_STEP = 4;
/** Wizard step that rewrites the chosen script's text in your own words. */
export const WIZARD_EDIT_STEP = 5;
/** Final wizard step: pick a format and download. */
export const WIZARD_EXPORT_STEP = 6;

export function WizardOverlay({
  step,
  closing,
  slotRef,
  project,
  pageIndex,
  pageCount,
  lang,
  t,
  setProject,
  actions,
  engineReady,
  issues,
  exportOverlay,
  pendingExport,
  exportProgress,
  exportEta,
  exportElapsed,
  appliedPresetLabel,
  onStepChange,
  onClose,
  onPageChange,
  onOpenAssist,
  onOpenGallery,
  onOpenEditor,
  onMessageFocus,
  onMessageBlur,
  exportUrls,
  exportResult,
  onRunExport,
  onAbortExport,
  onMoreFormats,
}: {
  step: number | null;
  closing: boolean;
  /** The flight destination; aimed by useStageFlightAim in the caller. */
  slotRef: React.RefObject<HTMLDivElement | null>;
  project: SvgentProject;
  pageIndex: number;
  pageCount: number;
  lang: Lang;
  t: UiStrings;
  /**
   * The raw project updater, for the wizard's compound edits (surface,
   * canvas size, theme trio, backdrop, flow, timing spreads, camera) that
   * have no single-field action; single-field edits go through `actions`.
   */
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>;
  actions: Pick<
    ReturnType<typeof useProjectActions>,
    "updateAppearance" | "updateMessage" | "applyDisplayPreset"
  >;
  engineReady: boolean;
  issues: string[];
  exportOverlay: Pick<ReturnType<typeof useExportOverlay>, "kind" | "setKind">;
  pendingExport: ExportKind | null;
  exportProgress: { done: number; total: number } | null;
  exportEta: number | null;
  exportElapsed: number;
  /** The sample just chosen in the gallery, retained through the guide. */
  appliedPresetLabel: string | null;
  onStepChange: (step: number) => void;
  onClose: () => void;
  onPageChange: (pageIndex: number) => void;
  onOpenAssist: () => void;
  onOpenGallery: () => void;
  /** Jump to the script tab's full editor and leave the wizard. */
  onOpenEditor: () => void;
  onMessageFocus: (messageId: string) => void;
  onMessageBlur: (messageId: string) => void;
  exportUrls: ExportUrls;
  exportResult: ExportResult[] | null;
  onRunExport: () => void;
  onAbortExport: () => void;
  /** Hand off to the export dialog, keeping the flight alive. */
  onMoreFormats: () => void;
}) {
  const { kind: exportKind, setKind: setExportKind } = exportOverlay;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (step === WIZARD_EXPORT_STEP && !isSimpleExportChoice(exportKind)) {
      setExportKind("animated-svg");
    }
  }, [exportKind, setExportKind, step]);
  // Every step renders the same element in the same slot, so React keeps the
  // scrollport rather than building a new one and the offset carries over.
  // A tall step scrolled to its end therefore opened the next one below its
  // own content — the script step arrived blank.
  // biome-ignore lint/correctness/useExhaustiveDependencies: step is the trigger — the scroll reset must run on every step change even though the effect never reads it.
  useEffect(() => {
    bodyRef.current?.querySelector(".wizard-body")?.scrollTo({ top: 0 });
  }, [step]);
  if (step === null && !closing) {
    return null;
  }
  const { updateAppearance, updateMessage, applyDisplayPreset } = actions;

  /** Wizard step: choose or generate the script. */
  const scriptStep = (
    <div className="wizard-body">
      <p>{t.wizardScriptLead}</p>
      <div className="wizard-card-grid">
        <button type="button" className="wizard-card wizard-assist-card" onClick={onOpenAssist}>
          <span className="wizard-assist-art" aria-hidden="true">
            ✨
          </span>
          <span className="wizard-card-title">{t.wizardAssistButton}</span>
          <small>{t.wizardAssistDesc}</small>
        </button>
        {/* The samples themselves live in the gallery dialog: two equal
            entry cards here keep the CTA from visually endorsing whichever
            preset the grid happened to place beneath it. */}
        <button type="button" className="wizard-card" onClick={onOpenGallery}>
          <span className="wizard-assist-art" aria-hidden="true">
            🗂
          </span>
          <span className="wizard-card-title">{t.wizardGalleryButton}</span>
          <small>{t.wizardGalleryDesc}</small>
        </button>
      </div>
    </div>
  );

  /** Wizard step: surface, canvas size, and scroll-vs-slides. */
  const formatStep = (
    <div className="wizard-body">
      <p>{t.wizardFormatLead}</p>
      <span className="wizard-group-label">{t.wizardSurfaceLabel}</span>
      <div className="wizard-surface-row">
        {(["app", "tui"] as const).map((surface) => (
          <button
            type="button"
            key={surface}
            className={`wizard-card${project.surface === surface ? " is-active" : ""}`}
            onClick={() => setProject((current) => ({ ...current, surface }))}
          >
            <span className={`surface-art surface-art-${surface}`} aria-hidden="true">
              {surface === "app" ? <SurfaceArtApp /> : <SurfaceArtTui />}
            </span>
            <span className="wizard-card-title">
              {surface === "app" ? t.surfaceApp : t.surfaceTui}
            </span>
            <small>{surface === "app" ? t.wizardSurfaceApp : t.wizardSurfaceTui}</small>
          </button>
        ))}
      </div>
      <span className="wizard-group-label">{t.wizardCanvasLabel}</span>
      <div className="wizard-size-row">
        {SIZE_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`wizard-card is-size${
              project.appearance.canvasWidth === preset.width &&
              project.appearance.canvasHeight === preset.height
                ? " is-active"
                : ""
            }`}
            onClick={() =>
              setProject((current) => ({
                ...current,
                appearance: {
                  ...current.appearance,
                  canvasWidth: preset.width,
                  canvasHeight: preset.height,
                },
              }))
            }
          >
            <span className="size-art" aria-hidden="true">
              <i
                style={{
                  aspectRatio: `${preset.width} / ${preset.height}`,
                  ...(preset.width / preset.height >= 1.2 ? { width: 44 } : { height: 32 }),
                }}
              />
            </span>
            <span className="wizard-card-title">{preset.label}</span>
            <small>
              {preset.width}×{preset.height}
            </small>
            <small className="size-hint">{preset.hint[lang]}</small>
          </button>
        ))}
      </div>
      <span className="wizard-group-label">{t.wizardMarginLabel}</span>
      <div className="chip-row" role="group" aria-label={t.wizardMarginLabel}>
        {(
          [
            [0, t.wizardMarginNone],
            [36, t.wizardMarginTight],
            [64, t.wizardMarginStandard],
            [104, t.wizardMarginWide],
          ] as const
        ).map(([margin, label]) => (
          <button
            type="button"
            key={margin}
            className={project.appearance.windowMargin === margin ? "is-active" : ""}
            onClick={() => updateAppearance("windowMargin", margin)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="wizard-flow-row">
        {(["scroll", "slides"] as const).map((flow) => (
          <button
            type="button"
            key={flow}
            className={`wizard-card${project.pagination.flow === flow ? " is-active" : ""}`}
            onClick={() => {
              setProject((current) => ({
                ...current,
                pagination: { ...current.pagination, flow },
              }));
              onPageChange(0);
            }}
          >
            <span className={`flow-art flow-art-${flow}`} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="wizard-card-title">
              {flow === "scroll" ? t.wizardFlowScrollTitle : t.wizardFlowSlidesTitle}
            </span>
            <small>{flow === "scroll" ? t.wizardFlowScroll : t.wizardFlowSlides}</small>
          </button>
        ))}
      </div>
      {project.pagination.flow === "slides" ? (
        <>
          <span className="wizard-group-label">{t.wizardPerPageLabel}</span>
          <div className="chip-row">
            {[2, 3, 4, 5, 6].map((count) => (
              <button
                type="button"
                key={count}
                className={project.pagination.messagesPerPage === count ? "is-active" : ""}
                onClick={() => {
                  setProject((current) => ({
                    ...current,
                    pagination: { ...current.pagination, messagesPerPage: count },
                  }));
                  onPageChange(0);
                }}
              >
                {count}
              </button>
            ))}
          </div>
          <small>{t.wizardPerPageHint(pageCount)}</small>
        </>
      ) : null}
    </div>
  );

  /** Wizard step: colors, backdrop, and the window's glass. */
  const lookStep = (
    <div className="wizard-body">
      <p>{t.wizardLookLead}</p>
      <span className="wizard-group-label">{t.wizardColorsLabel}</span>
      <ThemePresetGrid project={project} setProject={setProject} className="wizard-theme-grid" />
      <span className="wizard-group-label">{t.wizardBackdropLabel}</span>
      <BackdropChips project={project} setProject={setProject} t={t} />
      <span className="wizard-group-label">{t.wizardGlassLabel}</span>
      <div className="chip-row" role="group" aria-label={t.wizardGlassLabel}>
        {(
          [
            ["solid", 1, t.wizardGlassSolid],
            ["frosted", 0.86, t.wizardGlassFrosted],
            ["glass", 0.7, t.wizardGlassGlass],
            ["clear", 0.55, t.wizardGlassClear],
          ] as const
        ).map(([id, opacity, label]) => (
          <button
            type="button"
            key={id}
            className={
              Math.abs(project.appearance.terminalOpacity - opacity) < 0.02 ? "is-active" : ""
            }
            onClick={() => updateAppearance("terminalOpacity", opacity)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  /** Wizard step: text size and the pacing presets. */
  const sizeStep = (
    <div className="wizard-body">
      <p>{t.wizardSizeLead}</p>
      <span className="wizard-group-label">{t.wizardTextLabel}</span>
      <div className="wizard-surface-row">
        {DISPLAY_PRESETS.filter((preset) =>
          ["reset", "large-text", "huge-text"].includes(preset.id),
        ).map((preset) => (
          <button
            type="button"
            key={preset.id}
            className="wizard-card"
            onClick={() => applyDisplayPreset(preset.apply)}
          >
            <PresetSkeleton
              fontScale={preset.apply.fontScale ?? project.appearance.fontScale}
              display={preset.apply.display ?? project.display}
            />
            <span className="wizard-card-title">{preset.label[lang]}</span>
            <small>{preset.description[lang]}</small>
          </button>
        ))}
      </div>
      <span className="wizard-group-label">{t.wizardChromeLabel}</span>
      <div className="chip-row" role="group" aria-label={t.wizardChromeLabel}>
        {(["header", "composer", "footer"] as const).map((key) => (
          <button
            type="button"
            key={key}
            className={project.display[key] ? "is-active" : ""}
            onClick={() =>
              setProject((current) => ({
                ...current,
                display: { ...current.display, [key]: !current.display[key] },
              }))
            }
          >
            {key === "header"
              ? t.groupHeader
              : key === "composer"
                ? t.displayComposer
                : t.displayFooter}
          </button>
        ))}
      </div>
      <small>{t.wizardChromeNote}</small>
    </div>
  );

  /** Wizard step: how the typing and the agent move. */
  const motionStep = (
    <div className="wizard-body">
      <p>{t.wizardMotionLead}</p>
      <span className="wizard-group-label">{t.wizardInputLabel}</span>
      {/* Said here rather than at the checkbox that causes it: this is the
          screen where the choice stops mattering. */}
      {project.display.composer ? null : <small>{t.wizardInputNoComposerNote}</small>}
      <div className="wizard-surface-row">
        {USER_INPUT_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`wizard-card${
              isTimingPresetActive(preset, project.timing) ? " is-active" : ""
            }`}
            onClick={() =>
              setProject((current) => ({
                ...current,
                timing: { ...current.timing, ...preset.apply },
              }))
            }
          >
            <span className="wizard-card-title">{preset.label[lang]}</span>
            <small>{preset.description[lang]}</small>
          </button>
        ))}
      </div>
      <span className="wizard-group-label">{t.wizardMotionLabel}</span>
      <div className="wizard-surface-row">
        {AGENT_BEHAVIOR_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`wizard-card${
              isTimingPresetActive(preset, project.timing) ? " is-active" : ""
            }`}
            onClick={() =>
              setProject((current) => ({
                ...current,
                timing: { ...current.timing, ...preset.apply },
              }))
            }
          >
            <span className="wizard-card-title">{preset.label[lang]}</span>
            <small>{preset.description[lang]}</small>
          </button>
        ))}
      </div>
      <span className="wizard-group-label">{t.wizardCameraLabel}</span>
      <div className="chip-row" role="group" aria-label={t.wizardCameraLabel}>
        <button
          type="button"
          className={project.camera.follow ? "" : "is-active"}
          onClick={() => turnCameraOff(setProject)}
        >
          {t.cameraOff}
        </button>
        <button
          type="button"
          className={project.camera.follow ? "is-active" : ""}
          onClick={() =>
            // The guide keeps it simple: follow lands in the "sync" style;
            // the other landing grammars stay a Motion-tab choice.
            setProject((current) => ({
              ...current,
              camera: { ...current.camera, follow: true, style: "sync" },
            }))
          }
        >
          {t.cameraFollow}
        </button>
      </div>
      <small>{t.wizardCameraNote}</small>
    </div>
  );

  /** Wizard step: rewrite the chosen script's text in your own words. */
  const editStep = (
    <div className="wizard-body">
      <p>{t.wizardEditLead}</p>
      {appliedPresetLabel !== null ? (
        <p className="wizard-preset-applied" role="status">
          {t.wizardPresetApplied(appliedPresetLabel)}
        </p>
      ) : null}
      {/* Text only: roles, order, and inserts stay the editor's job. Focus
          reuses the sidebar's pin, so the canvas freezes on the message
          being typed into and shows every keystroke in place. */}
      <div className="wizard-edit-list">
        {project.messages.map((message, index) => (
          <label key={message.id} className="wizard-edit-item">
            <span className="wizard-edit-meta">
              {String(index + 1).padStart(2, "0")} · {ROLE_LABELS[message.role]}
            </span>
            <textarea
              value={message.content}
              maxLength={MAX_MESSAGE_CHARS + 1}
              rows={message.role === "assistant" ? 5 : 2}
              aria-label={t.messageContentAria(index + 1)}
              onChange={(event) =>
                updateMessage(message.id, { content: event.currentTarget.value })
              }
              onFocus={() => onMessageFocus(message.id)}
              onBlur={() => onMessageBlur(message.id)}
            />
          </label>
        ))}
      </div>
      <div className="wizard-export-actions">
        <button type="button" onClick={onOpenEditor}>
          {t.wizardEditOpenEditor}
        </button>
      </div>
      <small>{t.wizardFinishNote}</small>
    </div>
  );

  /** Wizard step: pick a format and download. */
  const exportStep = (
    <div className="wizard-body">
      <p>{t.wizardExportLead}</p>
      <CameraOffRamp
        follow={project.camera.follow}
        t={t}
        onTurnOff={() => turnCameraOff(setProject)}
      />
      {/* The simple path keeps stills and the cheap animated SVG. Raster
      motion lives behind More options, where device preflight is visible. */}
      <ExportFormatGroups kind={exportKind} onKindChange={setExportKind} t={t} mode="simple" />
      <ExportRunButton
        disabled={exportRunDisabled({
          kind: exportKind,
          engineReady,
          busy: pendingExport !== null,
          issueCount: issues.length,
          entryBlocked: !isSimpleExportChoice(exportKind),
        })}
        running={pendingExport !== null}
        t={t}
        // The wizard has no scope control, so a split script always
        // downloads the whole deck — never a silent single slide.
        onRun={onRunExport}
      />
      <ExportProgressRow
        pendingExport={pendingExport}
        exportProgress={exportProgress}
        exportEta={exportEta}
        exportElapsed={exportElapsed}
        onAbort={onAbortExport}
        t={t}
      />
      <ExportResultsBlock
        urls={exportUrls}
        results={pendingExport === null ? exportResult : null}
        t={t}
      />
      <div className="wizard-export-actions">
        <button type="button" onClick={onMoreFormats}>
          {t.wizardMoreFormats}
        </button>
      </div>
      <small>{t.wizardFinishNote}</small>
    </div>
  );

  /** The body for the step the wizard is on. */
  const stepBody = (() => {
    switch (step) {
      case WIZARD_SCRIPT_STEP:
        return scriptStep;
      case WIZARD_EDIT_STEP:
        return editStep;
      case 0:
        return formatStep;
      case 1:
        return lookStep;
      case 2:
        return sizeStep;
      case 3:
        return motionStep;
      default:
        return exportStep;
    }
  })();

  return (
    <div className={`wizard-overlay${closing ? " is-closing" : ""}`}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close mirrors dialog::backdrop behavior; Escape handles keyboards */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape key closes via the window listener */}
      <div className="wizard-backdrop" onClick={onClose} />
      <div className="wizard-panel" role="dialog" aria-label={t.wizardTitle}>
        <header className="wizard-head">
          <strong>{t.wizardTitle}</strong>
          <span className="wizard-steps">
            {[
              t.wizardStepFormat,
              t.wizardStepLook,
              t.wizardStepSize,
              t.wizardStepMotion,
              t.wizardStepScript,
              t.wizardStepEdit,
              t.wizardStepExport,
              // Indexed rather than keyed by label: two steps may legitimately
              // read the same in a language, and a duplicate key drops one.
            ].map((label, index) => (
              <span key={`${index}-${label}`} className={index === step ? "is-active" : ""}>
                {index + 1}. {label}
              </span>
            ))}
          </span>
          <button
            type="button"
            className="export-close"
            aria-label={t.wizardClose}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        <div className="wizard-columns">
          <div className="wizard-stage-column">
            <div className="wizard-stage-slot" ref={slotRef} />
            {pageCount > 1 ? (
              <div className="wizard-pager">
                <button
                  type="button"
                  aria-label={t.wizardSlidePager(pageIndex + 1, pageCount)}
                  disabled={pageIndex === 0}
                  onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
                >
                  <ArrowIcon direction="left" />
                </button>
                <span className="wizard-pager-dots">
                  {Array.from({ length: pageCount }, (_unused, page) => (
                    <button
                      type="button"
                      // biome-ignore lint/suspicious/noArrayIndexKey: pages are positional by definition
                      key={page}
                      className={page === pageIndex ? "is-active" : ""}
                      aria-label={t.wizardSlidePager(page + 1, pageCount)}
                      onClick={() => onPageChange(page)}
                    />
                  ))}
                </span>
                <button
                  type="button"
                  aria-label={t.wizardSlidePager(pageIndex + 1, pageCount)}
                  disabled={pageIndex >= pageCount - 1}
                  onClick={() => onPageChange(Math.min(pageCount - 1, pageIndex + 1))}
                >
                  <ArrowIcon direction="right" />
                </button>
                <span className="wizard-pager-count">
                  {pageIndex + 1} / {pageCount}
                </span>
              </div>
            ) : null}
          </div>
          <div className="wizard-content" ref={bodyRef}>
            {stepBody}
            <div className="wizard-actions">
              {step !== null && step > 0 ? (
                <button type="button" onClick={() => onStepChange((step ?? 1) - 1)}>
                  {t.wizardBack}
                </button>
              ) : (
                <span />
              )}
              {step !== null && step < WIZARD_EXPORT_STEP ? (
                <button
                  type="button"
                  className="is-primary"
                  onClick={() => onStepChange((step ?? 0) + 1)}
                >
                  {t.wizardNext}
                </button>
              ) : (
                <button type="button" className="is-primary" onClick={onClose}>
                  {t.wizardFinish}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
