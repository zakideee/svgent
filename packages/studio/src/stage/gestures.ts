/**
 * Touch-only canvas gestures: a pinch scales the rendered scene, a drag
 * pans it once zoomed, and one held finger opens the editor for what is
 * under it. Mouse and pen flows (click-to-edit, inspector hover) never
 * enter these handlers.
 */

import type React from "react";
import { useEffect, useRef, useState } from "react";

/** Hold this long on one finger to open the editor for what is under it. */
const LONG_PRESS_MS = 500;
/** Moving farther than this cancels the press — it became a pan or pinch. */
const LONG_PRESS_CANCEL_PX = 10;
/** Past this the canvas is magnified enough that one finger should pan it. */
const STAGE_ZOOM_MAX = 6;

export function useStageGestures(options: {
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** Long-press is an edit affordance; the inspector suppresses it. */
  canEditInline: boolean;
  onLongPress: (stage: HTMLElement, point: { x: number; y: number }) => void;
}) {
  const { stageRef, canEditInline, onLongPress } = options;
  const [stageZoom, setStageZoom] = useState({ scale: 1, txPx: 0, tyPx: 0 });
  /** What kind of pointer last went down on the stage, read by the click
      handler: touch taps never open the stage's edit affordances. */
  const lastPointerTypeRef = useRef("mouse");
  // Mirror for the non-React touch listeners below, which outlive renders.
  const zoomedRef = useRef(false);
  useEffect(() => {
    zoomedRef.current = stageZoom.scale > 1;
  }, [stageZoom.scale]);

  // iOS Safari can hand a canvas pinch to the page zoom — or cancel the
  // pointer stream by starting a two-finger scroll — despite touch-action,
  // so the native gestures are refused directly. React's root touch
  // listeners are passive, which is why these attach by hand.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    const refuseTouchScroll = (event: TouchEvent) => {
      if (event.touches.length >= 2 || zoomedRef.current) {
        event.preventDefault();
      }
    };
    // Safari's proprietary pinch events; refusing them blocks page zoom.
    const refuseGesture = (event: Event) => event.preventDefault();
    stage.addEventListener("touchmove", refuseTouchScroll, { passive: false });
    stage.addEventListener("gesturestart", refuseGesture);
    stage.addEventListener("gesturechange", refuseGesture);
    return () => {
      stage.removeEventListener("touchmove", refuseTouchScroll);
      stage.removeEventListener("gesturestart", refuseGesture);
      stage.removeEventListener("gesturechange", refuseGesture);
    };
  }, [stageRef]);

  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef<{
    dist: number;
    scale: number;
    midX: number;
    midY: number;
    txPx: number;
    tyPx: number;
  } | null>(null);
  const longPressTimer = useRef<number | undefined>(undefined);
  const longPressStart = useRef<{ x: number; y: number } | null>(null);
  const cancelLongPress = () => {
    window.clearTimeout(longPressTimer.current);
    longPressStart.current = null;
  };
  useEffect(() => () => window.clearTimeout(longPressTimer.current), []);

  const onPointerDown = (event: React.PointerEvent) => {
    lastPointerTypeRef.current = event.pointerType;
    if (event.pointerType !== "touch") {
      return;
    }
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(touches.current.values());
    const [first, second] = points;
    if (points.length === 2 && first && second) {
      pinchStart.current = {
        dist: Math.hypot(first.x - second.x, first.y - second.y),
        scale: stageZoom.scale,
        midX: (first.x + second.x) / 2,
        midY: (first.y + second.y) / 2,
        txPx: stageZoom.txPx,
        tyPx: stageZoom.tyPx,
      };
    }
    // One held finger opens the editor for what is under it. A tap stays
    // free (no accidental edits), and pinch or pan cancels the press by
    // moving or adding a finger — the gestures never compete.
    if (points.length === 1 && canEditInline) {
      const stage = event.currentTarget as HTMLElement;
      const { clientX, clientY } = event;
      longPressStart.current = { x: clientX, y: clientY };
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = window.setTimeout(() => {
        longPressStart.current = null;
        onLongPress(stage, { x: clientX, y: clientY });
      }, LONG_PRESS_MS);
    } else {
      cancelLongPress();
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (event.pointerType !== "touch" || !touches.current.has(event.pointerId)) {
      return;
    }
    const previous = touches.current.get(event.pointerId);
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (
      longPressStart.current &&
      Math.hypot(
        event.clientX - longPressStart.current.x,
        event.clientY - longPressStart.current.y,
      ) > LONG_PRESS_CANCEL_PX
    ) {
      cancelLongPress();
    }
    const points = Array.from(touches.current.values());
    const pinch = pinchStart.current;
    const [first, second] = points;
    if (points.length === 2 && pinch && first && second) {
      const dist = Math.hypot(first.x - second.x, first.y - second.y);
      const scale = Math.min(
        STAGE_ZOOM_MAX,
        Math.max(1, (pinch.scale * dist) / Math.max(1, pinch.dist)),
      );
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;
      setStageZoom({
        scale,
        // At 1× the view snaps back to the fitted origin.
        txPx: scale === 1 ? 0 : pinch.txPx + midX - pinch.midX,
        tyPx: scale === 1 ? 0 : pinch.tyPx + midY - pinch.midY,
      });
      return;
    }
    if (points.length === 1 && stageZoom.scale > 1 && previous) {
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      setStageZoom((current) => ({ ...current, txPx: current.txPx + dx, tyPx: current.tyPx + dy }));
    }
  };

  const onPointerEnd = (event: React.PointerEvent) => {
    if (event.pointerType !== "touch") {
      return;
    }
    cancelLongPress();
    touches.current.delete(event.pointerId);
    if (touches.current.size < 2) {
      pinchStart.current = null;
    }
  };

  const resetZoom = () => setStageZoom({ scale: 1, txPx: 0, tyPx: 0 });

  return {
    stageZoom,
    resetZoom,
    lastPointerTypeRef,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
  };
}
