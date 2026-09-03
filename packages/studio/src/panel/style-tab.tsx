/**
 * Style tab: canvas layout, display presets and sizing, colors and
 * backdrop, and the font slots. The font-source state is Studio's own
 * (uploads are tab-local Data URLs), so it arrives as props rather than
 * living in the project.
 */

import {
  DISPLAY_PRESETS,
  type DisplaySettings,
  type FontChoice,
  type FontSlot,
  GOOGLE_FONT_SUGGESTIONS,
  normalizeGoogleFontFamily,
  SIZE_PRESETS,
  type SvgentProject,
} from "@svgent/scene";
import type React from "react";
import { BackdropChips, ThemePresetGrid } from "../appearance-controls.js";
import { ColorField, NumberField, RangeField, SegmentedField, TextField } from "../fields.js";
import type { UploadedFonts } from "../fonts.js";
import type { Lang, UiStrings } from "../i18n.js";
import { ExternalIcon, UploadIcon } from "../icons.js";
import { IMAGE_ACCEPT } from "../images.js";
import { fontUploadId, googleFontListId } from "../instance.js";
import type { useProjectActions } from "../project-actions.js";
import { HintTip, PresetSkeleton, ResetSection } from "../widgets.js";

export function StyleTab({
  instance,
  project,
  setProject,
  actions,
  uploadedFonts,
  fontError,
  onChooseFontSource,
  onAttachFontFile,
  onResetAppearance,
  lang,
  t,
}: {
  /**
   * The owning studio's identity. A DOM id belongs to the whole document, so
   * two studios sharing a page would otherwise both claim these — and the
   * second studio's upload button would open the first one's file picker.
   */
  instance: string;
  project: SvgentProject;
  /** Confirms first, then clears — the dialog lives with the other resets. */
  onResetAppearance: () => void;
  /** Theme presets patch three appearance fields at once. */
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>;
  actions: Pick<
    ReturnType<typeof useProjectActions>,
    | "updateAppearance"
    | "updateFontChoice"
    | "updatePagination"
    | "applyDisplayPreset"
    | "attachBackdrop"
    | "removeBackdropImage"
  >;
  uploadedFonts: UploadedFonts;
  fontError: string | null;
  onChooseFontSource: (slot: FontSlot, source: FontChoice["source"], choice: FontChoice) => void;
  onAttachFontFile: (slot: FontSlot, file: File) => void;
  lang: Lang;
  t: UiStrings;
}) {
  const {
    updateAppearance,
    updateFontChoice,
    updatePagination,
    applyDisplayPreset,
    attachBackdrop,
    removeBackdropImage,
  } = actions;

  /** One font row: bundled / Google / upload chips plus the slot's own controls. */
  const fontSlotField = (slot: FontSlot): React.ReactNode => {
    const choice = project.fonts[slot];
    return (
      <div className="field font-slot" key={slot}>
        <span>{slot === "sans" ? t.fontSans : t.fontMono}</span>
        <div className="chip-row" role="group">
          {(
            [
              ["bundled", t.fontBundled],
              ["google", "Google Fonts"],
              ["upload", t.fontUploadLabel],
            ] as const
          ).map(([source, label]) => (
            <button
              type="button"
              key={source}
              className={choice.source === source ? "is-active" : ""}
              onClick={() => onChooseFontSource(slot, source, choice)}
            >
              {label}
            </button>
          ))}
        </div>
        {choice.source === "google" ? (
          <div className="family-row">
            <TextField
              label={t.fontFamilyLabel}
              value={choice.family}
              onChange={(family) =>
                updateFontChoice(slot, {
                  source: "google",
                  family: normalizeGoogleFontFamily(family),
                })
              }
              maxLength={120}
              list={googleFontListId(instance)}
            />
            {choice.family.length > 0 ? (
              <button
                type="button"
                className="font-clear-button"
                onClick={() => updateFontChoice(slot, { source: "google", family: "" })}
                aria-label={t.fontClear}
                data-tip={t.fontClear}
              >
                ×
              </button>
            ) : null}
            <a
              className="font-browse-link"
              href={`https://fonts.google.com/?query=${encodeURIComponent(choice.family)}`}
              target="_blank"
              rel="noreferrer"
              data-tip={t.fontBrowseTitle}
              aria-label={t.fontBrowseTitle}
            >
              <ExternalIcon />
            </a>
          </div>
        ) : null}
        {choice.source === "upload" ? (
          <small>{uploadedFonts[slot]?.fileName ?? t.fontUploadPrompt}</small>
        ) : null}
        <label className="font-upload-input">
          <input
            id={fontUploadId(instance, slot)}
            type="file"
            accept=".woff2,.woff,.ttf,.otf"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) {
                onAttachFontFile(slot, file);
              }
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
    );
  };

  return (
    <div className="field-stack">
      <h3 className="group-title">
        {t.groupLayout} <HintTip text={t.tipCanvasSize} />
      </h3>
      <div className="chip-row" role="group" aria-label={t.wizardCanvasLabel}>
        {SIZE_PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={
              project.appearance.canvasWidth === preset.width &&
              project.appearance.canvasHeight === preset.height
                ? "is-active"
                : ""
            }
            data-tip={`${preset.width}×${preset.height} · ${preset.hint[lang]}`}
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
            {preset.label}
          </button>
        ))}
      </div>
      <div className="two-column-fields">
        <NumberField
          label={t.fieldWidth}
          value={project.appearance.canvasWidth}
          min={640}
          max={2560}
          onChange={(value) => updateAppearance("canvasWidth", value)}
        />
        <NumberField
          label={t.fieldHeight}
          value={project.appearance.canvasHeight}
          min={480}
          max={2560}
          onChange={(value) => updateAppearance("canvasHeight", value)}
        />
      </div>
      <RangeField
        label={t.windowMarginLabel}
        value={project.appearance.windowMargin}
        min={0}
        max={140}
        step={2}
        unit="px"
        onChange={(value) => updateAppearance("windowMargin", value)}
      />
      {/* The pair to the margin above: outside the window, then inside it. */}
      <div className="two-column-fields">
        <RangeField
          label={t.windowPaddingXLabel}
          value={project.appearance.windowPaddingX}
          min={0}
          max={80}
          step={2}
          unit="px"
          onChange={(value) => updateAppearance("windowPaddingX", value)}
        />
        <RangeField
          label={t.windowPaddingYLabel}
          value={project.appearance.windowPaddingY}
          min={0}
          max={80}
          step={2}
          unit="px"
          onChange={(value) => updateAppearance("windowPaddingY", value)}
        />
      </div>
      {/* Also lives in the desktop quick bar; the phone hides that bar, so
          the layout group is the toggle's permanent home. */}
      <SegmentedField
        className="flow-field"
        label={t.fieldFlow}
        value={project.pagination.flow}
        options={[
          { value: "scroll", label: t.flowScroll },
          { value: "slides", label: t.flowPages },
        ]}
        onChange={(flow) => updatePagination("flow", flow)}
      />
      {project.pagination.flow === "scroll" ? (
        <RangeField
          label={t.fieldScrollLimit}
          hint={t.scrollLimitHint}
          value={project.pagination.scrollDistancePx}
          min={0}
          max={2400}
          step={20}
          unit="px"
          onChange={(value) => updatePagination("scrollDistancePx", value)}
        />
      ) : (
        <RangeField
          label={t.fieldPerSlide}
          value={project.pagination.messagesPerPage}
          min={1}
          max={6}
          step={1}
          unit={t.unitMessages}
          onChange={(value) => updatePagination("messagesPerPage", value)}
        />
      )}
      <h3 className="group-title">{t.groupDisplay}</h3>
      <div className="display-preset-grid" role="group" aria-label={t.displayPresetsAria}>
        {DISPLAY_PRESETS.map((preset) => {
          // Undeclared fields keep their current values, so the
          // skeleton previews the outcome of clicking, not a fixed
          // template.
          const outcome = {
            fontScale: preset.apply.fontScale ?? project.appearance.fontScale,
            chromeScale: preset.apply.chromeScale ?? project.appearance.chromeScale,
            display: preset.apply.display ?? project.display,
          };
          const active =
            project.appearance.fontScale === outcome.fontScale &&
            project.appearance.chromeScale === outcome.chromeScale &&
            (Object.keys(outcome.display) as Array<keyof DisplaySettings>).every(
              (key) => project.display[key] === outcome.display[key],
            );
          return (
            <button
              type="button"
              key={preset.id}
              className={`preset-card tip-anchor${active ? " is-active" : ""}`}
              data-tip={preset.description[lang]}
              onClick={() => applyDisplayPreset(preset.apply)}
            >
              <PresetSkeleton fontScale={outcome.fontScale} display={outcome.display} />
              <span className="preset-card-label">{preset.label[lang]}</span>
            </button>
          );
        })}
      </div>
      <RangeField
        label={t.fieldFontSize}
        value={project.appearance.fontScale}
        min={0.8}
        max={5}
        step={0.05}
        unit="×"
        onChange={(value) => updateAppearance("fontScale", value)}
      />
      <RangeField
        label={t.fieldChromeSize}
        value={project.appearance.chromeScale}
        min={0.8}
        max={3}
        step={0.05}
        unit="×"
        onChange={(value) => updateAppearance("chromeScale", value)}
      />
      <RangeField
        label={t.fieldSpacing}
        value={project.appearance.spacingScale}
        min={0.6}
        max={1.6}
        step={0.05}
        unit="×"
        onChange={(value) => updateAppearance("spacingScale", value)}
      />
      <SegmentedField
        label={t.fieldContentAlign}
        value={project.appearance.contentAlign}
        options={[
          { value: "start", label: t.contentAlignStart },
          { value: "center", label: t.contentAlignCenter },
        ]}
        onChange={(value) => updateAppearance("contentAlign", value)}
        {...(project.surface === "tui" ? { hint: t.contentAlignTuiHint } : {})}
      />
      {/* Both of these describe how an app-surface message card looks; the
      terminal has neither a bubble nor a slab to place. */}
      {project.surface === "app" ? (
        <SegmentedField
          label={t.fieldAssistantSurface}
          value={project.appearance.assistantSurface}
          options={[
            { value: "card", label: t.assistantSurfaceCard },
            { value: "plain", label: t.assistantSurfacePlain },
          ]}
          onChange={(value) => updateAppearance("assistantSurface", value)}
        />
      ) : null}
      {project.surface === "app" ? (
        <SegmentedField
          label={t.fieldMessageAlign}
          value={project.appearance.messageAlign}
          options={[
            { value: "role", label: t.messageAlignRole },
            { value: "center", label: t.messageAlignCenter },
          ]}
          onChange={(value) => updateAppearance("messageAlign", value)}
        />
      ) : null}
      <small className="display-note">{t.displayPresetNote}</small>
      <h3 className="group-title">{t.groupColors}</h3>
      <ThemePresetGrid project={project} setProject={setProject} ariaLabel={t.groupColors} />
      <div className="two-column-fields">
        <ColorField
          label={t.fieldBackground}
          value={project.appearance.background}
          onChange={(value) => updateAppearance("background", value)}
        />
        <ColorField
          label={t.fieldAccent}
          value={project.appearance.accent}
          onChange={(value) => updateAppearance("accent", value)}
        />
      </div>
      <ColorField
        label={t.fieldUserBubble}
        value={project.appearance.userBubbleColor}
        onChange={(value) => updateAppearance("userBubbleColor", value)}
      />
      <div className="field">
        <span>
          {t.wizardBackdropLabel} <HintTip text={t.tipBackdrop} />
        </span>
        <BackdropChips project={project} setProject={setProject} t={t} />
        <div className="backdrop-upload-row">
          <label className="script-io-import">
            <UploadIcon /> {t.backdropUpload}
            <input
              type="file"
              accept={IMAGE_ACCEPT}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) {
                  void attachBackdrop(file);
                }
                event.currentTarget.value = "";
              }}
            />
          </label>
          {project.appearance.backdropImage ? (
            <span className="backdrop-image-chip">
              <img
                src={project.appearance.backdropImage.dataUrl}
                alt={project.appearance.backdropImage.alt}
              />
              <button
                type="button"
                aria-label={t.backdropRemove}
                data-tip={t.backdropRemove}
                onClick={removeBackdropImage}
              >
                ✕
              </button>
            </span>
          ) : null}
        </div>
        <small className="range-hint">{t.backdropUploadHint}</small>
      </div>
      <SegmentedField
        label={t.imageSkeletonLabel}
        value={project.appearance.imageSkeleton}
        options={[
          { value: "dots", label: t.imageSkeletonDots },
          { value: "sweep", label: t.imageSkeletonSweep },
          { value: "tiles", label: t.imageSkeletonTiles },
        ]}
        onChange={(value) => updateAppearance("imageSkeleton", value)}
      />
      <RangeField
        label={t.fieldShadow}
        value={project.appearance.shadowStrength}
        min={0}
        max={1}
        step={0.05}
        unit=""
        onChange={(value) => updateAppearance("shadowStrength", value)}
      />
      <RangeField
        label={t.fieldPanelOpacity}
        value={project.appearance.terminalOpacity}
        min={0.45}
        max={1}
        step={0.01}
        unit=""
        onChange={(value) => updateAppearance("terminalOpacity", value)}
      />
      <h3 className="group-title">{t.fontsGroup}</h3>
      {(["sans", "mono"] as FontSlot[]).map((slot) => fontSlotField(slot))}
      {fontError ? (
        <div className="import-warnings" role="alert">
          <p>• {fontError}</p>
        </div>
      ) : null}
      <datalist id={googleFontListId(instance)}>
        {GOOGLE_FONT_SUGGESTIONS.map((family) => (
          <option key={family} value={family} />
        ))}
      </datalist>
      <p className="panel-note">{t.fontNote}</p>
      <ResetSection
        label={t.resetAppearance}
        note={t.resetAppearanceNote}
        onReset={onResetAppearance}
      />
    </div>
  );
}
