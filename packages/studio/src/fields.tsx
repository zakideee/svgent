/** Label-beside-control form fields used throughout the settings panel. */

import type React from "react";
import { useState } from "react";

export function TextField({
  label,
  value,
  onChange,
  issue,
  maxLength,
  list,
  onFocus,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  issue?: string | null;
  maxLength?: number;
  list?: string;
  /** Fires on focus — used to flash the matching element in the preview. */
  onFocus?: () => void;
  /** Extra hook class, e.g. for cross-tab jump targets. */
  className?: string;
}) {
  return (
    <label
      className={`field text-field ${issue ? "has-issue" : ""}${className ? ` ${className}` : ""}`}
    >
      <span>{label}</span>
      <input
        type="text"
        value={value}
        maxLength={maxLength}
        {...(list ? { list } : {})}
        onChange={(event) => onChange(event.currentTarget.value)}
        {...(onFocus ? { onFocus } : {})}
      />
      {issue ? <small>{issue}</small> : null}
    </label>
  );
}

export function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  onFocus,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** Fires on focus — used to flash the matching element in the preview. */
  onFocus?: () => void;
}) {
  // Non-null while the box holds text that must not reach project state yet —
  // an emptied field ("" parses to 0), a partial entry like "-" (NaN), or an
  // out-of-range number mid-typing. In-range values commit per keystroke;
  // the rest waits for blur/Enter, which clamps or reverts.
  const [draftText, setDraftText] = useState<string | null>(null);
  const commitDraft = () => {
    if (draftText === null) {
      return;
    }
    const parsed = Number(draftText);
    if (draftText.trim() !== "" && Number.isFinite(parsed)) {
      onChange(Math.min(max, Math.max(min, parsed)));
    }
    setDraftText(null);
  };
  return (
    <label className="field number-field">
      <span>{label}</span>
      <input
        type="number"
        value={draftText ?? value}
        min={min}
        max={max}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          const parsed = Number(raw);
          if (raw.trim() !== "" && Number.isFinite(parsed) && parsed >= min && parsed <= max) {
            setDraftText(null);
            onChange(parsed);
          } else {
            setDraftText(raw);
          }
        }}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitDraft();
          }
        }}
        {...(onFocus ? { onFocus } : {})}
      />
    </label>
  );
}

export function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field color-field">
      <span>{label}</span>
      <span className="color-input-wrap">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <code>{value}</code>
      </span>
    </label>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  unit,
  hint,
  commitOn = "input",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  /** Extra reference note rendered under the slider (e.g. a unit conversion). */
  hint?: React.ReactNode;
  /**
   * "release" holds drags in a local draft and fires onChange only when the
   * thumb is let go — for sliders whose commit rebuilds an animated scene,
   * where a per-frame commit would restart the playback on every tick.
   */
  commitOn?: "input" | "release";
  onChange: (value: number) => void;
}) {
  // Non-null only mid-drag in release mode; doubles as the pending signal
  // that colors the field until the value is applied.
  const [draftValue, setDraftValue] = useState<number | null>(null);
  const shownValue = draftValue ?? value;
  const commitDraft = () => {
    if (draftValue !== null) {
      onChange(draftValue);
      setDraftValue(null);
    }
  };
  return (
    <label className={`field range-field${draftValue !== null ? " is-pending" : ""}`}>
      <span>{label}</span>
      <span className="range-body">
        <input
          type="range"
          value={shownValue}
          min={min}
          max={max}
          step={step}
          onChange={(event) => {
            const next = Number(event.currentTarget.value);
            if (commitOn === "release") {
              setDraftValue(next);
            } else {
              onChange(next);
            }
          }}
          onPointerUp={commitDraft}
          onPointerCancel={commitDraft}
          onKeyUp={commitDraft}
          onBlur={commitDraft}
        />
        <output>
          {shownValue}
          {unit}
        </output>
      </span>
      {hint ? <small className="range-hint">{hint}</small> : null}
    </label>
  );
}
export function SegmentedField<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
  hint,
}: {
  label: string;
  value: Value;
  options: Array<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
  /** Extra hook class, e.g. for cross-tab jump targets. */
  className?: string;
  hint?: React.ReactNode;
}) {
  return (
    <div className={`field segmented-field${className ? ` ${className}` : ""}`}>
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className={value === option.value ? "is-active" : ""}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint ? <small className="range-hint">{hint}</small> : null}
    </div>
  );
}
