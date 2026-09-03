import type { DisplaySettings } from "@svgent/scene";

export function PresetSkeleton({
  fontScale,
  display,
}: {
  fontScale: number;
  display: DisplaySettings;
}) {
  // The sample glyph exaggerates fontScale differences (~20px per 1.0x):
  // at thumbnail size the true ratio between presets is unreadable, and
  // the neighboring bars only differed by a pixel.
  const glyphPx = Math.max(9, Math.round(8 + (fontScale - 1) * 20));
  const bar = Math.max(2, Math.round(fontScale * 2.6));
  const headerVisible = display.header;
  return (
    <span className="preset-skel" aria-hidden="true">
      {headerVisible ? (
        <span className="skel-header">
          {display.headerText ? <i className="skel-title" /> : null}
          {display.headerIcons ? (
            <span className="skel-icons">
              <i />
              <i />
              <i />
            </span>
          ) : null}
        </span>
      ) : null}
      <span className="skel-body">
        <b className="skel-glyph" style={{ fontSize: glyphPx }}>
          Aa
        </b>
        <span className="skel-lines">
          <i className="skel-user" style={{ height: bar }} />
          <i className="skel-agent" style={{ height: bar }} />
          <i className="skel-agent is-short" style={{ height: bar }} />
        </span>
      </span>
      {display.composer ? <i className="skel-composer" /> : null}
      {display.footer ? <i className="skel-footer" /> : null}
    </span>
  );
}

/**
 * Instant hover hint (no native-title delay) for settings that slow exports
 * down — the note appears the moment the cursor reaches the marker.
 */
export function HintTip({ text }: { text: string }) {
  return (
    <button type="button" className="hint-tip" data-tip={text} aria-label={text}>
      ⓘ
    </button>
  );
}

/**
 * "Back to the shipped defaults" for one area of the app.
 *
 * Lives at the foot of the tab that owns the settings it clears, so there is
 * exactly one per area and it is found where the drifting happened rather
 * than in a menu. The confirm is deliberate: this is a recovery action taken
 * rarely, and losing tuned colors to a stray tap would be the thing it exists
 * to prevent.
 */
export function ResetSection({
  label,
  note,
  onReset,
}: {
  label: string;
  note: string;
  onReset: () => void;
}) {
  return (
    <div className="reset-section">
      <button type="button" className="reset-section-button" onClick={onReset}>
        ↺ {label}
      </button>
      <small>{note}</small>
    </div>
  );
}
