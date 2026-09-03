import {
  type AttachedImage,
  IMAGE_ROLES,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGE_IMAGES,
  type MessageRole,
  type SessionMessage,
} from "@svgent/scene";

/** The decisions the permission select offers, in the order it shows them. */
const PERMISSION_DECISIONS: Array<NonNullable<SessionMessage["decision"]>> = [
  "allow",
  "allow-always",
  "deny",
];

/**
 * One character past the budget so the over-limit counter is reachable by
 * typing; the field still refuses anything beyond that.
 */
const OVER_BUDGET_TYPING_SLACK = 1;

import { useRef, useState } from "react";
import { DraftMarkupBar, type DraftSelection, readSelection } from "./draft-markup.js";
import type { UiStrings } from "./i18n.js";
import { GripIcon, RoleIcon, TrashIcon } from "./icons.js";
import { IMAGE_ACCEPT } from "./images.js";

export const ROLE_LABELS: Record<MessageRole, string> = {
  user: "User",
  thinking: "Thinking",
  tool: "Tool activity",
  permission: "Permission",
  assistant: "Assistant",
  image: "Image gen",
  choice: "Choice",
};

function PermissionDecisionField({
  message,
  t,
  onChange,
}: {
  message: SessionMessage;
  t: UiStrings;
  onChange: (patch: Partial<SessionMessage>) => void;
}) {
  return (
    <label className="permission-decision">
      <span>{t.permissionDecision}</span>
      <select
        value={message.decision ?? "allow"}
        onChange={(event) => {
          const decision = PERMISSION_DECISIONS.find(
            (candidate) => candidate === event.currentTarget.value,
          );
          if (decision) {
            onChange({ decision });
          }
        }}
      >
        <option value="allow">{t.permissionAllow}</option>
        <option value="allow-always">{t.permissionAllowAlways}</option>
        <option value="deny">{t.permissionDeny}</option>
      </select>
    </label>
  );
}

/** The footer's attach entry: append for bubbles, replace for image gen. */
function AttachImageLabel({
  message,
  t,
  onAttach,
}: {
  message: SessionMessage;
  t: UiStrings;
  onAttach: (file: File) => void;
}) {
  const images = message.images ?? [];
  // Roles that never render an image don't invite one; existing data can
  // still be managed (and removed) through the list below.
  if (!IMAGE_ROLES.includes(message.role)) {
    return null;
  }
  if (message.role !== "image" && images.length >= MAX_MESSAGE_IMAGES) {
    return null;
  }
  const label =
    message.role === "image" ? t.replaceImage : images.length === 0 ? t.attachImage : t.addImage;
  return (
    <label className="file-label" data-tip={t.attachImageHint}>
      {label}
      <input
        type="file"
        accept={IMAGE_ACCEPT}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) {
            onAttach(file);
          }
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

/** One row per attached image: thumbnail, framing controls, remove. */
function MessageImageList({
  message,
  t,
  onChange,
  onRemoveImage,
}: {
  message: SessionMessage;
  t: UiStrings;
  onChange: (patch: Partial<SessionMessage>) => void;
  onRemoveImage: (index: number) => void;
}) {
  const images = message.images ?? [];
  if (images.length === 0) {
    return null;
  }
  const patchImage = (at: number, patch: Partial<AttachedImage>) =>
    onChange({
      images: images.map((image, index) => (index === at ? { ...image, ...patch } : image)),
    });
  return (
    <div className="image-list">
      {IMAGE_ROLES.includes(message.role) ? null : (
        <small className="image-list-note">{t.imagesHiddenForRole}</small>
      )}
      {images.map((image, imageIndex) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: image rows are positional by definition
          key={imageIndex}
          className="image-row"
        >
          <img src={image.dataUrl} alt="" />
          {/* The generated result renders full-bleed in its own frame, so
              framing controls apply to bubble banners only. */}
          {message.role === "image" ? null : (
            <>
              <select
                value={image.fit ?? "cover"}
                aria-label={t.imageFitAria(imageIndex + 1)}
                onChange={(event) =>
                  patchImage(imageIndex, {
                    fit: event.currentTarget.value === "contain" ? "contain" : "cover",
                  })
                }
              >
                <option value="cover">{t.imageFitCover}</option>
                <option value="contain">{t.imageFitContain}</option>
              </select>
              <select
                value={image.focus ?? "center"}
                aria-label={t.imageFocusAria(imageIndex + 1)}
                disabled={(image.fit ?? "cover") === "contain"}
                onChange={(event) =>
                  patchImage(imageIndex, {
                    focus:
                      event.currentTarget.value === "top" || event.currentTarget.value === "bottom"
                        ? event.currentTarget.value
                        : "center",
                  })
                }
              >
                <option value="top">{t.imageFocusTop}</option>
                <option value="center">{t.imageFocusCenter}</option>
                <option value="bottom">{t.imageFocusBottom}</option>
              </select>
              <select
                value={image.size ?? "standard"}
                aria-label={t.imageSizeAria(imageIndex + 1)}
                onChange={(event) =>
                  patchImage(imageIndex, {
                    size:
                      event.currentTarget.value === "small" || event.currentTarget.value === "large"
                        ? event.currentTarget.value
                        : "standard",
                  })
                }
              >
                <option value="small">{t.imageSizeSmall}</option>
                <option value="standard">{t.imageSizeStandard}</option>
                <option value="large">{t.imageSizeLarge}</option>
              </select>
            </>
          )}
          <button
            type="button"
            className="message-action message-action-delete"
            aria-label={t.removeImageAria(imageIndex + 1)}
            data-tip={t.removeImage}
            onClick={() => onRemoveImage(imageIndex)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/** The editable option list a choice message offers, with add and remove controls. */
/**
 * The answer a picker is given in the user's own words. It is keyed at the
 * composer like any user line, so it stages conversions and completions the
 * same way — the bar appears once something in it is selected.
 */
function FreeformField({
  message,
  t,
  onChange,
}: {
  message: SessionMessage;
  t: UiStrings;
  onChange: (patch: Partial<SessionMessage>) => void;
}) {
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const [selection, setSelection] = useState<DraftSelection | null>(null);
  return (
    <>
      <input
        ref={fieldRef}
        className="choice-freeform"
        type="text"
        value={message.freeform ?? ""}
        placeholder={t.freeformPlaceholder}
        maxLength={200}
        onChange={(event) => {
          onChange({ freeform: event.currentTarget.value });
          setSelection(null);
        }}
        onSelect={() => setSelection(readSelection(fieldRef.current))}
      />
      <DraftMarkupBar
        value={message.freeform ?? ""}
        selection={selection}
        t={t}
        onApply={(next) => {
          onChange({ freeform: next.value });
          setSelection(null);
          requestAnimationFrame(() => {
            fieldRef.current?.focus();
            fieldRef.current?.setSelectionRange(next.caret, next.caret);
          });
        }}
      />
    </>
  );
}

function choiceOptionList(options: {
  message: SessionMessage;
  t: UiStrings;
  onChange: (patch: Partial<SessionMessage>) => void;
  /**
   * A radio group's `name` is scoped to the form it sits in, and there is no
   * form here — so it groups across the whole document. Two studios both
   * showing the default script carry the same message ids, and their option
   * lists would merge into one group: one tab stop between them, with arrow
   * keys walking focus into the other studio's card.
   */
  instance: string;
}): React.ReactNode {
  const { message, t, onChange, instance } = options;
  return (
    <div className="choice-options">
      {(message.options ?? []).map((option, optionIndex) => (
        <label
          // biome-ignore lint/suspicious/noArrayIndexKey: options are positional
          key={optionIndex}
          className={`choice-option${
            (message.freeform ?? "").length === 0 && (message.chosenIndex ?? 0) === optionIndex
              ? " is-chosen"
              : ""
          }`}
        >
          <input
            type="radio"
            name={`choice-${instance}-${message.id}`}
            checked={
              (message.freeform ?? "").length === 0 && (message.chosenIndex ?? 0) === optionIndex
            }
            onChange={() => onChange({ chosenIndex: optionIndex, freeform: "" })}
          />
          <input
            type="text"
            value={option}
            placeholder={t.choiceOptionPlaceholder}
            maxLength={120}
            onChange={(event) => {
              const next = [...(message.options ?? [])];
              next[optionIndex] = event.currentTarget.value;
              onChange({ options: next });
            }}
          />
          <button
            type="button"
            aria-label={t.choiceOptionRemove}
            data-tip={t.choiceOptionRemove}
            onClick={() => {
              const options = (message.options ?? []).filter((_o, i) => i !== optionIndex);
              // Keep the selection on the same option: removing an earlier
              // row shifts it left; removing the chosen row clamps to the
              // nearest remaining one (matching the scene-side clamp).
              const chosen = message.chosenIndex ?? 0;
              const chosenIndex = Math.max(
                0,
                Math.min(optionIndex < chosen ? chosen - 1 : chosen, options.length - 1),
              );
              onChange({ options, chosenIndex });
            }}
          >
            ✕
          </button>
        </label>
      ))}
      {(message.options ?? []).length < 5 ? (
        <button
          type="button"
          className="choice-option-add"
          onClick={() => onChange({ options: [...(message.options ?? []), ""] })}
        >
          + {t.choiceOptionAdd}
        </button>
      ) : null}
      {(message.freeform ?? "").length > 0 ? (
        <FreeformField message={message} t={t} onChange={onChange} />
      ) : null}
    </div>
  );
}

export function MessageEditor({
  instance,
  message,
  index,
  t,
  onChange,
  onRemove,
  onClearContent,
  onRemoveImage,
  onAttach,
  onMove,
  canMoveUp,
  canMoveDown,
  onDuplicate,
  onFocusChange,
  onGrab,
  dragOffsetPx = 0,
  isDragging = false,
  isScrubCurrent = false,
  isJustInserted = false,
}: {
  /** The owning studio's identity; see `choiceOptionList`. */
  instance: string;
  message: SessionMessage;
  index: number;
  t: UiStrings;
  onChange: (patch: Partial<SessionMessage>) => void;
  onRemove: () => void;
  /** Empty the message's text (an undoable act, unlike typing it away). */
  onClearContent: () => void;
  /** Remove one attached image by position (an undoable act). */
  onRemoveImage: (index: number) => void;
  onAttach: (file: File) => void;
  onMove: (direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onDuplicate?: (() => void) | undefined;
  onFocusChange: (focused: boolean) => void;
  /** Pointer-down on the grip: the parent runs the live-sort drag. */
  onGrab: (event: React.PointerEvent) => void;
  /** Vertical shift while a sibling is being dragged past this card. */
  dragOffsetPx?: number;
  isDragging?: boolean;
  isScrubCurrent?: boolean;
  /** Freshly inserted from the role menu: glow once so the insert is visible. */
  isJustInserted?: boolean;
}) {
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const [selection, setSelection] = useState<DraftSelection | null>(null);
  return (
    <article
      className={`message-editor role-${message.role}${isScrubCurrent ? " is-scrub-current" : ""}${
        isDragging ? " is-dragging" : ""
      }${isJustInserted ? " is-just-inserted" : ""}${
        message.content.trim() === "" ? " is-empty" : ""
      }`}
      data-message-id={message.id}
      aria-current={isScrubCurrent ? "step" : undefined}
      style={
        dragOffsetPx !== 0 || isDragging
          ? { transform: `translateY(${dragOffsetPx}px)` }
          : undefined
      }
    >
      <header>
        {/* The index chip doubles as the drag handle so reordering by drag
            never fights text selection inside the textarea; the grip dots
            make the grabbable spot visible. The ↑/↓ buttons remain the
            keyboard-accessible path. */}
        <span className="drag-handle" onPointerDown={onGrab} data-tip={t.dragToReorder}>
          <GripIcon />
          {String(index + 1).padStart(2, "0")}
        </span>
        {/* The stripe color repeated as a shape, so a long script scans by
            glyph instead of by reading each row's label. */}
        <span className="role-icon" aria-hidden="true">
          <RoleIcon role={message.role} />
        </span>
        <select
          value={message.role}
          aria-label={t.messageRoleAria(index + 1)}
          onChange={(event) => {
            const role = (Object.keys(ROLE_LABELS) as MessageRole[]).find(
              (candidate) => candidate === event.currentTarget.value,
            );
            if (role) {
              onChange({ role });
            }
          }}
        >
          {(Object.keys(ROLE_LABELS) as MessageRole[]).map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={t.moveMessageUp(index + 1)}
          disabled={!canMoveUp}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={t.moveMessageDown(index + 1)}
          disabled={!canMoveDown}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="message-action message-action-duplicate"
          aria-label={t.duplicateMessage(index + 1)}
          data-tip={t.duplicateMessage(index + 1)}
          disabled={!onDuplicate}
          onClick={() => onDuplicate?.()}
        >
          ⧉
        </button>
        <button
          type="button"
          className="message-action message-action-delete"
          aria-label={t.deleteMessage(index + 1)}
          data-tip={t.deleteMessage(index + 1)}
          onClick={onRemove}
        >
          {/* A trash can, not an ×: next to a text field, × reads as
              "clear the text" and got the whole card deleted by mistake. */}
          <TrashIcon />
        </button>
      </header>
      <textarea
        ref={contentRef}
        value={message.content}
        maxLength={MAX_MESSAGE_CHARS + OVER_BUDGET_TYPING_SLACK}
        rows={message.role === "assistant" ? 6 : 2}
        onChange={(event) => {
          onChange({ content: event.currentTarget.value });
          setSelection(null);
        }}
        onSelect={() => setSelection(readSelection(contentRef.current))}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        aria-label={t.messageContentAria(index + 1)}
      />
      {/* Only a user line is typed into a composer, so only a user line has
          keystrokes to stage. */}
      {message.role === "user" ? (
        <DraftMarkupBar
          value={message.content}
          selection={selection}
          t={t}
          onApply={(next) => {
            onChange({ content: next.value });
            setSelection(null);
            requestAnimationFrame(() => {
              contentRef.current?.focus();
              contentRef.current?.setSelectionRange(next.caret, next.caret);
            });
          }}
        />
      ) : null}
      <footer>
        <span className={message.content.length > MAX_MESSAGE_CHARS ? "is-over" : ""}>
          {message.content.length}/{MAX_MESSAGE_CHARS}
        </span>
        {message.content.trim() === "" ? <span className="empty-hint">{t.emptyHint}</span> : null}
        {/* Emptying a textarea by hand is a chore on touch; the footer
            clears it in one tap, with the undo notice as the safety net. */}
        {message.content.length > 0 ? (
          <button
            type="button"
            className="clear-content"
            aria-label={t.clearContentAria(index + 1)}
            onClick={onClearContent}
          >
            {t.clearContent}
          </button>
        ) : null}
        <AttachImageLabel message={message} t={t} onAttach={onAttach} />
        {message.role === "choice" ? (
          <label className="decision-toggle">
            <input
              type="checkbox"
              checked={(message.freeform ?? "").length > 0}
              onChange={(event) =>
                onChange({ freeform: event.currentTarget.checked ? t.freeformSample : "" })
              }
            />
            {t.freeformAnswer}
          </label>
        ) : null}
        {message.role === "user" ? (
          <label className="decision-toggle">
            <input
              type="checkbox"
              checked={message.inputMode === "voice"}
              onChange={(event) =>
                onChange({ inputMode: event.currentTarget.checked ? "voice" : undefined })
              }
            />
            {t.voiceInputToggle}
          </label>
        ) : null}
        {message.role === "permission" ? (
          <PermissionDecisionField message={message} t={t} onChange={onChange} />
        ) : null}
        {message.role === "thinking" ? (
          <label className="decision-toggle">
            <input
              type="checkbox"
              checked={message.highlight === true}
              onChange={(event) =>
                onChange({ highlight: event.currentTarget.checked ? true : undefined })
              }
            />
            {t.highlightToggle}
          </label>
        ) : null}
      </footer>
      <MessageImageList message={message} t={t} onChange={onChange} onRemoveImage={onRemoveImage} />
      {message.role === "choice" ? choiceOptionList({ message, t, onChange, instance }) : null}
    </article>
  );
}
