/**
 * Selection-driven authoring for the two draft spans a user line can carry.
 *
 * Both notations are ruby-like and fiddly to key by hand — `[[表記|よみ]]` and
 * `{{確定形|入力}}` — and both describe a range of text that is already
 * written. So the affordance is the same in every editor that holds a user
 * message: select the finished text, say what was actually keyed, apply. The
 * bar refuses anything the scene layer would refuse, and says why, rather than
 * letting the author write markup that renders as literal text.
 */

import {
  createCompletionSpan,
  createImeSpan,
  type DraftSpanKind,
  MAX_MESSAGE_CHARS,
} from "@svgent/scene";
import { useState } from "react";
import type { UiStrings } from "./i18n.js";

export type DraftSelection = { start: number; end: number; text: string };

/** The selection inside a text field, or null when nothing is selected. */
export function readSelection(
  field: HTMLInputElement | HTMLTextAreaElement | null,
): DraftSelection | null {
  if (field === null) {
    return null;
  }
  const { selectionStart: start, selectionEnd: end, value } = field;
  return start !== null && end !== null && end > start
    ? { start, end, text: value.slice(start, end) }
    : null;
}

/** Wrap the selected range in a span, or null when it would not be valid. */
function applyDraftSpan(options: {
  value: string;
  selection: DraftSelection;
  kind: DraftSpanKind;
  stub: string;
}): { value: string; caret: number } | null {
  const { value, selection, kind, stub } = options;
  const span =
    kind === "ime"
      ? createImeSpan(selection.text, stub)
      : createCompletionSpan(selection.text, stub);
  if (span === null) {
    return null;
  }
  const next = `${value.slice(0, selection.start)}${span}${value.slice(selection.end)}`;
  return next.length > MAX_MESSAGE_CHARS
    ? null
    : { value: next, caret: selection.start + span.length };
}

/**
 * Why the bar will not apply, in the author's words. Two refusals need
 * different sentences: the span itself is malformed, or it is well formed but
 * the message has no room left for the markup it would add.
 */
function refusalFor(options: {
  selection: DraftSelection | null;
  kind: DraftSpanKind;
  stub: string;
  applied: { value: string; caret: number } | null;
  t: UiStrings;
}): string | null {
  const { selection, kind, stub, applied, t } = options;
  if (selection === null || stub.length === 0 || applied !== null) {
    return null;
  }
  const span =
    kind === "ime"
      ? createImeSpan(selection.text, stub)
      : createCompletionSpan(selection.text, stub);
  if (span !== null) {
    return t.draftMarkupOverflow;
  }
  // Neither rule is visible from the box alone: a completion has to be a
  // prefix of the selection, and a reading has to be kana. Say which one
  // was broken rather than leaving the apply button dead.
  return kind === "completion" ? t.completionPrefixError : t.imeReadingError;
}

export function DraftMarkupBar({
  value,
  selection,
  t,
  onApply,
}: {
  value: string;
  selection: DraftSelection | null;
  t: UiStrings;
  onApply: (next: { value: string; caret: number }) => void;
}) {
  const [kind, setKind] = useState<DraftSpanKind>("ime");
  const [stub, setStub] = useState("");

  const applied =
    selection === null ? null : applyDraftSpan({ value, selection, kind, stub: stub.trim() });
  const error = refusalFor({ selection, kind, stub: stub.trim(), applied, t });

  return (
    <div className="draft-markup-bar">
      <span className="draft-markup-label">{t.draftMarkupLabel}</span>
      <div className="draft-markup-kinds">
        <button
          type="button"
          className={kind === "ime" ? "is-active" : ""}
          aria-pressed={kind === "ime"}
          onClick={() => setKind("ime")}
        >
          {t.draftMarkupIme}
        </button>
        <button
          type="button"
          className={kind === "completion" ? "is-active" : ""}
          aria-pressed={kind === "completion"}
          onClick={() => setKind("completion")}
        >
          {t.draftMarkupCompletion}
        </button>
      </div>
      {selection === null ? (
        <span className="draft-markup-hint">{t.draftMarkupSelectHint}</span>
      ) : (
        <>
          <span className="draft-markup-hint">
            {kind === "ime"
              ? t.imeSelectionHint(selection.text)
              : t.completionSelectionHint(selection.text)}
          </span>
          <input
            type="text"
            value={stub}
            maxLength={80}
            placeholder={kind === "ime" ? t.imeReadingPlaceholder : t.completionTypedPlaceholder}
            aria-label={kind === "ime" ? t.imeReadingPlaceholder : t.completionTypedPlaceholder}
            // The box is too narrow for a sentence, so the worked example
            // rides the app tooltip, which opens on hover and on focus.
            data-tip={kind === "ime" ? t.imeReadingTip : t.completionTypedTip}
            onChange={(event) => setStub(event.currentTarget.value)}
          />
          <button
            type="button"
            disabled={applied === null}
            onClick={() => {
              if (applied !== null) {
                onApply(applied);
                setStub("");
              }
            }}
          >
            {kind === "ime" ? t.imeApply : t.completionApply}
          </button>
        </>
      )}
      {error === null ? null : <span className="draft-markup-error">{error}</span>}
    </div>
  );
}
