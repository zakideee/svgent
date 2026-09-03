/**
 * Device-local autosave: restore-on-load, debounced image-free writes,
 * and the restore-notice copy that explains what came back.
 */

import {
  defaultProjectFor,
  deserializeProject,
  type SvgentProject,
  serializeProject,
} from "@svgent/scene";
import { useEffect, useRef, useState } from "react";
import { initialLang, type Lang, type UiStrings } from "./i18n.js";
import type { StudioPersistence } from "./persistence.js";

const PROJECT_STORAGE_KEY = "project";
/** How many images the latest autosave left out (autosave is text-only). */
const AUTOSAVE_OMITTED_IMAGES_KEY = "autosave-omitted-images";

/**
 * A plausible random session clock for fresh projects, so every new
 * document doesn't open at the same minute.
 */
function randomClockTime(): string {
  // Round five-minute marks read as a deliberate setting rather than a
  // timestamp someone forgot to change.
  const hour = 8 + Math.floor(Math.random() * 15);
  const minute = Math.floor(Math.random() * 12) * 5;
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

/**
 * How a studio's first project came to be. One studio's restore says nothing
 * about another's, so this travels with the project instead of sitting in a
 * module: two studios in one document each answer for their own storage.
 */
export type RestoredProject = {
  project: SvgentProject;
  /** Whether this studio started from an autosave rather than a default. */
  restored: boolean;
  /** How many images that autosave left out; autosave is text-only. */
  omittedImages: number;
};

/**
 * The autosave persists text and settings only. Image Data URLs are
 * megabytes of base64: one large image used to blow the localStorage
 * quota and silently kill the whole autosave, and the only images that
 * belong on a device are the ones saved into a script JSON deliberately.
 */
function stripImagesForAutosave(project: SvgentProject): {
  project: SvgentProject;
  omitted: number;
} {
  let omitted = 0;
  const messages = project.messages.map((message) => {
    if (!message.images || message.images.length === 0) {
      return message;
    }
    omitted += message.images.length;
    const { images: _omitted, ...rest } = message;
    return rest;
  });
  const { backdropImage, ...appearance } = project.appearance;
  if (backdropImage) {
    omitted += 1;
  }
  return { project: { ...project, appearance, messages }, omitted };
}

/** A cheap identity of the attached images, without their bytes. */
function imageFingerprint(project: SvgentProject): string {
  const messageImages = project.messages
    .map(
      (message) =>
        `${message.id}:${(message.images ?? []).map((image) => image.dataUrl.length).join(",")}`,
    )
    .join("|");
  return `${messageImages}#${project.appearance.backdropImage?.dataUrl.length ?? 0}`;
}

/** Write the autosave and its omitted-images marker in one step. */
function writeAutosave(persistence: StudioPersistence, serialized: string, omitted: number): void {
  persistence.setItem(PROJECT_STORAGE_KEY, serialized);
  if (omitted > 0) {
    persistence.setItem(AUTOSAVE_OMITTED_IMAGES_KEY, String(omitted));
  } else {
    persistence.removeItem(AUTOSAVE_OMITTED_IMAGES_KEY);
  }
}

/** Delete the autosave and its marker — the factory-reset path. */
export function clearAutosave(persistence: StudioPersistence | null): void {
  persistence?.removeItem(PROJECT_STORAGE_KEY);
  persistence?.removeItem(AUTOSAVE_OMITTED_IMAGES_KEY);
}

/** The restore notice line, with the omitted-images tail when it applies. */
export function restoreNoticeText(t: UiStrings, omittedImages: number): string {
  return omittedImages > 0
    ? `${t.restoreNotice} ${t.restoreNoImages(omittedImages)}`
    : t.restoreNotice;
}

/** A default project in this language, with a fresh plausible clock. */
export function freshProjectFor(lang: Lang): SvgentProject {
  const defaults = defaultProjectFor(lang);
  return {
    ...defaults,
    chrome: { ...defaults.chrome, clockTime: randomClockTime() },
  };
}

/**
 * Restore the last autosaved script so a reload never loses work. The stored
 * JSON goes through the same import path as a file, so schema drift degrades
 * to clamped defaults instead of a crash.
 */
export function initialProject(
  persistence: StudioPersistence | null,
  lang: Lang = initialLang(persistence),
): RestoredProject {
  try {
    const stored = persistence?.getItem(PROJECT_STORAGE_KEY);
    if (stored) {
      return {
        project: deserializeProject(stored).project,
        restored: true,
        omittedImages: Number(persistence?.getItem(AUTOSAVE_OMITTED_IMAGES_KEY)) || 0,
      };
    }
  } catch {
    // Corrupt or inaccessible storage — start fresh.
  }
  // The first-visit sample follows the detected UI language, so the first
  // conversation a visitor sees is one they can read.
  return { project: freshProjectFor(lang), restored: false, omittedImages: 0 };
}

/**
 * Autosave the script (debounced) so a tab reload never loses work — but
 * never persist a pristine state. The baseline is the snapshot right
 * after load or factory reset; until the user diverges from it, storage
 * stays untouched, so a fresh visit leaves no data behind and "Reset all"
 * isn't silently undone by the debounce re-saving the defaults it just
 * wiped. The payload is image-free; the fingerprint keeps attach/remove
 * visible as divergence anyway, so the omitted-images marker (and the
 * notice it powers) stays truthful without serializing megabytes of Data
 * URLs on every debounce.
 */
export function useAutosave(project: SvgentProject, persistence: StudioPersistence | null) {
  const baselineRef = useRef<string | undefined>(undefined);
  // Autosave is best-effort, but failing must not be silent: the header
  // promises device-local saving, so a user who trusts it and reloads
  // would lose work without ever being warned.
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (persistence === null) {
        return;
      }
      try {
        const stripped = stripImagesForAutosave(project);
        const serialized = serializeProject(stripped.project);
        const snapshot = `${serialized}\n${imageFingerprint(project)}`;
        if (baselineRef.current === undefined) {
          baselineRef.current = snapshot;
        }
        if (snapshot === baselineRef.current) {
          return;
        }
        // Diverged once — save this and every later state (an empty string
        // can never equal a snapshot, so the baseline stops matching).
        baselineRef.current = "";
        writeAutosave(persistence, serialized, stripped.omitted);
        setAutosaveFailed(false);
      } catch {
        setAutosaveFailed(true);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [project, persistence]);
  const dismissAutosaveFailure = () => setAutosaveFailed(false);
  // Re-arm the pristine baseline so a just-reset state isn't re-saved.
  const rearmAutosaveBaseline = () => {
    baselineRef.current = undefined;
  };
  return { autosaveFailed, dismissAutosaveFailure, rearmAutosaveBaseline };
}
