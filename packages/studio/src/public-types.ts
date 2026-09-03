import type { SvgentProject } from "@svgent/scene";
import type React from "react";
import type { StudioPersistence } from "./persistence.js";

export type StudioLocale = "ja" | "en";

export type StudioExportResult = {
  kind:
    | "poster-svg"
    | "animated-svg"
    | "poster-png"
    | "poster-webp"
    | "animated-webp"
    | "gif"
    | "mp4"
    | "transcript-svg"
    | "transcript-png";
  fileName: string;
  blob: Blob;
};

export type StudioProductConfig = {
  name: string;
  version: string;
  engineVersion: string;
  repositoryUrl?: string;
  storageKeyPrefix: string;
};

/**
 * How much of the studio's own chrome is drawn. "full" is the editor: header,
 * control panel and preview. "stage" is the preview column alone — the stage,
 * its transport and its status row — for a host that supplies the editing
 * surface itself and drives the script through a `StudioHandle`.
 */
export type StudioChrome = "full" | "stage";

/**
 * Imperative access to a mounted studio, for a host that edits the script from
 * outside — an agent tool layer, a test harness. Every method goes through the
 * same state the studio's own controls use, so undo, autosave, validation and
 * the preview all see the change.
 */
export type StudioHandle = {
  /** The script as the studio holds it right now. */
  getProject(): SvgentProject;
  /** Swap the whole script, the way importing a file does. */
  replaceProject(project: SvgentProject): void;
  /** Derive the next script from the current one and commit it. */
  applyPatch(update: (current: SvgentProject) => SvgentProject): void;
  /** Pause and cue the preview to a moment, optionally on another page. */
  seek(timeMs: number, options?: { page?: number }): void;
  /** Resume the preview; `restart` plays the page from its first frame. */
  play(options?: { restart?: boolean }): void;
  /**
   * Export through the studio's own runner and hand every artifact to the
   * browser's download. Rejects when the engine is not ready or the script
   * has issues that block export, naming them.
   */
  exportArtifact(
    kind: StudioExportResult["kind"],
    options?: { allPages?: boolean },
  ): Promise<StudioExportResult[]>;
  /**
   * Draw the eye to messages something just changed: the first one's
   * outline flashes on the stage (when it is on screen), and every one's
   * script card lights up the way it does after an edit on the canvas —
   * with `jump`, the script panel also scrolls the first card into view.
   */
  spotlight(messageIds: readonly string[], options?: { jump?: boolean }): void;
  /**
   * Rasterize one moment of the script as a PNG, without downloading it: a
   * frame a host can show back to whoever is directing, or hand to an agent
   * that cannot see the stage. `scale` is relative to the canvas size.
   */
  renderFrame(options: { timeMs: number; page?: number; scale?: number }): Promise<{
    bytes: Uint8Array;
    page: number;
    timeMs: number;
    durationMs: number;
    width: number;
    height: number;
  }>;
};

export type StudioProps = {
  initialProject?: SvgentProject;
  /** Which of the studio's surfaces to draw; the editor by default. */
  chrome?: StudioChrome;
  /** Receives a `StudioHandle` once mounted. */
  ref?: React.Ref<StudioHandle>;
  /**
   * Separates this studio's generated names — its preview's `@keyframes`, its
   * classes, its `<defs>` — from another studio's on the same page. A preview
   * is an inline SVG, and an inline SVG's `<style>` belongs to the whole HTML
   * document rather than to the SVG.
   *
   * Two studios in one React tree are separated without this. Two mounted
   * through separate `createRoot` calls are not: `useId` is unique within a
   * root, so both roots hand out the same value unless they were created with
   * `identifierPrefix`. Give each mount its own string, or pass
   * `identifierPrefix` to `createRoot`.
   *
   * Letters, digits and `-`, starting with a letter or digit. `_` closes a
   * generated name, so a value carrying one is refused rather than repaired.
   * The same shape applies to a `createRoot` `identifierPrefix` used instead
   * of this prop: two roots whose prefixes differ only outside that set are
   * two roots this cannot tell apart.
   *
   * It also names this studio's drawer in device storage, so several studios
   * keep their own saved script instead of overwriting one another's. That
   * half is never derived: `useId` answers to the shape of the React tree, and
   * a component added above this one would rename the drawer and lose what is
   * in it. A studio given no `instanceId` saves under `storageKeyPrefix`
   * alone, and the first one to claim that name is the only one that writes.
   */
  instanceId?: string;
  locale?: StudioLocale;
  /**
   * Open the first-run guide for a visitor who has not seen it. The panel is
   * fixed to the viewport and covers the document, so it belongs to the app
   * that owns the page rather than to every studio embedded in one.
   */
  onboarding?: boolean;
  persistence?: StudioPersistence | false;
  product?: StudioProductConfig;
  /** Resolve package-owned browser assets such as bundled fonts. */
  resolveAssetUrl?: (assetPath: string) => string;
  onProjectChange?: (project: SvgentProject) => void;
  /** Fires when the in-app language toggle lands on a new language. */
  onLocaleChange?: (locale: StudioLocale) => void;
  /**
   * Fires when the in-app theme toggle lands on a new theme, and on mount.
   * The studio paints its own box and leaves the page alone; a host that wants
   * the page to follow — its own background, its own scrollbars — takes this
   * and applies it where it wants it.
   *
   * Called synchronously after the studio's DOM changes and before the browser
   * paints them, so that the page and the studio change together rather than a
   * frame apart. That makes this handler part of the frame: keep it short and
   * synchronous. Layout reads, heavy work, or a state update here hold up the
   * paint, and an uncaught throw can abort the commit before it. React calls it
   * more than once on mount in development under StrictMode, so it also has to
   * be safe to repeat.
   */
  onThemeChange?: (theme: "dark" | "light") => void;
  onExport?: (result: StudioExportResult) => void;
  onError?: (error: Error) => void;
};
