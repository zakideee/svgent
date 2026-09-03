/**
 * The stage flight (FLIP): one live canvas element, its transform
 * animated between the preview column and an overlay's slot — the wizard
 * or the export dialog — so every choice is seen on the real canvas, in
 * place. Ownership is shared: the flight tears down only once no overlay
 * claims it, so wizard→dialog handoffs never snap the canvas home.
 */

import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useState } from "react";

/** The pinned stage box and its current glide transform. */
export type StageFlight = {
  base: { left: number; top: number; width: number; height: number };
  transform: string;
};

/**
 * Overlay close-glide duration: `.preview-stage.is-flying` transitions
 * transform over 340ms; 20ms of cushion lets the glide land before the
 * overlay unmounts.
 */
export const STAGE_FLIGHT_GLIDE_MS = 360;

/** Breathing room the canvas keeps inside the slot, per side. */
const SLOT_INSET_PX = 8;

/**
 * Where the canvas sits inside the pinned stage box, with the glide divided
 * back out.
 *
 * Nothing here is derived, because every model of it has been wrong. The stage
 * pads its canvas asymmetrically on a phone (`40px 5px 6px`), so assuming a
 * centred letterbox aimed low enough to push wide canvases out of the slot;
 * and the SVG sits at the top of its holder rather than centred in it, so
 * fitting the aspect into the holder box was wrong too. Reading the rects and
 * the matrix in the same frame is exact whatever the box does — and exact even
 * mid-glide, because both samples describe the same instant.
 */
function canvasRectWithin(
  stage: HTMLElement,
): { dx: number; dy: number; width: number; height: number } | null {
  const canvas = stage.querySelector("svg");
  if (canvas === null) {
    return null;
  }
  const scale = new DOMMatrixReadOnly(getComputedStyle(stage).transform).a || 1;
  const from = stage.getBoundingClientRect();
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    return null;
  }
  return {
    dx: (rect.left - from.left) / scale,
    dy: (rect.top - from.top) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  };
}

/** The flight state plus the stable "fly the canvas home" transition. */
export function useStageFlightState() {
  const [stageFlight, setStageFlight] = useState<StageFlight | null>(null);
  const glideHome = useCallback(() => {
    setStageFlight((current) =>
      current ? { ...current, transform: "translate(0px, 0px) scale(1)" } : current,
    );
  }, []);
  return { stageFlight, setStageFlight, glideHome };
}

/**
 * Aims the pinned canvas at whichever overlay slot currently owns it and
 * tears the flight down once neither does. Owner state arrives as plain
 * values so the caller can wire the wizard and the export dialog without
 * this hook depending on either.
 */
export function useStageFlightAim(options: {
  stageFlight: StageFlight | null;
  setStageFlight: React.Dispatch<React.SetStateAction<StageFlight | null>>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  wizard: {
    step: number | null;
    closing: boolean;
    slotRef: React.RefObject<HTMLDivElement | null>;
  };
  dialog: {
    open: boolean;
    closing: boolean;
    slotRef: React.RefObject<HTMLDivElement | null>;
  };
  canvasWidth: number;
  canvasHeight: number;
}): void {
  const { stageFlight, setStageFlight, stageRef, canvasWidth, canvasHeight } = options;
  const { step: wizardStep, closing: wizardClosing, slotRef: wizardSlotRef } = options.wizard;
  const { open: dialogOpen, closing: dialogClosing, slotRef: dialogSlotRef } = options.dialog;

  // The flown canvas survives wizard→export-dialog handoffs: the flight is
  // torn down only once no overlay owns it, never by whichever overlay
  // happened to close last (its stale close would snap the canvas home and
  // re-fly it mid-glide).
  useEffect(() => {
    if (wizardStep === null && !dialogOpen) {
      setStageFlight(null);
    }
  }, [wizardStep, dialogOpen, setStageFlight]);

  // Bumped whenever resize or content replacement may have moved or resized
  // the flight slot, so the flown canvas re-aims at its current geometry.
  const [flightTick, setFlightTick] = useState(0);
  useEffect(() => {
    if (wizardStep === null && !dialogOpen) {
      return;
    }
    const onResize = () => setFlightTick((tick) => tick + 1);
    window.addEventListener("resize", onResize);
    // Both ends move without anything the aim depends on changing. The slot
    // re-flows when a step's options occupy a different height, and the canvas
    // is redrawn a render after the aspect ratio changes — the scene rebuild is
    // deferred, and the redraw replaces the element rather than resizing the
    // pinned box around it. Watching a size and watching a replacement covers
    // both; the aim is idempotent, so a spurious tick costs nothing.
    const slot = (wizardStep !== null ? wizardSlotRef : dialogSlotRef).current;
    const sizes = new ResizeObserver(onResize);
    if (slot !== null) {
      sizes.observe(slot);
    }
    // Observed on the stage itself, not its `.svg-preview` holder: on a first
    // load the wizard opens before the engine has drawn anything, so the
    // holder does not exist yet — an observer rooted there never sees the
    // canvas arrive, and the pinned stage stays covering the overlay instead
    // of gliding into the slot.
    const stage = stageRef.current;
    const swaps = new MutationObserver(onResize);
    if (stage !== null) {
      swaps.observe(stage, { childList: true, subtree: true });
    }
    return () => {
      window.removeEventListener("resize", onResize);
      sizes.disconnect();
      swaps.disconnect();
    };
  }, [wizardStep, dialogOpen, wizardSlotRef, dialogSlotRef, stageRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: flightTick and the canvas size are re-aim triggers, not reads — the effect measures current geometry whenever any of them bumps.
  useLayoutEffect(() => {
    // One flight, two destinations: the wizard's slot or the export
    // dialog's slot.
    const flightSlot =
      wizardStep !== null && !wizardClosing
        ? wizardSlotRef
        : dialogOpen && !dialogClosing
          ? dialogSlotRef
          : null;
    const stage = stageRef.current;
    const slot = flightSlot?.current;
    if (!stage || !slot) {
      return;
    }
    if (stageFlight === null) {
      // Phase one: pin the stage (position:fixed) exactly where it sits, so
      // ancestor overflow can no longer clip it mid-flight.
      const from = stage.getBoundingClientRect();
      setStageFlight({
        base: { left: from.left, top: from.top, width: from.width, height: from.height },
        transform: "translate(0px, 0px) scale(1)",
      });
      return;
    }
    // Phase two (next frame): glide into the slot. Fit and center the canvas'
    // own visual rect — not the element box — measured live rather than
    // derived from the aspect ratio, so an off-center canvas lands centered
    // and a resized one re-aims instead of drifting out of the frame. No
    // upper clamp: vector content may land larger than it sat in the column.
    const to = slot.getBoundingClientRect();
    const { base } = stageFlight;
    const canvas = canvasRectWithin(stage);
    if (canvas === null) {
      return;
    }
    const scale = Math.min(
      (to.width - SLOT_INSET_PX * 2) / canvas.width,
      (to.height - SLOT_INSET_PX * 2) / canvas.height,
    );
    const tx = to.left + to.width / 2 - base.left - (canvas.dx + canvas.width / 2) * scale;
    const ty = to.top + to.height / 2 - base.top - (canvas.dy + canvas.height / 2) * scale;
    const transform = `translate(${Math.round(tx)}px, ${Math.round(ty)}px) scale(${scale.toFixed(4)})`;
    if (transform === stageFlight.transform) {
      return;
    }
    const raf = requestAnimationFrame(() => {
      setStageFlight((current) => (current ? { ...current, transform } : current));
    });
    return () => cancelAnimationFrame(raf);
  }, [
    wizardStep,
    wizardClosing,
    wizardSlotRef,
    dialogOpen,
    dialogClosing,
    dialogSlotRef,
    stageFlight,
    setStageFlight,
    stageRef,
    flightTick,
    canvasWidth,
    canvasHeight,
  ]);
}
