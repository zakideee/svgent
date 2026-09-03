/**
 * What a click on the rendered canvas does. Scene actions (choice picks,
 * permission decisions, image replacement, the composer) and the
 * click-to-edit resolution both start here; the caller supplies the
 * state they land in through one controller object.
 */

import type { SceneAction } from "@svgent/scene";
import { MAX_MESSAGES, type SessionMessage, type SvgentProject } from "@svgent/scene";
import type React from "react";
import type { UiStrings } from "../i18n.js";
import {
  findInspectable,
  META_ACTION_ATTR,
  META_EDIT_ATTR,
  META_IMAGE_INDEX_ATTR,
  META_MESSAGE_ID_ATTR,
  META_OPTION_INDEX_ATTR,
  NODE_ID_ATTR,
  type OutlineRect,
  outlineRectFor,
  rectHitMetaTarget,
  sameOutlineRect,
  stageInputPosition,
} from "./hit-testing.js";

type StageHit = {
  action: SceneAction;
  element: Element;
  event: React.MouseEvent<HTMLDivElement>;
};

/** Where a stage interaction puts the user next. */
type StageController = {
  project: SvgentProject;
  t: UiStrings;
  /** Modes that gate what a click means; all three come from App state. */
  mode: { showSvgInspector: boolean; canEditInline: boolean; playing: boolean };
  /** The message the scrub clock currently sits on, for composer anchoring. */
  currentScrubMessageId: string | null;
  /** The first message in the timeline, the anchor when nothing is current. */
  firstMessageId: string | null;
  /** Touch never edits from the canvas — it owns zoom and pan instead. */
  lastPointerTypeRef: React.RefObject<string>;
  updateMessage: (messageId: string, patch: Partial<SessionMessage>) => void;
  onUiError: (error: Error) => void;
  /** The stage's own editing affordances: the popover and the inline card. */
  edit: {
    setStageInput: (
      input:
        | { kind: "choice"; x: number; y: number; draft: string; messageId: string }
        | {
            kind: "user";
            x: number;
            y: number;
            draft: string;
            selection: null;
            afterMessageId: string | null;
            beforeMessageId: string | null;
          }
        | null,
    ) => void;
    setInlineEdit: (edit: { messageId: string; x: number; y: number } | null) => void;
  };
  /** The devtool inspector's selection and its two outlines. */
  inspect: {
    setInspectedNodeId: (nodeId: string | null) => void;
    setPinnedOutline: (outline: OutlineRect | null) => void;
    setHoverOutline: (update: (current: OutlineRect | null) => OutlineRect | null) => void;
    setEditHover: (update: (current: OutlineRect | null) => OutlineRect | null) => void;
  };
  /** Chrome fields and choice blocks are edited by their panel control. */
  navigate: {
    jumpToSceneField: (fieldKey: string) => void;
    jumpToMessageCard: (messageId: string) => void;
    pauseAtMessage: (messageId: string) => void;
  };
  /** The file input lives in App; the stage only names the slot to fill. */
  onReplaceImage: (messageId: string, imageIndex: number) => void;
};

export function useStageActions(controller: StageController) {
  const { project, t, mode, lastPointerTypeRef, updateMessage, onUiError } = controller;
  const { setStageInput, setInlineEdit } = controller.edit;
  const { setInspectedNodeId, setPinnedOutline, setHoverOutline, setEditHover } =
    controller.inspect;

  const handleChoiceAction = (message: SessionMessage, hit: StageHit): boolean => {
    if (message.role !== "choice") {
      return false;
    }
    if (hit.action === "write-choice") {
      setInlineEdit(null);
      setStageInput({
        kind: "choice",
        ...stageInputPosition(hit.event),
        draft: message.freeform ?? "",
        messageId: message.id,
      });
      return true;
    }
    const index = Number(hit.element.getAttribute(META_OPTION_INDEX_ATTR));
    if (Number.isInteger(index) && index >= 0 && index < (message.options?.length ?? 0)) {
      updateMessage(message.id, { chosenIndex: index, freeform: "" });
    }
    setStageInput(null);
    setInlineEdit(null);
    return true;
  };

  /** Scene actions that need the message the click landed on. */
  const handleMessageAction = (message: SessionMessage, hit: StageHit): boolean => {
    const { action } = hit;
    switch (action) {
      case "select-choice":
      case "write-choice":
        return handleChoiceAction(message, hit);
      case "approve":
      case "approve-always":
      case "deny":
        if (message.role !== "permission") {
          return false;
        }
        updateMessage(message.id, {
          decision:
            action === "deny" ? "deny" : action === "approve-always" ? "allow-always" : "allow",
        });
        return true;
      case "replace-image": {
        const imageIndex = Number(hit.element.getAttribute(META_IMAGE_INDEX_ATTR));
        controller.onReplaceImage(
          message.id,
          Number.isInteger(imageIndex) && imageIndex >= 0 ? imageIndex : 0,
        );
        return true;
      }
      default:
        return false;
    }
  };

  const handleSceneAction = (
    action: SceneAction,
    element: Element,
    event: React.MouseEvent<HTMLDivElement>,
  ): boolean => {
    if (action === "compose-user") {
      if (project.messages.length >= MAX_MESSAGES) {
        onUiError(new Error(t.issueMaxMessages(MAX_MESSAGES)));
        return true;
      }
      setInlineEdit(null);
      setStageInput({
        kind: "user",
        ...stageInputPosition(event),
        draft: "",
        selection: null,
        afterMessageId: controller.currentScrubMessageId,
        beforeMessageId:
          controller.currentScrubMessageId === null ? controller.firstMessageId : null,
      });
      return true;
    }
    const messageId = element.getAttribute(META_MESSAGE_ID_ATTR);
    const message =
      messageId === null
        ? null
        : (project.messages.find((candidate) => candidate.id === messageId) ?? null);
    if (!message) {
      return false;
    }
    return handleMessageAction(message, { action, element, event });
  };

  /**
   * Resolve and open the editor for whatever sits at (x, y) on the stage —
   * the shared tail of a desktop click and a touch long-press. Chrome
   * fields and choice blocks are one element each, so they jump to the
   * panel control that edits the whole thing; plain messages edit inline.
   */
  const openStageEditorAt = (stage: HTMLElement, point: { x: number; y: number }): void => {
    const editable = rectHitMetaTarget(stage, {
      ...point,
      selector: `[${META_EDIT_ATTR}]`,
    });
    if (!editable) {
      setInlineEdit(null);
      setStageInput(null);
      return;
    }
    const editTarget = editable.getAttribute(META_EDIT_ATTR);
    if (!editTarget) {
      return;
    }
    if (editTarget.startsWith("field:")) {
      controller.navigate.jumpToSceneField(editTarget.slice("field:".length));
      return;
    }
    const message = project.messages.find((entry) => entry.id === editTarget);
    if (!message) {
      return;
    }
    controller.navigate.pauseAtMessage(editTarget);
    if (message.options?.length) {
      controller.navigate.jumpToMessageCard(editTarget);
      return;
    }
    const stageRect = stage.getBoundingClientRect();
    setStageInput(null);
    setInlineEdit({
      messageId: editTarget,
      x: Math.min(Math.max(8, point.x - stageRect.left - 190), Math.max(8, stageRect.width - 396)),
      y: Math.min(Math.max(8, point.y - stageRect.top + 14), Math.max(8, stageRect.height - 200)),
    });
  };

  const handleStageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Touch never edits from the canvas: aiming at a message in a phone
    // viewport is guesswork, and a pinch can end in a synthesized click
    // that used to pop the editor mid-zoom. Touch owns zoom and pan;
    // editing stays in the script panel and the guide's edit step.
    if (lastPointerTypeRef.current === "touch") {
      return;
    }
    const target = event.target as Element;
    if (target.closest(".inline-editor")) {
      return;
    }
    if (mode.showSvgInspector) {
      const node = findInspectable(target);
      if (!node) {
        setInspectedNodeId(null);
        setPinnedOutline(null);
        return;
      }
      setInspectedNodeId(node.getAttribute(NODE_ID_ATTR));
      setPinnedOutline(outlineRectFor(node, event.currentTarget));
      return;
    }
    if (!mode.canEditInline) {
      return;
    }
    if (!mode.playing) {
      const actionable = rectHitMetaTarget(event.currentTarget, {
        x: event.clientX,
        y: event.clientY,
        selector: `[${META_ACTION_ATTR}]`,
      });
      const action = actionable?.getAttribute(META_ACTION_ATTR) as SceneAction | null;
      if (actionable && action && handleSceneAction(action, actionable, event)) {
        return;
      }
    }
    openStageEditorAt(event.currentTarget, { x: event.clientX, y: event.clientY });
  };

  const handleStageHover = (event: React.MouseEvent<HTMLDivElement>) => {
    if (mode.showSvgInspector) {
      const node = findInspectable(event.target as Element);
      const outline = node ? outlineRectFor(node, event.currentTarget) : null;
      setHoverOutline((current) => sameOutlineRect(current, outline));
      return;
    }
    // The editable surface announces itself: whatever the pointer rests on
    // that a click would edit gets an outline, chrome fields included.
    if (!mode.canEditInline || lastPointerTypeRef.current === "touch") {
      return;
    }
    const editable = rectHitMetaTarget(event.currentTarget, {
      x: event.clientX,
      y: event.clientY,
      selector: `[${META_EDIT_ATTR}]`,
    });
    const outline = editable ? outlineRectFor(editable, event.currentTarget) : null;
    setEditHover((current) => sameOutlineRect(current, outline));
  };

  return { handleStageClick, handleStageHover, openStageEditorAt };
}
