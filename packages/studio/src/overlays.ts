/**
 * The overlays a studio raises, and the two things they hold that belong to
 * the page rather than to any one of them.
 *
 * The page scroll is the first. An overlay freezes it while it is up, and
 * freezing is a property of the root scroller, which no element inside a
 * studio can stand in for. An overlay that unfroze it on its own close would
 * unfreeze it under another overlay still standing — the studio next door's,
 * or its own sibling's — and the page would scroll away behind a dialog.
 *
 * Escape is the second. A key pressed anywhere on the page reaches every
 * listener on it, so an overlay closing on any Escape closes when the key was
 * meant for the studio beside it, and two overlays open together both close on
 * one press. Only the overlay on top should answer.
 *
 * Both follow from the same thing: overlays are a stack, and the stack belongs
 * to the document. The state is keyed by `Document` rather than held in a
 * module variable so two documents can never share one stack; the hook raises
 * into the window's own document, which is the only one a studio is mounted
 * into today.
 */

import { useLayoutEffect, useRef } from "react";

const LOCKED_CLASS = "svgent-scroll-locked";
const LOCKED_TOP = "--svgent-locked-page-top";

type Overlay = { readonly dismiss: () => void };

type PageOverlays = {
  /** Raised overlays, oldest first; the last one answers Escape. */
  readonly raised: Overlay[];
  /** Where the page was when the first of them went up. */
  lockedScrollY: number;
  detachKeys: (() => void) | null;
};

const pages = new WeakMap<Document, PageOverlays>();

function overlaysFor(page: Document): PageOverlays {
  const existing = pages.get(page);
  if (existing !== undefined) {
    return existing;
  }
  const fresh: PageOverlays = { raised: [], lockedScrollY: 0, detachKeys: null };
  pages.set(page, fresh);
  return fresh;
}

function lockPage(page: PageOverlays, root: HTMLElement, view: Window): void {
  page.lockedScrollY = view.scrollY;
  // Always written, never only on the narrow layout: the window can be
  // resized across the breakpoint while the overlay is up, and the rule that
  // pins the body reads this. Absent, the body would pin at the top and the
  // page would jump to it.
  root.style.setProperty(LOCKED_TOP, `${-page.lockedScrollY}px`);
  root.classList.add(LOCKED_CLASS);
}

function unlockPage(page: PageOverlays, root: HTMLElement, view: Window): void {
  root.classList.remove(LOCKED_CLASS);
  root.style.removeProperty(LOCKED_TOP);
  // A no-op on the layout that never pinned, and the whole point on the one
  // that did.
  // Not the host's `scroll-behavior`: a smooth unlock animates the page back
  // from wherever the pin left it.
  view.scrollTo({ left: 0, top: page.lockedScrollY, behavior: "instant" });
}

/**
 * Raises an overlay: holds the page still and puts this overlay on top of the
 * stack that answers Escape. The returned release takes it down again, and
 * calling it twice does nothing the second time.
 *
 * Separate from the hook so the order — who answers, when the page locks, what
 * scroll position comes back — can be read without a browser.
 */
export function raiseOverlay(page: Document, view: Window, dismiss: () => void): () => void {
  const root = page.documentElement;
  const state = overlaysFor(page);
  const overlay: Overlay = { dismiss };

  state.raised.push(overlay);
  if (state.raised.length === 1) {
    lockPage(state, root, view);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) {
        // Escape ends an IME composition, and the key still arrives here. A
        // candidate dropped in a field inside an overlay must not take the
        // overlay with it.
        return;
      }
      // Asked of the target rather than of a global: `Element` is the browser's,
      // and this module is read where there is no document to have one.
      const target = event.target as { closest?: (selector: string) => unknown } | null;
      if (target?.closest?.("dialog[open]") != null) {
        // A modal dialog is promoted to the top layer, above everything on this
        // stack, and the browser closes it on this very key. It is the overlay
        // on top; the stack does not get to answer over it.
        return;
      }
      state.raised.at(-1)?.dismiss();
    };
    page.addEventListener("keydown", onKey);
    state.detachKeys = () => page.removeEventListener("keydown", onKey);
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const at = state.raised.indexOf(overlay);
    if (at !== -1) {
      state.raised.splice(at, 1);
    }
    if (state.raised.length === 0) {
      state.detachKeys?.();
      state.detachKeys = null;
      unlockPage(state, root, view);
    }
  };
}

/**
 * Holds the page still and takes Escape while `raised` is true.
 *
 * The last overlay raised is the one Escape reaches, and the page is held from
 * the first that goes up until the last comes down. An overlay stays raised
 * through its own closing animation — it is still the thing over the page — and
 * `onDismiss` is what decides whether there is anything left to dismiss.
 *
 * The callback is read out of a ref rather than depended on. A dependency on it
 * would tear this overlay off the stack and push it back on at every render of
 * the component holding it, which reorders the stack — the top would become
 * whichever studio rendered most recently rather than whichever overlay opened
 * last — and would unlock and relock the page, `scrollTo` and all, once per
 * render. `useEffectEvent` does not avoid that: it returns a fresh closure each
 * render and only the implementation behind it is stable.
 *
 * Before paint, both ways: taking the pin off the body and putting the scroll
 * back are two halves of one frame, and after paint the page is drawn once at
 * the top before it is drawn again where it was.
 */
export function useRaisedOverlay(raised: boolean, onDismiss: () => void): void {
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
  });
  useLayoutEffect(() => {
    if (!raised) {
      return;
    }
    return raiseOverlay(window.document, window, () => dismiss.current());
  }, [raised]);
}

/** How many overlays are up in this document. */
export function raisedOverlayCount(page: Document): number {
  return pages.get(page)?.raised.length ?? 0;
}
