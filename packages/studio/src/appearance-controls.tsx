/**
 * Appearance controls the Style tab and the wizard both offer. They are
 * the same decision in two places, so they render from one definition —
 * a preset that lit up in the guide has to look applied in the panel.
 */

import {
  BACKDROP_PRESETS,
  type SvgentProject,
  THEME_PRESETS,
  type TimingPreset,
  type TimingSettings,
} from "@svgent/scene";
import type React from "react";
import type { UiStrings } from "./i18n.js";

/** Whether the project's timing already matches everything a preset declares. */
export function isTimingPresetActive(preset: TimingPreset, timing: TimingSettings): boolean {
  return (Object.keys(preset.apply) as Array<keyof TimingSettings>).every(
    (key) => timing[key] === preset.apply[key],
  );
}

/** Turn the follow camera off — the off-ramp's action, in one place. */
export function turnCameraOff(
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>,
): void {
  setProject((current) => ({
    ...current,
    camera: { ...current.camera, follow: false },
  }));
}

/** A theme is three colors at once; the swatch previews all three. */
export function ThemePresetGrid({
  project,
  setProject,
  className,
  ariaLabel,
}: {
  project: SvgentProject;
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>;
  /** The wizard grid carries an extra class for its own sizing. */
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      className={`theme-preset-grid${className ? ` ${className}` : ""}`}
      role="group"
      {...(ariaLabel ? { "aria-label": ariaLabel } : {})}
    >
      {THEME_PRESETS.map((preset) => (
        <button
          type="button"
          key={preset.id}
          className={project.appearance.theme === preset.id ? "is-active" : ""}
          onClick={() =>
            setProject((current) => ({
              ...current,
              appearance: {
                ...current.appearance,
                theme: preset.id,
                background: preset.background,
                accent: preset.accent,
                userBubbleColor: preset.user,
              },
            }))
          }
        >
          <span
            className="theme-swatch"
            style={{ background: preset.background, borderColor: preset.accent }}
          >
            <i style={{ background: preset.accent }} />
          </span>
          {preset.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Backdrop presets plus the transparent option. Picking a preset drops
 * any uploaded backdrop image in the same update — two writes would let
 * a render land between them with the image still on the old backdrop.
 */
export function BackdropChips({
  project,
  setProject,
  t,
}: {
  project: SvgentProject;
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>;
  t: UiStrings;
}) {
  return (
    <div className="chip-row" role="group" aria-label={t.wizardBackdropLabel}>
      {BACKDROP_PRESETS.map((preset) => (
        <button
          type="button"
          key={preset.id}
          className={
            project.appearance.backdrop === preset.id &&
            !project.appearance.backdropImage &&
            !project.appearance.transparentCanvas
              ? "is-active"
              : ""
          }
          onClick={() =>
            setProject((current) => {
              const { backdropImage: _dropped, ...appearance } = current.appearance;
              return {
                ...current,
                appearance: {
                  ...appearance,
                  backdrop: preset.id,
                  transparentCanvas: false,
                },
              };
            })
          }
        >
          {preset.label}
        </button>
      ))}
      <button
        type="button"
        className={project.appearance.transparentCanvas ? "is-active" : ""}
        data-tip={t.transparentHelp}
        onClick={() =>
          setProject((current) => ({
            ...current,
            appearance: { ...current.appearance, transparentCanvas: true },
          }))
        }
      >
        {t.backdropTransparent}
      </button>
    </div>
  );
}
