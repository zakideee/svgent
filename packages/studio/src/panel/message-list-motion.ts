/**
 * The two motions of the script list: the live-sort drag that shows a
 * drop position while the pointer moves, and the FLIP glide that makes
 * an add, delete, or reorder readable after it lands.
 */

import type { SessionMessage } from "@svgent/scene";
import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";

/** Glide for a script row that changed place — long enough to follow with
    the eye, short enough that a burst of edits never feels queued. */
const LIST_SHIFT_MS = 170;

type MessageDrag = {
  fromIndex: number;
  targetIndex: number;
  offsetPx: number;
  shiftPx: number;
};

/**
 * Live-sort drag: the grabbed card follows the pointer while the cards it
 * passes slide aside at the midpoint threshold, so the drop position is
 * visible the whole time. Pointer events (not HTML5 DnD) keep this
 * working on touch as well.
 */
export function useMessageListDrag(options: {
  listRef: React.RefObject<HTMLDivElement | null>;
  messageCount: number;
  onReorder: (from: number, to: number) => void;
}) {
  const { listRef, messageCount, onReorder } = options;
  const [messageDrag, setMessageDrag] = useState<MessageDrag | null>(null);
  const dragFrame = useRef<number | undefined>(undefined);
  useLayoutEffect(
    () => () => {
      if (dragFrame.current !== undefined) {
        cancelAnimationFrame(dragFrame.current);
      }
    },
    [],
  );

  const startMessageDrag = (event: React.PointerEvent, fromIndex: number) => {
    const list = listRef.current;
    if (list === null || messageCount < 2 || event.button > 0) {
      return;
    }
    event.preventDefault();
    const cards = Array.from(list.querySelectorAll<HTMLElement>(".message-editor"));
    const rects = cards.map((card) => card.getBoundingClientRect());
    const fromRect = rects[fromIndex];
    if (fromRect === undefined) {
      return;
    }
    const gapPx =
      rects.length > 1 ? Math.max(0, (rects[1]?.top ?? 0) - (rects[0]?.bottom ?? 0)) : 8;
    const startY = event.clientY;
    // The listeners are on the window, so a second finger — in this studio or
    // the one beside it — would otherwise drive and end this drag.
    const pointerId = event.pointerId;
    const minDy = (rects[0]?.top ?? fromRect.top) - fromRect.top;
    const maxDy = (rects.at(-1)?.bottom ?? fromRect.bottom) - fromRect.bottom;
    const centers = rects.map((rect) => rect.top + rect.height / 2);
    const fromCenter = fromRect.top + fromRect.height / 2;
    setMessageDrag({
      fromIndex,
      targetIndex: fromIndex,
      offsetPx: 0,
      shiftPx: fromRect.height + gapPx,
    });
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) {
        return;
      }
      const dy = Math.min(maxDy, Math.max(minDy, move.clientY - startY));
      const draggedCenter = fromCenter + dy;
      const targetIndex = centers.filter(
        (center, index) => index !== fromIndex && center < draggedCenter,
      ).length;
      if (dragFrame.current !== undefined) {
        cancelAnimationFrame(dragFrame.current);
      }
      dragFrame.current = requestAnimationFrame(() => {
        setMessageDrag((current) =>
          current === null ? current : { ...current, offsetPx: dy, targetIndex },
        );
      });
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (dragFrame.current !== undefined) {
        cancelAnimationFrame(dragFrame.current);
      }
      const dy = Math.min(maxDy, Math.max(minDy, end.clientY - startY));
      const draggedCenter = fromCenter + dy;
      const targetIndex =
        end.type === "pointercancel"
          ? fromIndex
          : centers.filter((center, index) => index !== fromIndex && center < draggedCenter).length;
      setMessageDrag(null);
      if (targetIndex !== fromIndex) {
        onReorder(fromIndex, targetIndex);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  /** Visual shift of card `index` while another card is dragged over it. */
  const dragOffsetFor = (index: number): number => {
    if (messageDrag === null) {
      return 0;
    }
    const { fromIndex, targetIndex, offsetPx, shiftPx } = messageDrag;
    if (index === fromIndex) {
      return offsetPx;
    }
    if (fromIndex < targetIndex && index > fromIndex && index <= targetIndex) {
      return -shiftPx;
    }
    if (fromIndex > targetIndex && index >= targetIndex && index < fromIndex) {
      return shiftPx;
    }
    return 0;
  };

  return { messageDrag, startMessageDrag, dragOffsetFor };
}

/**
 * Add, delete, and reorder rewrite the list in a single frame, so the row
 * under the cursor becomes a different message with nothing to say it
 * moved. Each row is FLIPped from where it was to where it landed: the
 * glide is what makes the shift readable. Rows are keyed by message id, so
 * React reuses the same nodes and a WeakMap of their last offsets carries
 * across the re-render; a row with no recorded offset is new and fades in.
 */
export function useListShiftFlip(options: {
  listRef: React.RefObject<HTMLDivElement | null>;
  messages: SessionMessage[];
  /** Any value whose change re-measures rows without animating them. */
  flow: string;
}): { skipNextShift: () => void } {
  const { listRef, messages, flow } = options;
  const rowOffsets = useRef(new WeakMap<Element, number>());
  const previousIds = useRef<string | null>(null);
  const skipShift = useRef(false);
  const messageIdsKey = messages.map((message) => message.id).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages re-measures after any edit that changes a row's height, so the next shift never animates from a stale offset
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const rows = Array.from(list.children) as HTMLElement[];
    const before = rows.map((row) => rowOffsets.current.get(row));
    const after = rows.map((row) => row.offsetTop);
    rows.forEach((row, index) => {
      rowOffsets.current.set(row, after[index] ?? 0);
    });
    const listChanged = previousIds.current !== messageIdsKey;
    previousIds.current = messageIdsKey;
    const dropped = skipShift.current;
    skipShift.current = false;
    // A drop already showed the landing spot through the live-sort shift;
    // replaying it as a glide would move the card twice. The list's first
    // paint has nothing to glide from — it appeared, it did not move.
    if (!listChanged || dropped || before.every((top) => top === undefined)) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    rows.forEach((row, index) => {
      const from = before[index];
      const to = after[index] ?? 0;
      if (from === undefined) {
        row.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: LIST_SHIFT_MS, easing: "ease-out" },
        );
      } else if (Math.abs(from - to) > 0.5) {
        row.animate([{ transform: `translateY(${from - to}px)` }, { transform: "none" }], {
          duration: LIST_SHIFT_MS,
          easing: "ease-out",
        });
      }
    });
  }, [messageIdsKey, messages, flow, listRef]);

  return {
    skipNextShift: () => {
      skipShift.current = true;
    },
  };
}
