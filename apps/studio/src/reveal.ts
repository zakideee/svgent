/**
 * The landing page's own motion, borrowed from the renderer's vocabulary.
 *
 * Sections enter the way messages enter a session: a small rise and a fade,
 * one row after another. The formats section replays the tool's core beat —
 * a prompt line types, and the chips stream out as its output. The first
 * section takes a thinking pause before it answers. Everything runs once per
 * page load, only as each block scrolls into view, and none of it runs for
 * a visitor who asked for reduced motion — they get the finished page.
 */

import { REDUCED_MOTION } from "./waapi";

/** Message-entrance targets, in the order their stagger counts. */
const ENTRANCE_SELECTOR = [
  ".facts > li",
  ".formats > li",
  ".section-lead",
  ".is-cta .actions",
].join(", ");

const reduced = window.matchMedia(REDUCED_MOTION).matches;
const targets = Array.from(document.querySelectorAll(ENTRANCE_SELECTOR));
const sections = Array.from(
  document.querySelectorAll(".is-people, .is-content, .is-look, .is-formats, .is-cta"),
);
const cmd = document.querySelector(".formats-cmd code");

if (reduced) {
  // The finished page, no choreography.
  for (const element of targets) {
    element.classList.add("is-in");
  }
  for (const section of sections) {
    section.classList.add("is-heading-in");
  }
} else {
  // The hidden initial states live behind this flag, so a visitor without
  // scripting gets the finished page rather than an empty one.
  document.documentElement.classList.add("has-reveal");

  // Rows inside one section share a stagger counter, so a list enters the
  // way messages do: one after another, not all at once.
  for (const section of sections) {
    let order = 0;
    for (const element of section.querySelectorAll(ENTRANCE_SELECTOR)) {
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      element.classList.add("reveal");
      element.style.setProperty("--reveal-order", String(order));
      // Chips stream like output; prose rows keep a message's pacing.
      order += element.matches(".formats > li") ? 0.5 : 1;
    }
  }

  /** Types the prompt line, then lets the chips follow as its output. */
  const typeCommand = (section: Element): Promise<void> => {
    if (cmd === null) {
      return Promise.resolve();
    }
    const full = cmd.textContent ?? "";
    cmd.textContent = "";
    section.classList.add("is-typing");
    return new Promise<void>((resolve) => {
      let at = 0;
      const step = () => {
        at += 1;
        cmd.textContent = full.slice(0, at);
        if (at < full.length) {
          window.setTimeout(step, 14);
        } else {
          section.classList.remove("is-typing");
          resolve();
        }
      };
      window.setTimeout(step, 120);
    });
  };

  const enter = (section: Element) => {
    // The first section thinks for a beat before it answers; the others
    // answer right away. The heading's bar carries that pause.
    section.classList.add("is-heading-in");
    const delay = section.classList.contains("is-people") ? 420 : 0;
    const start = section.classList.contains("is-formats")
      ? typeCommand(section)
      : Promise.resolve();
    start.then(() => {
      window.setTimeout(() => section.classList.add("is-on"), delay);
    });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          enter(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  for (const section of sections) {
    observer.observe(section);
  }
}
