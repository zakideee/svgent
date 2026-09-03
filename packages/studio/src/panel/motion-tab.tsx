/**
 * Motion tab: the follow camera, the timing presets, and the per-step
 * duration ranges that add up to the scene's total length.
 */

import {
  AGENT_BEHAVIOR_PRESETS,
  CAMERA_MIN_SHOT_PRESET_MS,
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_MIN,
  SCENE_PACING_PRESETS,
  type SvgentProject,
  type TimingPreset,
  USER_INPUT_PRESETS,
} from "@svgent/scene";
import type React from "react";
import { isTimingPresetActive } from "../appearance-controls.js";
import { RangeField, SegmentedField } from "../fields.js";
import type { Lang, UiStrings } from "../i18n.js";
import { formatDuration } from "../playback.js";
import type { useProjectActions } from "../project-actions.js";
import { HintTip, ResetSection } from "../widgets.js";

export function MotionTab({
  project,
  setProject,
  actions,
  durationMs,
  onResetMotion,
  lang,
  t,
}: {
  project: SvgentProject;
  /** Confirms first, then clears — the dialog lives with the other resets. */
  onResetMotion: () => void;
  /** Camera and preset edits patch nested groups wholesale. */
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>;
  actions: Pick<ReturnType<typeof useProjectActions>, "updateTiming">;
  /** The built scene's total length, shown in the timing group heading. */
  durationMs: number;
  lang: Lang;
  t: UiStrings;
}) {
  const { updateTiming } = actions;
  return (
    <div className="field-stack">
      <h3 className="group-title">{t.groupCamera}</h3>
      <SegmentedField
        label={t.cameraModeLabel}
        value={project.camera.follow ? "follow" : "off"}
        options={[
          { value: "off", label: t.cameraOff },
          { value: "follow", label: t.cameraFollow },
        ]}
        onChange={(value) =>
          setProject((current) => ({
            ...current,
            camera: { ...current.camera, follow: value === "follow" },
          }))
        }
        hint={t.cameraHint}
      />
      {project.camera.follow ? (
        <SegmentedField
          label={t.cameraStyleLabel}
          value={project.camera.style}
          options={[
            { value: "anticipate", label: t.cameraStyleAnticipate },
            { value: "sync", label: t.cameraStyleSync },
            { value: "trail", label: t.cameraStyleTrail },
          ]}
          onChange={(style) =>
            setProject((current) => ({
              ...current,
              camera: { ...current.camera, style },
            }))
          }
          hint={t.cameraStyleHint}
        />
      ) : null}
      {project.camera.follow ? (
        <SegmentedField
          label={t.cameraBriefLabel}
          value={project.camera.minShotMs > 0 ? "suppress" : "keep"}
          options={[
            { value: "keep", label: t.cameraBriefKeep },
            { value: "suppress", label: t.cameraBriefSuppress },
          ]}
          onChange={(value) =>
            setProject((current) => ({
              ...current,
              camera: {
                ...current.camera,
                minShotMs: value === "suppress" ? CAMERA_MIN_SHOT_PRESET_MS : 0,
              },
            }))
          }
          hint={t.cameraBriefHint}
        />
      ) : null}
      {project.camera.follow ? (
        <RangeField
          label={t.cameraZoomLabel}
          value={project.camera.zoom}
          min={CAMERA_ZOOM_MIN}
          max={CAMERA_ZOOM_MAX}
          step={0.05}
          unit="×"
          commitOn="release"
          onChange={(value) =>
            setProject((current) => ({
              ...current,
              camera: { ...current.camera, zoom: value },
            }))
          }
        />
      ) : null}
      <h3 className="group-title">{t.groupTiming(formatDuration(durationMs))}</h3>
      {(
        [
          [t.presetGroupUserInput, USER_INPUT_PRESETS],
          [t.presetGroupAgent, AGENT_BEHAVIOR_PRESETS],
          [t.presetGroupPacing, SCENE_PACING_PRESETS],
        ] as Array<[string, TimingPreset[]]>
      ).map(([groupLabel, presets]) => (
        <div className="field timing-preset-field" key={groupLabel}>
          <span>{groupLabel}</span>
          <div className="chip-row" role="group" aria-label={groupLabel}>
            {presets.map((preset) => {
              const active = isTimingPresetActive(preset, project.timing);
              return (
                <button
                  type="button"
                  key={preset.id}
                  className={`tip-anchor${active ? " is-active" : ""}`}
                  data-tip={preset.description[lang]}
                  onClick={() =>
                    setProject((current) => ({
                      ...current,
                      timing: { ...current.timing, ...preset.apply },
                    }))
                  }
                >
                  {preset.label[lang]}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <RangeField
        label={t.fieldUserTyping}
        value={project.timing.userTypingCps}
        min={6}
        max={60}
        step={1}
        unit="cps"
        commitOn="release"
        onChange={(value) => updateTiming("userTypingCps", value)}
      />
      <RangeField
        label={t.fieldAgentResponse}
        value={project.timing.agentTypingCps}
        min={8}
        max={300}
        step={1}
        unit="cps"
        hint={
          <>
            {t.tokenRate(
              Math.round(project.timing.agentTypingCps),
              Math.max(1, Math.round(project.timing.agentTypingCps / 4)),
            )}{" "}
            <HintTip text={t.tipTokenRate} />
          </>
        }
        commitOn="release"
        onChange={(value) => updateTiming("agentTypingCps", value)}
      />
      <RangeField
        label={t.fieldReaction}
        value={project.timing.reactionMs}
        min={0}
        max={3_000}
        step={10}
        unit="ms"
        hint={t.reactionHint}
        commitOn="release"
        onChange={(value) => updateTiming("reactionMs", value)}
      />
      <RangeField
        label={t.fieldThinking}
        value={project.timing.thinkingMs}
        min={400}
        max={8_000}
        step={100}
        unit="ms"
        commitOn="release"
        onChange={(value) => updateTiming("thinkingMs", value)}
      />
      <RangeField
        label={t.fieldToolRun}
        value={project.timing.toolRunMs}
        min={300}
        max={6_000}
        step={100}
        unit="ms"
        commitOn="release"
        onChange={(value) => updateTiming("toolRunMs", value)}
      />
      <RangeField
        label={t.fieldImageGen}
        value={project.timing.imageGenMs}
        min={800}
        max={20_000}
        step={200}
        unit="ms"
        commitOn="release"
        onChange={(value) => updateTiming("imageGenMs", value)}
      />
      <RangeField
        label={t.fieldPermission}
        value={project.timing.permissionMs}
        min={500}
        max={6_000}
        step={100}
        unit="ms"
        commitOn="release"
        onChange={(value) => updateTiming("permissionMs", value)}
      />
      <RangeField
        label={t.fieldFinalHold}
        value={project.timing.finalHoldMs}
        min={500}
        max={6_000}
        step={100}
        unit="ms"
        commitOn="release"
        onChange={(value) => updateTiming("finalHoldMs", value)}
      />
      <ResetSection label={t.resetMotion} note={t.resetMotionNote} onReset={onResetMotion} />
    </div>
  );
}
