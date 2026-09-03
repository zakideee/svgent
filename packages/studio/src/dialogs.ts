/**
 * Shared light-dismiss behavior for the modal `<dialog>`s: clicking away
 * closes them, matching the quick-start overlay and the script menu.
 */

import type React from "react";
import { useRef } from "react";

/**
 * Whether a pointer event on a modal `<dialog>` landed on its backdrop.
 * Backdrop events are retargeted to the dialog element itself, so the
 * element check alone would also match the dialog's own padding — the
 * rectangle test keeps a click on the panel edge from dismissing it.
 */
function isDialogBackdropEvent(event: React.MouseEvent<HTMLDialogElement>): boolean {
  if (event.target !== event.currentTarget) {
    return false;
  }
  const rect = event.currentTarget.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
}

/**
 * Spread onto a modal `<dialog>` to close it on backdrop clicks. Only a
 * press that both starts and ends on the backdrop counts, so a selection
 * dragged out of a textarea never closes the dialog under the pointer.
 * `close()` runs the dialog's own onClose, so cancelling this way is the
 * same path as Escape.
 */
export function useDialogLightDismiss() {
  const backdropPressRef = useRef(false);
  return {
    onMouseDown: (event: React.MouseEvent<HTMLDialogElement>) => {
      backdropPressRef.current = isDialogBackdropEvent(event);
    },
    onClick: (event: React.MouseEvent<HTMLDialogElement>) => {
      if (backdropPressRef.current && isDialogBackdropEvent(event)) {
        event.currentTarget.close();
      }
      backdropPressRef.current = false;
    },
  };
}
