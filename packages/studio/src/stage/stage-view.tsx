/**
 * The rendered canvas and what floats over it: engine notices, the
 * inspector outlines, the compose/answer popover with its IME row, and
 * the inline message editor. Plus the devtool source panel that sits
 * under the stage when the inspector is on.
 */

import { MAX_MESSAGE_CHARS, type SessionMessage, type SvgentProject } from "@svgent/scene";
import type React from "react";
import { DraftMarkupBar } from "../draft-markup.js";
import type { UiStrings } from "../i18n.js";
import { ChevronIcon } from "../icons.js";
import { ROLE_LABELS } from "../message-editor.js";
import { StageHoldChip } from "../notices.js";
import type { StageFlight } from "../stage-flight.js";
import type { SourceView } from "../svg-source-view.js";
import { useSliderDragging, useSteadyMarginRatio } from "./adjusting.js";
import { type OutlineRect, stageStyleFor } from "./hit-testing.js";

export type ImeSelection = { start: number; end: number; text: string };

export type StageInput =
  | {
      kind: "user";
      x: number;
      y: number;
      draft: string;
      selection: ImeSelection | null;
      afterMessageId: string | null;
      beforeMessageId: string | null;
    }
  | {
      kind: "choice";
      x: number;
      y: number;
      draft: string;
      messageId: string;
    };

/** The compose or answer field that opens where the click landed. */
function StageInputPopover({
  input,
  inputRef,
  onDraftChange,
  onSelect,
  onApplyMarkup,
  onSubmit,
  onClose,
  t,
}: {
  input: StageInput | null;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (draft: string) => void;
  onSelect: () => void;
  onApplyMarkup: (next: { value: string; caret: number }) => void;
  onSubmit: () => void;
  onClose: () => void;
  t: UiStrings;
}) {
  if (input === null) {
    return null;
  }
  const title = input.kind === "user" ? t.scrubComposeTitle : t.scrubChoiceTitle;
  return (
    <div
      className="inline-editor stage-input"
      style={{ left: input.x, top: input.y }}
      role="dialog"
      aria-label={title}
    >
      <header>
        <span>{title}</span>
        <button type="button" onClick={onClose}>
          ×
        </button>
      </header>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: this is opened by an explicit click on an input affordance
        autoFocus
        ref={inputRef}
        value={input.draft}
        maxLength={input.kind === "user" ? MAX_MESSAGE_CHARS + 1 : 200}
        rows={4}
        placeholder={input.kind === "user" ? t.scrubComposePlaceholder : t.scrubChoicePlaceholder}
        onChange={(event) => onDraftChange(event.currentTarget.value)}
        onSelect={input.kind === "user" ? onSelect : undefined}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      {input.kind === "user" ? (
        <DraftMarkupBar
          value={input.draft}
          selection={input.selection}
          t={t}
          onApply={onApplyMarkup}
        />
      ) : null}
      {/* Cancel and apply, worded for the field they belong to. */}
      <footer>
        <button type="button" onClick={onClose}>
          {t.scrubInputCancel}
        </button>
        <button
          type="button"
          className="is-primary"
          disabled={
            input.draft.trim().length === 0 ||
            (input.kind === "user" && input.draft.length > MAX_MESSAGE_CHARS)
          }
          onClick={onSubmit}
        >
          {input.kind === "user" ? t.scrubInputAdd : t.scrubInputApply}
        </button>
      </footer>
    </div>
  );
}

/** The message card that opens in place when the canvas text is clicked. */
function InlineMessageEditor({
  edit,
  message,
  messageNumber,
  onContentChange,
  onClose,
  t,
}: {
  edit: { messageId: string; x: number; y: number } | null;
  message: SessionMessage | null;
  messageNumber: number;
  onContentChange: (content: string) => void;
  onClose: () => void;
  t: UiStrings;
}) {
  if (!edit || !message) {
    return null;
  }
  return (
    <div
      className="inline-editor"
      style={{ left: edit.x, top: edit.y }}
      role="dialog"
      aria-label={t.inlineEditAria}
    >
      <header>
        <span>
          {String(messageNumber).padStart(2, "0")} · {ROLE_LABELS[message.role]}
        </span>
        <button type="button" onClick={onClose} aria-label={t.inlineEditClose}>
          {t.inlineEditDone}
        </button>
      </header>
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the textarea appears only after an explicit edit action; focusing it is the expected next step
        autoFocus
        value={message.content}
        maxLength={MAX_MESSAGE_CHARS + 1}
        rows={message.role === "assistant" ? 7 : 3}
        onChange={(event) => onContentChange(event.currentTarget.value)}
        aria-label={t.inlineEditContent}
      />
    </div>
  );
}

export function PreviewStage({
  stageRef,
  shellRef,
  project,
  engineState,
  previewError,
  previewNode,
  stageFlight,
  stageZoom,
  onResetZoom,
  previewPaused,
  playing,
  canEditInline,
  showSvgInspector,
  sourceHeight,
  editFollowActive,
  fieldFlash,
  editHover,
  hoverOutline,
  pinnedOutline,
  inspectedNodeId,
  onClick,
  onHover,
  onLeave,
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  stageInput,
  stageInputRef,
  stageInputHandlers,
  inlineEdit,
  inlineEditMessage,
  inlineEditNumber,
  onInlineEditContentChange,
  onInlineEditClose,
  t,
}: {
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** This studio's own root, so a slider held next door is not this one's. */
  shellRef: React.RefObject<HTMLElement | null>;
  project: SvgentProject;
  /** Loading and error states are drawn over the canvas, not beside it. */
  engineState: { status: "loading" } | { status: "ready" } | { status: "error"; error: Error };
  previewError: Error | null;
  /** The memoized SVG node; identity is what keeps the animations alive. */
  previewNode: React.ReactNode;
  stageFlight: StageFlight | null;
  stageZoom: { scale: number; txPx: number; tyPx: number };
  onResetZoom: () => void;
  previewPaused: boolean;
  playing: boolean;
  canEditInline: boolean;
  showSvgInspector: boolean;
  sourceHeight: number;
  editFollowActive: boolean;
  fieldFlash: OutlineRect | null;
  editHover: OutlineRect | null;
  hoverOutline: OutlineRect | null;
  pinnedOutline: OutlineRect | null;
  inspectedNodeId: string | null;
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onHover: (event: React.MouseEvent<HTMLDivElement>) => void;
  onLeave: () => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerEnd: (event: React.PointerEvent) => void;
  stageInput: StageInput | null;
  stageInputRef: React.RefObject<HTMLTextAreaElement | null>;
  stageInputHandlers: {
    onDraftChange: (draft: string) => void;

    onSelect: () => void;
    onApplyMarkup: (next: { value: string; caret: number }) => void;
    onSubmit: () => void;
    onClose: () => void;
  };
  inlineEdit: { messageId: string; x: number; y: number } | null;
  inlineEditMessage: SessionMessage | null;
  inlineEditNumber: number;
  onInlineEditContentChange: (content: string) => void;
  onInlineEditClose: () => void;
  t: UiStrings;
}) {
  // The phone stage sizes itself from the window margin, so a live update
  // would resize the sticky header the slider sits under. Hold it steady
  // until the thumb is released; the artwork inside still updates.
  const dragging = useSliderDragging(shellRef);
  const steadyMarginRatio = useSteadyMarginRatio(
    project.appearance.windowMargin / project.appearance.canvasWidth,
    dragging,
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: click-to-inspect overlay on the rendered SVG; editing is equally available through the script panel forms
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicks map pointer coordinates to SVG nodes, which has no keyboard equivalent
    <div
      ref={stageRef}
      className={`preview-stage${stageFlight !== null ? " is-flying" : ""}${
        previewPaused ? " is-paused" : ""
      }`}
      data-transparent={project.appearance.transparentCanvas}
      data-edit-mode={canEditInline}
      data-scrub-mode={!playing}
      data-inspect-mode={showSvgInspector}
      style={stageStyleFor({
        appearance: project.appearance,
        marginRatio: steadyMarginRatio,
        stageZoom,
        stageFlight,
        showSvgInspector,
        sourceHeight,
      })}
      onClick={onClick}
      onMouseMove={onHover}
      onMouseLeave={onLeave}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {engineState.status === "loading" ? (
        <div className="preview-notice">{t.loadingNotice}</div>
      ) : engineState.status === "error" ? (
        <div className="preview-notice is-error">{engineState.error.message}</div>
      ) : previewError ? (
        <div className="preview-notice is-error">{previewError.message}</div>
      ) : (
        previewNode
      )}
      {editFollowActive ? <StageHoldChip shellRef={shellRef} t={t} /> : null}
      {stageZoom.scale > 1 ? (
        <button
          type="button"
          className="stage-zoom-reset"
          aria-label={t.stageZoomReset}
          onClick={onResetZoom}
        >
          1×
        </button>
      ) : null}
      {fieldFlash ? <div className="field-flash" style={fieldFlash} /> : null}
      {editHover && !showSvgInspector ? (
        <div className="edit-hover-outline" style={editHover} />
      ) : null}
      {hoverOutline ? <div className="inspect-outline is-hover" style={hoverOutline} /> : null}
      {pinnedOutline ? (
        <div className="inspect-outline is-pinned" style={pinnedOutline}>
          <span>{inspectedNodeId}</span>
        </div>
      ) : null}
      <StageInputPopover
        input={stageInput}
        inputRef={stageInputRef}
        onDraftChange={stageInputHandlers.onDraftChange}
        onSelect={stageInputHandlers.onSelect}
        onApplyMarkup={stageInputHandlers.onApplyMarkup}
        onSubmit={stageInputHandlers.onSubmit}
        onClose={stageInputHandlers.onClose}
        t={t}
      />
      <InlineMessageEditor
        edit={inlineEdit}
        message={inlineEditMessage}
        messageNumber={inlineEditNumber}
        onContentChange={onInlineEditContentChange}
        onClose={onInlineEditClose}
        t={t}
      />
    </div>
  );
}

/** The generated SVG source, with the node the click resolved to selected. */
export function SvgInspector({
  open,
  sourceView,
  sourceBytes,
  inspectedNodeId,
  sourceHeight,
  sourceMinPx,
  sourceMaxPx,
  onResizeStart,
  onToggleExpand,
  t,
}: {
  open: boolean;
  sourceView: SourceView | null;
  /** Length of the generated markup, shown as the panel's size readout. */
  sourceBytes: number;
  inspectedNodeId: string | null;
  sourceHeight: number;
  sourceMinPx: number;
  sourceMaxPx: number;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onToggleExpand: () => void;
  t: UiStrings;
}) {
  if (!open) {
    return null;
  }
  const expanded = sourceHeight >= sourceMaxPx - 40;
  return (
    <section
      className="svg-inspector"
      aria-label={t.inspectorAria}
      style={{ minHeight: sourceHeight }}
    >
      {/* biome-ignore lint/a11y/useFocusableInteractive: pointer-only drag affordance; the expand button provides the accessible size control */}
      <div
        className="source-resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t.sourceResizeAria}
        aria-valuenow={Math.round(sourceHeight)}
        aria-valuemin={sourceMinPx}
        aria-valuemax={sourceMaxPx}
        onPointerDown={onResizeStart}
      />
      <header>
        <span className="source-info">
          SVG source · {Math.round(sourceBytes / 1024)} KB
          {inspectedNodeId ? ` · ${inspectedNodeId}` : ` · ${t.inspectorIdleHint}`}
        </span>
        <button
          type="button"
          className="source-expand"
          aria-label={expanded ? t.sourceShrink : t.sourceExpand}
          data-tip={expanded ? t.sourceShrink : t.sourceExpand}
          onClick={onToggleExpand}
        >
          <ChevronIcon direction={expanded ? "down" : "up"} />
        </button>
      </header>
      <pre className="svg-source">
        {sourceView?.parts.map((part) =>
          "target" in part && part.target ? (
            <code
              key={part.key}
              className="source-target"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: Prism output over SVG source we generated ourselves
              dangerouslySetInnerHTML={{ __html: part.html }}
            />
          ) : (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: Prism output over SVG source we generated ourselves
            <code key={part.key} dangerouslySetInnerHTML={{ __html: part.html }} />
          ),
        )}
        {sourceView?.truncated ? <span className="source-ellipsis">{t.sourceEllipsis}</span> : null}
      </pre>
    </section>
  );
}
