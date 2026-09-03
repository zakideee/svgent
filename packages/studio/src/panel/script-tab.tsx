/**
 * Script tab: the message cards with their live-sort drag, the
 * separators that carry slide breaks and the insert menu, the script
 * I/O row, and the character budget.
 */

import {
  MAX_MESSAGES,
  type MessageRole,
  type SessionMessage,
  type SvgentProject,
} from "@svgent/scene";
import type React from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { UiStrings } from "../i18n.js";
import { ClipboardIcon, DownloadIcon, RoleIcon, UploadIcon } from "../icons.js";
import { MessageEditor, ROLE_LABELS } from "../message-editor.js";
import { InlineUndoRow } from "../notices.js";
import type { useProjectActions } from "../project-actions.js";
import { useListShiftFlip, useMessageListDrag } from "./message-list-motion.js";

/** Total visible-character budget for animated text across the script. */
const TOTAL_CHARACTER_BUDGET = 3_200;

export function ScriptTab({
  instance,
  project,
  totalCharacters,
  messagePage,
  actions,
  undo,
  importWarnings,
  onDismissImportWarnings,
  scriptCopied,
  onCopyScript,
  onImportScript,
  onExportScript,
  onOpenGallery,
  onOpenAssist,
  onNewScript,
  onResetAll,
  onJumpToFlowField,
  currentScrubMessageId,
  onMessageFocusChange,
  t,
}: {
  /** The owning studio's identity; radio groups and ids are named with it. */
  instance: string;
  project: SvgentProject;
  totalCharacters: number;
  /** Which page each message lands on, for the slide-boundary labels. */
  messagePage: Record<string, number>;
  actions: Pick<
    ReturnType<typeof useProjectActions>,
    | "updateMessage"
    | "removeMessage"
    | "clearMessageContent"
    | "removeMessageImage"
    | "attachImage"
    | "moveMessage"
    | "duplicateMessage"
    | "insertMessage"
    | "reorderMessage"
  >;
  undo: {
    /** Where the deleted card sat, so the offer sits in its hole. */
    rowIndex: number | null;
    count: number;
    onUndo: () => void;
    onDismiss: () => void;
  };
  importWarnings: string[];
  onDismissImportWarnings: () => void;
  scriptCopied: boolean;
  onCopyScript: () => Promise<void>;
  onImportScript: (file: File) => void;
  onExportScript: () => void;
  onOpenGallery: () => void;
  onOpenAssist: () => void;
  onNewScript: () => void;
  onResetAll: () => void;
  /** Page labels are effects of a Style-tab control; tapping jumps to it. */
  onJumpToFlowField: () => void;
  currentScrubMessageId: string | null;
  onMessageFocusChange: (messageId: string, focused: boolean) => void;
  t: UiStrings;
}) {
  const {
    updateMessage,
    removeMessage,
    clearMessageContent,
    removeMessageImage,
    attachImage,
    moveMessage,
    duplicateMessage,
    insertMessage,
    reorderMessage,
  } = actions;
  // One add-message grammar: every gap (and the list tail) opens the same
  // role menu, replacing the old split between "insert user here" and the
  // fixed append-at-end palette.
  const [insertMenuAt, setInsertMenuAt] = useState<number | null>(null);
  // The role menu flips upward when the + sits too low for the full list
  // to fit under it — the fixed backdrop blocks scrolling, so a menu cut
  // by the viewport edge would be unreachable.
  const [insertMenuUp, setInsertMenuUp] = useState(false);
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  const [scriptMenuOpen, setScriptMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { skipNextShift } = useListShiftFlip({
    listRef,
    messages: project.messages,
    flow: project.pagination.flow,
  });
  const { messageDrag, startMessageDrag, dragOffsetFor } = useMessageListDrag({
    listRef,
    messageCount: project.messages.length,
    onReorder: (from, to) => {
      // A drop already showed the landing spot through the live-sort
      // shift; replaying it as a glide would move the card twice.
      skipNextShift();
      reorderMessage(from, to);
    },
  });

  const insertMessageAt = (afterIndex: number, role: MessageRole) => {
    const created = insertMessage(afterIndex, role);
    setInsertMenuAt(null);
    setFlashMessageId(created.id);
  };

  // The freshly inserted card announces itself: scroll to it and glow
  // once — without this, an insert below the fold looks like nothing
  // happened under the sticky preview.
  useEffect(() => {
    if (flashMessageId === null) {
      return;
    }
    // Inside this studio's own list: the class names every studio's freshly
    // inserted row, and a document-wide search scrolls to whichever studio
    // happens to come first in the DOM.
    listRef.current
      ?.querySelector(".message-editor.is-just-inserted")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => setFlashMessageId(null), 1_500);
    return () => window.clearTimeout(timer);
  }, [flashMessageId]);

  const inlineUndoRow = (
    <InlineUndoRow count={undo.count} t={t} onUndo={undo.onUndo} onDismiss={undo.onDismiss} />
  );

  /**
   * The + between cards and at the list tail: one tap opens the role
   * menu, with the likeliest next role first (turns alternate, so after
   * a user message the agent side leads).
   */
  const insertSlot = (afterIndex: number): React.ReactNode => {
    const suggested: MessageRole =
      project.messages[afterIndex]?.role === "user" ? "assistant" : "user";
    const roles: MessageRole[] = [
      suggested,
      ...(Object.keys(ROLE_LABELS) as MessageRole[]).filter((role) => role !== suggested),
    ];
    return (
      <span className="insert-menu">
        <button
          type="button"
          className="insert-between"
          data-tip={t.insertBelow}
          aria-label={t.insertBelow}
          aria-haspopup="menu"
          aria-expanded={insertMenuAt === afterIndex}
          disabled={project.messages.length >= MAX_MESSAGES}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const spaceBelow = window.innerHeight - rect.bottom;
            // ~7 items at 34px plus chrome; prefer whichever side fits.
            setInsertMenuUp(spaceBelow < 270 && rect.top > spaceBelow);
            setInsertMenuAt((open) => (open === afterIndex ? null : afterIndex));
          }}
        >
          +
        </button>
        {insertMenuAt === afterIndex ? (
          <>
            <button
              type="button"
              className="insert-menu-backdrop"
              aria-label={t.wizardClose}
              onClick={() => setInsertMenuAt(null)}
            />
            <div className={`insert-menu-pop${insertMenuUp ? " is-up" : ""}`} role="menu">
              {roles.map((role) => (
                <button
                  key={role}
                  type="button"
                  role="menuitem"
                  onClick={() => insertMessageAt(afterIndex, role)}
                >
                  <span className="insert-menu-icon" aria-hidden="true">
                    <RoleIcon role={role} />
                  </span>
                  {ROLE_LABELS[role]}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </span>
    );
  };

  /**
   * The control between two message cards: a slide-break toggle when the
   * flow is slides, an insert-here button otherwise. Nothing follows the
   * last card.
   */
  const messageSeparator = (message: SessionMessage, index: number): React.ReactNode => {
    if (index >= project.messages.length - 1) {
      return null;
    }
    const next = project.messages[index + 1];
    if (project.pagination.flow !== "slides" || next === undefined) {
      return insertSlot(index);
    }
    const boundary = messagePage[next.id] !== messagePage[message.id];
    const manual = next.pageBreakBefore ?? false;
    // The scissors toggle the boundary the author can see, wherever it came
    // from: a manual break is cleared, an automatic one is suppressed with
    // an explicit join, and a plain gap gains a break. Pressing the button
    // always changes the page picture.
    const toggleBreak = () =>
      updateMessage(next.id, {
        pageBreakBefore: boundary ? (manual ? undefined : false) : true,
      });
    return (
      <div className={`slide-gap${boundary ? " is-boundary" : ""}`}>
        {insertSlot(index)}
        {boundary ? (
          <button type="button" className="slide-gap-label" onClick={onJumpToFlowField}>
            {t.pageGapLabel((messagePage[next.id] ?? 0) + 1)}
          </button>
        ) : null}
        <button
          type="button"
          className={`slide-break-toggle${boundary ? " is-active" : ""}`}
          data-tip={boundary ? t.slideBreakRemove : t.slideBreakAdd}
          onClick={toggleBreak}
        >
          ✂ {t.slideBreak}
        </button>
      </div>
    );
  };

  return (
    <div className={`message-list${messageDrag !== null ? " is-reordering" : ""}`} ref={listRef}>
      {/* One row of frequent actions; the rest live behind ⋮ so the script
          list keeps the height. The destructive pair (clear, reset) sits in
          the menu on purpose — off the everyday tap path. */}
      <div className="script-io">
        <button type="button" className="script-gallery-open" onClick={onOpenGallery}>
          {t.scriptGalleryOpen}
        </button>
        <button type="button" onClick={onOpenAssist}>
          ✨ {t.assistOpen}
        </button>
        <button type="button" onClick={onExportScript}>
          <DownloadIcon /> {t.exportScript}
        </button>
        <div className="script-menu">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={scriptMenuOpen}
            aria-label={t.scriptMenuAria}
            onClick={() => setScriptMenuOpen((open) => !open)}
          >
            ⋮
          </button>
          {scriptMenuOpen ? (
            <>
              <button
                type="button"
                className="script-menu-backdrop"
                aria-label={t.wizardClose}
                onClick={() => setScriptMenuOpen(false)}
              />
              <div className="script-menu-pop" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() =>
                    void onCopyScript().finally(() =>
                      window.setTimeout(() => setScriptMenuOpen(false), 900),
                    )
                  }
                >
                  <ClipboardIcon /> {scriptCopied ? t.copyScriptDone : t.copyScript}
                </button>
                <label className="script-io-import">
                  <UploadIcon /> {t.importScript}
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) {
                        onImportScript(file);
                      }
                      event.currentTarget.value = "";
                      setScriptMenuOpen(false);
                    }}
                  />
                </label>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setScriptMenuOpen(false);
                    onNewScript();
                  }}
                >
                  ✦ {t.newScript}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setScriptMenuOpen(false);
                    onResetAll();
                  }}
                >
                  ⟲ {t.resetAll}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {importWarnings.length > 0 ? (
        <div className="import-warnings" role="status">
          <header>
            <span>{t.importFixed(importWarnings.length)}</span>
            <button type="button" onClick={onDismissImportWarnings}>
              ×
            </button>
          </header>
          {importWarnings.map((warning, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the warning list is append-only and two identical strings must stay distinct rows
            <p key={index}>• {warning}</p>
          ))}
        </div>
      ) : null}
      <div className="script-budget">
        <span className={totalCharacters > TOTAL_CHARACTER_BUDGET ? "is-over" : ""}>
          {t.totalBudget(totalCharacters, TOTAL_CHARACTER_BUDGET)}
        </span>
        <span>
          {project.messages.length}/{MAX_MESSAGES} msg
        </span>
      </div>
      {project.messages.map((message, index) => (
        <Fragment key={message.id}>
          {undo.rowIndex === index ? inlineUndoRow : null}
          <MessageEditor
            instance={instance}
            message={message}
            index={index}
            t={t}
            onChange={(patch) => updateMessage(message.id, patch)}
            onRemove={() => removeMessage(message.id)}
            onClearContent={() => clearMessageContent(message.id)}
            onRemoveImage={(imageIndex) => removeMessageImage(message.id, imageIndex)}
            onAttach={(file) => void attachImage(message.id, file)}
            onMove={(direction) => moveMessage(message.id, direction)}
            canMoveUp={index > 0}
            canMoveDown={index < project.messages.length - 1}
            onDuplicate={
              project.messages.length < MAX_MESSAGES
                ? () => duplicateMessage(message.id)
                : undefined
            }
            onFocusChange={(focused) => onMessageFocusChange(message.id, focused)}
            onGrab={(event) => startMessageDrag(event, index)}
            dragOffsetPx={dragOffsetFor(index)}
            isDragging={messageDrag?.fromIndex === index}
            isScrubCurrent={currentScrubMessageId === message.id}
            isJustInserted={flashMessageId === message.id}
          />
          {messageSeparator(message, index)}
        </Fragment>
      ))}
      {undo.rowIndex === project.messages.length ? inlineUndoRow : null}
      <div className="insert-end">{insertSlot(project.messages.length - 1)}</div>
    </div>
  );
}
