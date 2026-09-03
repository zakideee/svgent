/**
 * The undo net under destructive script edits: entry shapes, anchor-based
 * restore placement, and the expiring stack hook.
 */

import type { AttachedImage, SessionMessage, SvgentProject } from "@svgent/scene";
import type React from "react";
import { useEffect, useRef, useState } from "react";

/** How long a delete or clear stays undoable; pushes and undos re-arm it. */
const UNDO_NOTICE_MS = 8_000;

/** One undoable script edit: a deleted message, emptied text, or removed image. */
export type ScriptUndoEntry =
  | {
      kind: "delete";
      message: SessionMessage;
      /** Restore anchors, most-specific first: before the message that
          followed, after the one that preceded, else the old index — so
          inserts, reorders, and other deletes inside the undo window
          cannot misplace the restored card. */
      successorId: string | null;
      predecessorId: string | null;
      index: number;
    }
  | { kind: "clear"; messageId: string; content: string }
  | { kind: "image-remove"; messageId: string; image: AttachedImage; index: number };

/** Whether the entry still has anything to restore in this message list. */
function isUndoApplicable(entry: ScriptUndoEntry, messages: SessionMessage[]): boolean {
  return entry.kind === "delete"
    ? !messages.some((message) => message.id === entry.message.id)
    : messages.some((message) => message.id === entry.messageId);
}

/** Where a deleted message goes back, by its anchors. */
export function restoreIndexFor(
  entry: { successorId: string | null; predecessorId: string | null; index: number },
  messages: SessionMessage[],
): number {
  const successorAt = entry.successorId
    ? messages.findIndex((message) => message.id === entry.successorId)
    : -1;
  if (successorAt !== -1) {
    return successorAt;
  }
  const predecessorAt = entry.predecessorId
    ? messages.findIndex((message) => message.id === entry.predecessorId)
    : -1;
  if (predecessorAt !== -1) {
    return predecessorAt + 1;
  }
  return Math.min(entry.index, messages.length);
}

/** Put one undone edit back into the script. */
function applyUndoEntry(
  entry: ScriptUndoEntry,
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>,
): void {
  if (entry.kind === "delete") {
    setProject((current) => {
      const messages = [...current.messages];
      messages.splice(restoreIndexFor(entry, messages), 0, entry.message);
      return { ...current, messages };
    });
    return;
  }
  if (entry.kind === "image-remove") {
    setProject((current) => ({
      ...current,
      messages: current.messages.map((message) => {
        if (message.id !== entry.messageId) {
          return message;
        }
        const images = [...(message.images ?? [])];
        images.splice(Math.min(entry.index, images.length), 0, entry.image);
        return { ...message, images };
      }),
    }));
    return;
  }
  setProject((current) => ({
    ...current,
    messages: current.messages.map((message) =>
      message.id === entry.messageId ? { ...message, content: entry.content } : message,
    ),
  }));
}

/**
 * The undo net under destructive script edits. The stack survives
 * unrelated edits inside its lifetime; `undo` restores the newest entry,
 * and each push or undo re-arms the expiry.
 */
export function useScriptUndo(
  messages: SessionMessage[],
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>,
) {
  const [stack, setStack] = useState<ScriptUndoEntry[]>([]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const arm = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStack([]), UNDO_NOTICE_MS);
  };
  const push = (entry: ScriptUndoEntry) => {
    setStack((current) => [...current, entry]);
    arm();
  };
  const drop = () => {
    window.clearTimeout(timer.current);
    setStack([]);
  };
  const undo = () => {
    const entries = [...stack];
    // Skip stale entries (their restore target already back or gone) so a
    // press always restores something when anything is restorable.
    let entry = entries.pop();
    while (entry && !isUndoApplicable(entry, messages)) {
      entry = entries.pop();
    }
    if (entry !== undefined) {
      applyUndoEntry(entry, setProject);
    }
    setStack(entries);
    window.clearTimeout(timer.current);
    if (entries.length > 0) {
      arm();
    }
  };
  return { stack, push, drop, undo };
}
