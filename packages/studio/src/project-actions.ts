/**
 * The project mutation vocabulary: every edit the panels, the stage, and
 * the wizard perform on the script goes through these actions. All of
 * them are setProject wrappers — side effects beyond the project (undo
 * pushes, error surfacing, page resets) arrive through the options.
 */

import { GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import {
  type AppearanceSettings,
  type AttachedImage,
  type ChromeSettings,
  createMessage,
  DEFAULT_PROJECT,
  type DISPLAY_PRESETS,
  type DisplaySettings,
  type FontSlot,
  type FontsSettings,
  MAX_MESSAGE_IMAGES,
  MAX_MESSAGES,
  type MessageRole,
  messageIdToken,
  type PaginationSettings,
  type SessionMessage,
  type SvgentProject,
  type TimingSettings,
} from "@svgent/scene";
import type React from "react";
import { useRef } from "react";
import type { Lang, UiStrings } from "./i18n.js";
import { readAttachedImage } from "./images.js";
import type { ScriptUndoEntry } from "./undo.js";

type DisplayPresetApply = (typeof DISPLAY_PRESETS)[number]["apply"];

export function useProjectActions(options: {
  project: SvgentProject;
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>;
  scriptUndo: { push: (entry: ScriptUndoEntry) => void };
  lang: Lang;
  t: UiStrings;
  onUiError: (error: Error | null) => void;
  /** Pagination edits restart the preview from the first page. */
  onPaginationChange: () => void;
  /** Raised just before a reorder commits — suppresses the list glide. */
  onBeforeReorder: () => void;
}) {
  const { project, setProject, scriptUndo, lang, t, onUiError } = options;
  // Two duplications inside one millisecond would otherwise share an id,
  // which breaks React keys and makes an edit patch both cards.
  const duplicateCount = useRef(0);

  const updateAppearance = <Key extends keyof AppearanceSettings>(
    key: Key,
    value: AppearanceSettings[Key],
  ) => {
    setProject((current) => ({
      ...current,
      appearance: { ...current.appearance, [key]: value },
    }));
  };

  const updateFontChoice = (slot: FontSlot, choice: FontsSettings[FontSlot]) => {
    setProject((current) => ({
      ...current,
      fonts: { ...current.fonts, [slot]: choice },
    }));
  };

  const updateChrome = <Key extends keyof ChromeSettings>(key: Key, value: ChromeSettings[Key]) => {
    setProject((current) => ({ ...current, chrome: { ...current.chrome, [key]: value } }));
  };

  const updateTiming = <Key extends keyof TimingSettings>(key: Key, value: TimingSettings[Key]) => {
    setProject((current) => ({ ...current, timing: { ...current.timing, [key]: value } }));
  };

  const updatePagination = <Key extends keyof PaginationSettings>(
    key: Key,
    value: PaginationSettings[Key],
  ) => {
    setProject((current) => ({
      ...current,
      pagination: { ...current.pagination, [key]: value },
    }));
    options.onPaginationChange();
  };

  const updateDisplay = (key: keyof DisplaySettings, value: boolean) => {
    setProject((current) => ({
      ...current,
      display: { ...current.display, [key]: value },
    }));
  };

  const updateMessage = (messageId: string, patch: Partial<SessionMessage>) => {
    setProject((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId ? { ...message, ...patch } : message,
      ),
    }));
  };

  const removeMessage = (messageId: string) => {
    const index = project.messages.findIndex((message) => message.id === messageId);
    const message = project.messages[index];
    if (!message) {
      return;
    }
    scriptUndo.push({
      kind: "delete",
      message,
      successorId: project.messages[index + 1]?.id ?? null,
      predecessorId: project.messages[index - 1]?.id ?? null,
      index,
    });
    setProject((current) => ({
      ...current,
      messages: current.messages.filter((entry) => entry.id !== messageId),
    }));
  };

  const clearMessageContent = (messageId: string) => {
    const message = project.messages.find((entry) => entry.id === messageId);
    if (!message || message.content.length === 0) {
      return;
    }
    scriptUndo.push({ kind: "clear", messageId, content: message.content });
    updateMessage(messageId, { content: "" });
  };

  const removeMessageImage = (messageId: string, index: number) => {
    const message = project.messages.find((entry) => entry.id === messageId);
    const image = message?.images?.[index];
    if (!message || !image) {
      return;
    }
    scriptUndo.push({ kind: "image-remove", messageId, image, index });
    const rest = (message.images ?? []).filter((_unused, at) => at !== index);
    updateMessage(messageId, { images: rest.length > 0 ? rest : undefined });
  };

  const moveMessage = (messageId: string, direction: -1 | 1) => {
    setProject((current) => {
      const index = current.messages.findIndex((message) => message.id === messageId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.messages.length) {
        return current;
      }
      const messages = [...current.messages];
      const moved = messages[index];
      const other = messages[target];
      if (!moved || !other) {
        return current;
      }
      messages[index] = other;
      messages[target] = moved;
      return { ...current, messages };
    });
  };

  const duplicateMessage = (messageId: string) => {
    setProject((current) => {
      if (current.messages.length >= MAX_MESSAGES) {
        return current;
      }
      const index = current.messages.findIndex((message) => message.id === messageId);
      const source = current.messages[index];
      if (!source) {
        return current;
      }
      const copy = {
        ...source,
        id: `message-${messageIdToken()}-${duplicateCount.current++}-copy`,
      };
      const messages = [...current.messages];
      messages.splice(index + 1, 0, copy);
      return { ...current, messages };
    });
  };

  /** Insert a fresh message after the index; the caller owns menu/flash UI. */
  const insertMessage = (afterIndex: number, role: MessageRole): SessionMessage => {
    const base = createMessage(role, afterIndex + 1, lang);
    const created =
      role === "image" ? { ...base, images: [GENERATED_SAMPLE_IMAGES.generic] } : base;
    setProject((current) => {
      if (current.messages.length >= MAX_MESSAGES) {
        return current;
      }
      const messages = [...current.messages];
      messages.splice(afterIndex + 1, 0, created);
      return { ...current, messages };
    });
    return created;
  };

  const reorderMessage = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= project.messages.length) {
      return;
    }
    // Signal only on a reorder that will actually commit: a flag raised
    // for a no-op would swallow the glide of whatever edit comes next.
    options.onBeforeReorder();
    setProject((current) => {
      if (from >= current.messages.length) {
        return current;
      }
      const messages = [...current.messages];
      const [moved] = messages.splice(from, 1);
      if (!moved) {
        return current;
      }
      messages.splice(Math.min(to, messages.length), 0, moved);
      return { ...current, messages };
    });
  };

  /** Append an image, or swap the picture in one slot (`replaceIndex`). */
  const attachImage = async (messageId: string, file: File, replaceIndex?: number) => {
    try {
      const message = project.messages.find((entry) => entry.id === messageId);
      if (!message) {
        return;
      }
      const image = await readAttachedImage(file, t);
      const existing = message.images ?? [];
      const slot = replaceIndex === undefined ? undefined : existing[replaceIndex];
      let images: AttachedImage[];
      if (slot) {
        // The slot keeps its framing; only the picture changes.
        images = existing.map((entry, index) =>
          index === replaceIndex
            ? { ...image, fit: slot.fit, focus: slot.focus, size: slot.size }
            : entry,
        );
      } else if (message.role === "image") {
        // The generated result is a single picture; attaching replaces it.
        images = [image];
      } else if (existing.length < MAX_MESSAGE_IMAGES) {
        images = [...existing, image];
      } else {
        onUiError(new Error(t.errorTooManyImages(MAX_MESSAGE_IMAGES)));
        return;
      }
      updateMessage(messageId, { images });
      onUiError(null);
    } catch (cause) {
      onUiError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  const attachBackdrop = async (file: File) => {
    try {
      const image = await readAttachedImage(file, t);
      setProject((current) => ({
        ...current,
        appearance: { ...current.appearance, backdropImage: image },
      }));
      onUiError(null);
    } catch (cause) {
      onUiError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  const removeBackdropImage = () => {
    setProject((current) => {
      const { backdropImage: _removed, ...appearance } = current.appearance;
      return { ...current, appearance };
    });
  };

  /**
   * Display presets change only the keys they declare — theme colors and the
   * canvas always survive. Spread wholesale rather than field by field: an
   * explicit list has to be extended every time a preset learns a new key,
   * and when it was not, `messageAlign` and `assistantSurface` were declared
   * by presets and silently dropped here.
   */
  const applyDisplayPreset = (apply: DisplayPresetApply) => {
    const { display, ...appearance } = apply;
    setProject((current) => ({
      ...current,
      appearance: { ...current.appearance, ...appearance },
      ...(display ? { display: { ...display } } : {}),
    }));
  };

  /**
   * Back to the look svgent ships with, script untouched.
   *
   * Written as the keys to *keep*, not the keys to restore: a reset that
   * lists what it resets stops covering the field added after it was written,
   * and the failure is silent. Everything not named here follows the defaults
   * automatically, however the schema grows.
   *
   * The canvas survives because it is an output format rather than a look —
   * a 1200x630 chosen for a link card should not vanish because the colors
   * drifted — and it has its own preset row to change. Pagination survives
   * because how a script divides into pages is an authoring decision.
   */
  const resetAppearance = () => {
    setProject((current) => ({
      ...current,
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        canvasWidth: current.appearance.canvasWidth,
        canvasHeight: current.appearance.canvasHeight,
      },
      display: { ...DEFAULT_PROJECT.display },
      fonts: { ...DEFAULT_PROJECT.fonts },
    }));
  };

  /** Back to the shipped pacing and camera, script untouched. */
  const resetMotion = () => {
    setProject((current) => ({
      ...current,
      timing: { ...DEFAULT_PROJECT.timing },
      camera: { ...DEFAULT_PROJECT.camera },
    }));
  };

  return {
    resetAppearance,
    resetMotion,
    updateAppearance,
    updateFontChoice,
    updateChrome,
    updateTiming,
    updatePagination,
    updateDisplay,
    updateMessage,
    removeMessage,
    clearMessageContent,
    removeMessageImage,
    moveMessage,
    duplicateMessage,
    insertMessage,
    reorderMessage,
    attachImage,
    attachBackdrop,
    removeBackdropImage,
    applyDisplayPreset,
  };
}
