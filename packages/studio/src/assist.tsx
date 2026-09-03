/**
 * Chat-assisted authoring: no LLM API — the user carries a prompt to
 * their own chat tool and pastes the reply back for salvage + import.
 */

import { buildScriptPrompt, deserializeProject, extractScriptJson } from "@svgent/scene";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogLightDismiss } from "./dialogs.js";
import type { Lang, UiStrings } from "./i18n.js";

type AssistImport = ReturnType<typeof deserializeProject>;

export function AssistDialog({
  dialogRef,
  lang,
  t,
  onApply,
}: {
  /** Owned by the caller: the assist entry points live outside the dialog. */
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  lang: Lang;
  t: UiStrings;
  /** Put the parsed script into the project; the caller owns the merge. */
  onApply: (imported: AssistImport, keepStyle: boolean) => void;
}) {
  const lightDismiss = useDialogLightDismiss();
  const [assistTheme, setAssistTheme] = useState("");
  const [assistPaste, setAssistPaste] = useState("");
  const [assistKeepStyle, setAssistKeepStyle] = useState(true);
  const [assistCopied, setAssistCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const assistPrompt = buildScriptPrompt(assistTheme, lang);

  const assistResult = useMemo(() => {
    if (assistPaste.trim().length === 0) {
      return { state: "empty" as const };
    }
    const json = extractScriptJson(assistPaste);
    if (json === null) {
      return { state: "nojson" as const };
    }
    try {
      const imported = deserializeProject(json, lang);
      return { state: "ok" as const, imported };
    } catch (cause) {
      return {
        state: "error" as const,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }, [assistPaste, lang]);

  const applyAssist = () => {
    if (assistResult.state !== "ok") {
      return;
    }
    onApply(assistResult.imported, assistKeepStyle);
    setAssistPaste("");
    dialogRef.current?.close();
  };

  const copyAssistPrompt = async () => {
    try {
      await navigator.clipboard.writeText(assistPrompt);
      setAssistCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setAssistCopied(false), 1_600);
    } catch {
      // Clipboard unavailable — the textarea below stays selectable.
    }
  };

  return (
    <dialog className="assist-dialog" ref={dialogRef} aria-label={t.assistOpen} {...lightDismiss}>
      <header className="export-head">
        <strong>{t.assistTitle}</strong>
        <button
          type="button"
          className="export-close"
          aria-label={t.exportClose}
          onClick={() => dialogRef.current?.close()}
        >
          ✕
        </button>
      </header>
      <p className="assist-note">{t.assistIntro}</p>
      <label className="field text-field">
        <span>{t.assistThemeLabel}</span>
        <input
          type="text"
          value={assistTheme}
          maxLength={200}
          placeholder={t.assistThemePlaceholder}
          onChange={(event) => setAssistTheme(event.currentTarget.value)}
        />
      </label>
      <div className="assist-step">
        <span>{t.assistStepCopy}</span>
        <button type="button" className="assist-copy" onClick={() => void copyAssistPrompt()}>
          {assistCopied ? t.assistCopied : t.assistCopy}
        </button>
      </div>
      <textarea className="assist-prompt" readOnly value={assistPrompt} rows={6} />
      <div className="assist-step">
        <span>{t.assistStepPaste}</span>
        {/* A reply that failed to parse is the one you most want gone, and
            select-all inside a filled textarea is the worst way to do it. */}
        <button
          type="button"
          className="assist-clear"
          disabled={assistPaste.length === 0}
          onClick={() => setAssistPaste("")}
        >
          {t.assistClear}
        </button>
      </div>
      <textarea
        className="assist-paste"
        value={assistPaste}
        rows={6}
        placeholder={t.assistPastePlaceholder}
        onChange={(event) => setAssistPaste(event.currentTarget.value)}
      />
      {assistResult.state === "nojson" ? (
        <p className="assist-status is-bad">{t.assistNoJson}</p>
      ) : assistResult.state === "error" ? (
        <p className="assist-status is-bad">{assistResult.message}</p>
      ) : assistResult.state === "ok" ? (
        <div className="assist-status is-ok">
          <p>{t.assistParsed(assistResult.imported.project.messages.length)}</p>
          {assistResult.imported.warnings.map((warning) => (
            <p key={warning}>• {warning}</p>
          ))}
        </div>
      ) : null}
      <div className="confirm-actions">
        <label className="display-toggle">
          <input
            type="checkbox"
            checked={assistKeepStyle}
            onChange={(event) => setAssistKeepStyle(event.currentTarget.checked)}
          />
          {t.assistKeepStyle}
        </label>
        <button
          type="button"
          className="is-primary"
          disabled={assistResult.state !== "ok"}
          onClick={applyAssist}
        >
          {t.assistApply}
        </button>
      </div>
    </dialog>
  );
}
