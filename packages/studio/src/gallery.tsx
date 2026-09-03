/**
 * The sample-script gallery: lazily rendered preset thumbnails and
 * fast-forwarded hover previews (shared with the wizard's script step),
 * plus the dialog that browses and applies them.
 */

import { GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import { documentIdPrefix } from "@svgent/render";
import { buildSvgentScene, type GeneratorIdentity, type SvgentProject } from "@svgent/scene";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDialogLightDismiss } from "./dialogs.js";
import type { useSvgentEngine } from "./engine.js";
import type { Lang, UiStrings } from "./i18n.js";
import { nextAnimationFrame } from "./playback.js";
import { instantiatePreset, SCRIPT_PRESETS, type ScriptPreset } from "./presets.js";

/** Gallery preview tempo: fast enough to see a whole story without leaving. */
const PRESET_PREVIEW_SPEED = 4;

type EngineState = ReturnType<typeof useSvgentEngine>;

/**
 * Preset thumbnails and hover previews, rendered in the project's own
 * style. Caches invalidate whenever that style (or the engine instance,
 * or the language) moves; the gallery re-renders them while it is open,
 * and the wizard kicks `renderPresetThumbs` for its own cards.
 */
export function usePresetPreviews(options: {
  /** The owning studio's identity; one studio, one set of names. */
  instance: string;
  engineState: EngineState;
  project: SvgentProject;
  lang: Lang;
  galleryOpen: boolean;
  generator: GeneratorIdentity;
}) {
  const { engineState, project, lang, galleryOpen, generator, instance } = options;
  const [presetThumbs, setPresetThumbs] = useState<Record<string, string>>({});
  const presetThumbsStarted = useRef(false);
  // Bumped whenever the style the previews inherit changes, so a render
  // started under the old style can drop its result instead of writing it
  // back over the fresh one.
  const presetRenderGeneration = useRef(0);
  // Hovering a gallery card plays its animation in the gallery's preview
  // pane — the card thumbnails only carry the mood, not the story.
  const [hoverPresetId, setHoverPresetId] = useState<string | null>(null);
  const [presetMotion, setPresetMotion] = useState<Record<string, string>>({});
  // Mirrors presetMotion for the debounced hover callback: the timeout
  // closure reads the state captured at hover time, so without the mirror
  // it re-renders a preset that finished caching inside the debounce window.
  const presetMotionRef = useRef<Record<string, string>>({});
  const hoverPresetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(hoverPresetTimer.current), []);

  /** Drop the preview pane and any pending hover debounce in one place. */
  const clearPresetHover = useCallback(() => {
    window.clearTimeout(hoverPresetTimer.current);
    setHoverPresetId(null);
  }, []);

  const presetProjectFor = (preset: ScriptPreset): SvgentProject => {
    const variant = preset.variants[lang];
    return {
      ...project,
      title: variant.title,
      workspaceLabel: variant.workspaceLabel,
      branchLabel: variant.branchLabel,
      messages: instantiatePreset(preset, lang),
    };
  };

  // The gallery preview runs fast-forwarded: it exists to judge the story,
  // not the pacing, and at real speed a full session outlives the visitor's
  // patience. The ×4 badge next to the pane says the tempo is not real.
  const presetPreviewProjectFor = (preset: ScriptPreset): SvgentProject => {
    const base = presetProjectFor(preset);
    const { timing } = base;
    return {
      ...base,
      timing: {
        userTypingCps: timing.userTypingCps * PRESET_PREVIEW_SPEED,
        agentTypingCps: timing.agentTypingCps * PRESET_PREVIEW_SPEED,
        reactionMs: timing.reactionMs / PRESET_PREVIEW_SPEED,
        thinkingMs: timing.thinkingMs / PRESET_PREVIEW_SPEED,
        toolRunMs: timing.toolRunMs / PRESET_PREVIEW_SPEED,
        imageGenMs: timing.imageGenMs / PRESET_PREVIEW_SPEED,
        permissionMs: timing.permissionMs / PRESET_PREVIEW_SPEED,
        transitionMs: timing.transitionMs / PRESET_PREVIEW_SPEED,
        finalHoldMs: timing.finalHoldMs / PRESET_PREVIEW_SPEED,
      },
    };
  };

  // Debounced so skimming the card grid doesn't render every script; the
  // animated SVG is cached per preset after the first hover.
  const hoverPreset = (presetId: string | null) => {
    window.clearTimeout(hoverPresetTimer.current);
    if (presetId === null) {
      setHoverPresetId(null);
      return;
    }
    hoverPresetTimer.current = window.setTimeout(() => {
      setHoverPresetId(presetId);
      const generation = presetRenderGeneration.current;
      if (engineState.status !== "ready" || presetMotionRef.current[presetId]) {
        return;
      }
      const preset = SCRIPT_PRESETS.find((entry) => entry.id === presetId);
      if (!preset) {
        return;
      }
      try {
        // The same engine that draws the scene has to measure it: the
        // estimate path places a block's rows by ratio arithmetic while the
        // engine lays the glyphs out for real, and the two disagree.
        const presetScene = buildSvgentScene(presetPreviewProjectFor(preset), 0, {
          engine: engineState.engine,
          generator,
          fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
        });
        const svg = engineState.engine.renderToAnimatedSvg(presetScene.vnode, {
          playback: { mode: "independent" },
          reducedMotion: "keep",
          resourceIdPrefix: documentIdPrefix("preset-motion", instance, presetId),
        });
        if (generation === presetRenderGeneration.current) {
          presetMotionRef.current = { ...presetMotionRef.current, [presetId]: svg };
          setPresetMotion((current) => ({ ...current, [presetId]: svg }));
        }
      } catch {
        // Fall back to the user's own preview.
      }
    }, 180);
  };

  /**
   * Render preset final frames lazily the first time the gallery opens, in
   * the user's current style, one per animation frame to keep the UI live.
   */
  const renderPresetThumbs = async () => {
    if (engineState.status !== "ready" || presetThumbsStarted.current) {
      return;
    }
    presetThumbsStarted.current = true;
    const generation = presetRenderGeneration.current;
    for (const preset of SCRIPT_PRESETS) {
      await nextAnimationFrame();
      if (generation !== presetRenderGeneration.current) {
        return;
      }
      try {
        const presetScene = buildSvgentScene(presetProjectFor(preset), 0, {
          engine: engineState.engine,
          generator,
          fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
        });
        const svg = engineState.engine.renderToSvg(presetScene.vnode, {
          timeMs: presetScene.durationMs,
          resourceIdPrefix: documentIdPrefix("thumb", instance, preset.id),
        });
        // The mood chip is a fixed-size crop, and object-fit does not apply
        // to inline SVG — "slice" is the SVG-native cover behavior.
        const cropped = svg.replace("<svg ", '<svg preserveAspectRatio="xMidYMid slice" ');
        setPresetThumbs((current) => ({ ...current, [preset.id]: cropped }));
      } catch {
        // A broken preset thumb falls back to the text label.
      }
    }
  };

  // Preset thumbnails and the hover preview are rendered in the project's
  // own style, so every one of them goes stale the moment that style moves
  // — most visibly on App/TUI, where a cached App card would sit under a lit
  // TUI toggle. Drop the caches and any preview still on the canvas; the
  // gallery re-renders them while it is open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is the set of style inputs that invalidate cached thumbs, not the closure's reads; renderPresetThumbs always runs from the latest closure.
  useEffect(() => {
    presetRenderGeneration.current += 1;
    presetThumbsStarted.current = false;
    setPresetThumbs({});
    presetMotionRef.current = {};
    setPresetMotion({});
    clearPresetHover();
    if (!galleryOpen) {
      return;
    }
    // Debounced: dragging a style slider must not restart the render on
    // every frame it emits.
    const timer = window.setTimeout(() => {
      void renderPresetThumbs();
    }, 220);
    return () => window.clearTimeout(timer);
  }, [
    galleryOpen,
    clearPresetHover,
    // The engine is disposed and rebuilt whenever the resolved fonts change
    // (typing with a Google font active is enough); the bump stops in-flight
    // preset loops before they call into the disposed instance, and the
    // clear drops thumbs whose glyphs the old engine shaped.
    engineState.engine,
    // Variants are language-native scripts, so a language switch invalidates
    // every cached thumbnail and hover render along with the style deps.
    lang,
    project.surface,
    project.modelLabel,
    project.appearance,
    project.chrome,
    project.display,
    project.fonts,
    project.timing,
    project.pagination,
  ]);

  return {
    presetThumbs,
    presetMotion,
    hoverPresetId,
    hoverPreset,
    clearPresetHover,
    renderPresetThumbs,
  };
}

/** Samples live in a dedicated dialog: applying one auto-closes it, so the
    message list keeps the full panel height at all times. */
export function GalleryDialog({
  dialogRef,
  onDialogClose,
  presetThumbs,
  presetMotion,
  hoverPresetId,
  hoverPreset,
  isAppliedPreset,
  returnToWizard,
  onApply,
  t,
  lang,
}: {
  /** Owned by the caller: the gallery opens from the script tab and wizard. */
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  /** Native close (Escape, backdrop, apply) — sync the caller's open state. */
  onDialogClose: () => void;
  presetThumbs: Record<string, string>;
  presetMotion: Record<string, string>;
  hoverPresetId: string | null;
  hoverPreset: (presetId: string | null) => void;
  /** Whether this card is the unedited starting point of the current script. */
  isAppliedPreset: (presetId: string) => boolean;
  /** The gallery was opened as the guide's script-selection subflow. */
  returnToWizard: boolean;
  onApply: (preset: ScriptPreset) => void;
  t: UiStrings;
  lang: Lang;
}) {
  const lightDismiss = useDialogLightDismiss();
  // Whether the pressed gallery card was already previewing when the
  // pointer went down (before the tap's own focus starts a preview).
  // Defaults to true so activations without a pointer press — keyboard
  // Enter — keep applying directly.
  const pressHadPreviewRef = useRef(true);

  // The gallery's preview pane: sticky on the last hovered card, so moving
  // the pointer off a card never blanks the pane mid-playback.
  const hoverPresetSvg = hoverPresetId !== null ? (presetMotion[hoverPresetId] ?? null) : null;
  const hoverPresetNode = useMemo(() => {
    if (!hoverPresetSvg) {
      return null;
    }
    return (
      <div
        key={`preset-${hoverPresetId}`}
        className="svg-preview"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: boundsvg-rendered SVG of built-in preset scripts, no user content
        dangerouslySetInnerHTML={{ __html: hoverPresetSvg }}
      />
    );
  }, [hoverPresetSvg, hoverPresetId]);

  return (
    <dialog
      className="gallery-dialog"
      ref={dialogRef}
      aria-label={t.scriptPresetsAria}
      onClose={onDialogClose}
      {...lightDismiss}
    >
      <header className="export-head">
        <strong>{t.scriptPresetsAria}</strong>
      </header>
      <div className="gallery-columns">
        {/* biome-ignore lint/a11y/useSemanticElements: <fieldset> breaks the required grid behavior in Firefox and Safari (same reason as the App.tsx override) */}
        <div className="gallery-cards" role="group" aria-label={t.scriptPresetsAria}>
          {SCRIPT_PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={`gallery-card${isAppliedPreset(preset.id) ? " is-active" : ""}${
                hoverPresetId === preset.id ? " is-previewing" : ""
              }`}
              aria-pressed={isAppliedPreset(preset.id)}
              onPointerDown={() => {
                pressHadPreviewRef.current = hoverPresetId === preset.id;
              }}
              onClick={() => {
                const hadPreview = pressHadPreviewRef.current;
                pressHadPreviewRef.current = true;
                // Touch has no hover, so the tap does double duty: the
                // first starts the fast-forward preview the hint
                // promises, and only a tap on the already-previewing
                // card applies. Now that a pristine script applies
                // without a confirm, the dialog no longer supplies the
                // browse-more escape this used to lean on.
                if (
                  !hadPreview &&
                  window.matchMedia("(hover: none) and (pointer: coarse)").matches
                ) {
                  hoverPreset(preset.id);
                  return;
                }
                onApply(preset);
              }}
              onMouseEnter={() => hoverPreset(preset.id)}
              onFocus={() => hoverPreset(preset.id)}
            >
              {presetThumbs[preset.id] ? (
                <span
                  className="preset-thumb"
                  aria-hidden="true"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: boundsvg-rendered SVG of built-in preset scripts, no user content
                  dangerouslySetInnerHTML={{ __html: presetThumbs[preset.id] ?? "" }}
                />
              ) : (
                <span className="preset-thumb is-empty" aria-hidden="true" />
              )}
              <span className="gallery-card-text">
                <span className="gallery-card-title">{preset.label[lang]}</span>
                <small>{preset.description[lang]}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="gallery-preview">
          {hoverPresetNode ?? (
            <p className="gallery-preview-empty">
              <span className="copy-hover">{t.scriptGalleryHint}</span>
              <span className="copy-touch">{t.scriptGalleryHintTouch}</span>
            </p>
          )}
          {hoverPresetNode ? (
            <span className="gallery-preview-badge">{t.scriptGalleryBadge}</span>
          ) : null}
        </div>
        {/* Touch has no hover, so the second step of tap-to-preview → apply
            gets a visible button; tapping the card again still works. Hover
            devices apply on click and never see this.

            It sits under the preview rather than over it. Floating it in the
            corner put it on top of a picture that is playing: the scene's own
            window frame sweeps past underneath, and at some frames its bright
            edge runs straight into the button. Nothing paints above the
            button — the collision is with the artwork itself, so no stacking
            order fixes it and the button has to leave the picture. */}
        {hoverPresetId !== null ? (
          <button
            type="button"
            className="gallery-apply-touch"
            onClick={() => {
              const preset = SCRIPT_PRESETS.find((entry) => entry.id === hoverPresetId);
              if (preset) {
                onApply(preset);
              }
            }}
          >
            {t.galleryApplyButton}
          </button>
        ) : null}
      </div>
      <footer className="gallery-actions">
        <p>{t.galleryReturnHint}</p>
        <button type="button" onClick={() => dialogRef.current?.close()}>
          {returnToWizard ? t.galleryReturnToWizard : t.galleryReturnToEditor}
        </button>
      </footer>
    </dialog>
  );
}
