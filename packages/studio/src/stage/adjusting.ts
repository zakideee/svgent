/**
 * Holding the phone's preview still while a slider is dragged.
 *
 * The phone stage takes its height from the canvas aspect and the window
 * margin, so the artwork meets the toolbar instead of leaving an idle band.
 * That density is worth keeping, but it makes the margin slider resize the
 * sticky header it sits under — and the control walks away from the finger
 * mid-drag.
 *
 * Browsers already absorb this once the page is scrolled: scroll anchoring
 * moves the offset to match. Measured on the 3:1 canvas, the drift is 0px at
 * any scroll depth and 78px at the very top, where there is no slack above to
 * spend. Compensating in script on top of that anchoring is actively worse —
 * the two corrections stack and the drift goes from 0 to ~80px.
 *
 * So the fix is not to move the scroll but to stop moving the layout: while a
 * thumb is held, the height keeps the value it had when the drag began. The
 * artwork still updates live, because the margin is drawn inside the SVG;
 * only the box around it waits. One settle on release replaces a shove per
 * frame.
 */

import type { RefObject } from "react";
import { useEffect, useState } from "react";

/**
 * True while a range input's thumb is held inside this studio. Scoped, because
 * a document-wide answer would freeze this studio's preview while someone
 * dragged a slider in the studio beside it.
 */
export function useSliderDragging(shellRef: RefObject<HTMLElement | null>): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const isSlider = (target: EventTarget | null): boolean =>
      target instanceof HTMLInputElement &&
      target.type === "range" &&
      (shellRef.current?.contains(target) ?? false);
    let pointerId: number | null = null;
    const down = (event: PointerEvent) => {
      if (isSlider(event.target)) {
        pointerId = event.pointerId;
        setDragging(true);
      }
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      pointerId = null;
      setDragging(false);
    };
    const shell = shellRef.current;
    if (shell === null) {
      return;
    }
    // The start is heard on the shell, so a slider in the studio next door is
    // never this studio's drag. The release has to stay on the window, because
    // a thumb can be lifted anywhere — but it answers only for the finger that
    // pressed. Any release would otherwise end a drag still in progress, and
    // the header this slider sits under would resize out from under it: the
    // very thing this module exists to stop.
    shell.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      shell.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, [shellRef]);
  return dragging;
}

/**
 * The margin ratio the stage sizes itself from: the live value, except while a
 * slider is held, when it stays at whatever it was when the drag started.
 */
export function useSteadyMarginRatio(ratio: number, dragging: boolean): number {
  const [held, setHeld] = useState(ratio);
  useEffect(() => {
    if (!dragging) {
      setHeld(ratio);
    }
  }, [ratio, dragging]);
  return dragging ? held : ratio;
}
