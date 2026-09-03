/**
 * The site pages' shared Web Animations vocabulary.
 *
 * The landing stage and the gallery cards drive the same kind of document —
 * an exported animated SVG inside an <object>, where CSS cannot reach and
 * scripting can. The export compiles every track onto one looping document
 * clock, so each animation carries the piece's whole length as its iteration
 * and repeats forever. Both pages need the same two readings of such a
 * document: how long one pass is, and where inside the current pass the
 * playhead sits.
 */

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** The scrubber counts in thousandths, so it needs no duration to exist. */
export const SEEK_STEPS = 1000;

/** The document's shared clock as a number; a fresh timeline reads null. */
export function documentNowMs(view: Document): number {
  const now = view.timeline.currentTime;
  return typeof now === "number" ? now : 0;
}

/** One pass of the piece: the longest iteration among the document's animations. */
export function loopDurationMs(view: Document): number {
  return view.getAnimations().reduce((longest: number, animation) => {
    const duration = animation.effect?.getComputedTiming().duration;
    return typeof duration === "number" && duration > longest ? duration : longest;
  }, 0);
}

/**
 * The scrubber's position as document time, held just inside the loop. The
 * boundary itself belongs to the next pass — a looping animation shows the
 * first frame there — so parking the slider at its end means the final frame,
 * not a snap back to the top.
 */
export function seekTargetMs(seek: HTMLInputElement, loopMs: number): number {
  return Math.min((Number(seek.value) / SEEK_STEPS) * loopMs, loopMs - 1);
}

/**
 * Where inside the current pass the piece is. The furthest local clock, so one
 * late-started animation cannot stand in for where the whole piece is — and
 * folded into one pass, because a looping animation's clock never stops
 * climbing.
 */
export function playheadMs(view: Document, loopMs: number): number {
  let at = 0;
  for (const animation of view.getAnimations()) {
    const time = animation.currentTime;
    if (typeof time === "number" && time > at) {
      at = time;
    }
  }
  return loopMs > 0 ? at % loopMs : at;
}
