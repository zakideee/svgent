/**
 * Fixed notices and small status chips: autosave failure, the undo
 * offers, the camera off-ramp, and the one-time export use note.
 */

import type { RefObject } from "react";
import type { UiStrings } from "./i18n.js";
import type { ScriptUndoEntry } from "./undo.js";

/** Shown while writes to the device save keep failing; export is the way out. */
/**
 * A studio that shares its saved data with another one on the page does not
 * write to the device. The header promises device-local saving, so a studio
 * that is not keeping that promise has to say so where the promise was made.
 */
export function AutosaveNotOwnedNotice({ owned, t }: { owned: boolean; t: UiStrings }) {
  if (owned) {
    return null;
  }
  return (
    <output className="restore-notice autosave-notice">
      <span>{t.autosaveNotOwned}</span>
    </output>
  );
}

export function AutosaveFailedNotice({
  failed,
  t,
  onDismiss,
}: {
  failed: boolean;
  t: UiStrings;
  onDismiss: () => void;
}) {
  if (!failed) {
    return null;
  }
  return (
    <output className="restore-notice autosave-notice">
      <span>{t.autosaveFailed}</span>
      <button
        type="button"
        className="restore-dismiss"
        aria-label={t.restoreDismiss}
        onClick={onDismiss}
      >
        ✕
      </button>
    </output>
  );
}

/**
 * The one-tap off-ramp shown wherever an export starts while the follow
 * camera is on. The live preview makes the camera self-evident
 * everywhere else; the export dialog covers it, and the wizard's
 * download step is the last stop — both state the flavor right where it
 * is about to take effect.
 */
export function CameraOffRamp({
  follow,
  t,
  onTurnOff,
}: {
  follow: boolean;
  t: UiStrings;
  onTurnOff: () => void;
}) {
  if (!follow) {
    return null;
  }
  return (
    <p className="camera-off-ramp">
      <span>{t.cameraOnStatus}</span>
      <button type="button" onClick={onTurnOff}>
        {t.cameraTurnOff}
      </button>
    </p>
  );
}

/** The pinned-frame explainer on the phone stage; tapping releases the pin. */
export function StageHoldChip({
  shellRef,
  t,
}: {
  shellRef: RefObject<HTMLElement | null>;
  t: UiStrings;
}) {
  return (
    <button
      type="button"
      className="stage-hold-chip"
      onClick={() => {
        // Focus belongs to the page, so releasing the pin means releasing this
        // studio's own field — never the editor in the studio beside it. The
        // shell arrives as a ref rather than through a class name: a rename
        // would make `closest` answer null and the chip would stop doing the
        // one thing it is for, with nothing failing.
        const active = document.activeElement;
        if (active instanceof HTMLElement && (shellRef.current?.contains(active) ?? false)) {
          active.blur();
        }
      }}
    >
      {t.editFollowActive} · {t.stageHoldResume}
    </button>
  );
}

/** One-time toast: the export-dialog use note, for exports that skip the dialog. */
export function UseNoteToast({
  open,
  t,
  onDismiss,
}: {
  open: boolean;
  t: UiStrings;
  onDismiss: () => void;
}) {
  if (!open) {
    return null;
  }
  return (
    <output className="restore-notice use-note-toast">
      <span>{t.exportUseNote}</span>
      <button
        type="button"
        className="restore-dismiss"
        aria-label={t.restoreDismiss}
        onClick={onDismiss}
      >
        ✕
      </button>
    </output>
  );
}

/**
 * The fixed bottom notice that offers to take the last clear or image
 * removal back. Deletes get the inline row where the card was instead —
 * on a tall screen the bottom of the window is nowhere near the delete
 * button that was just pressed.
 */
export function UndoNotice({
  stack,
  t,
  onUndo,
  onDismiss,
}: {
  stack: ScriptUndoEntry[];
  t: UiStrings;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const newest = stack[stack.length - 1];
  if (!newest || newest.kind === "delete") {
    return null;
  }
  return (
    <output className="restore-notice undo-notice">
      <span>
        {newest.kind === "image-remove"
          ? t.undoImageRemovedNotice(stack.length)
          : t.undoClearedNotice(stack.length)}
      </span>
      <button type="button" onClick={onUndo}>
        {t.undoRestore}
      </button>
      <button
        type="button"
        className="restore-dismiss"
        aria-label={t.undoDismiss}
        onClick={onDismiss}
      >
        ✕
      </button>
    </output>
  );
}

/** Sits exactly where the deleted card was: the hole offers the way back. */
export function InlineUndoRow({
  count,
  t,
  onUndo,
  onDismiss,
}: {
  count: number;
  t: UiStrings;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  return (
    <output className="inline-undo-row">
      <span>{t.undoDeletedNotice(count)}</span>
      <button type="button" onClick={onUndo}>
        {t.undoRestore}
      </button>
      <button
        type="button"
        className="restore-dismiss"
        aria-label={t.undoDismiss}
        onClick={onDismiss}
      >
        ✕
      </button>
    </output>
  );
}
