/**
 * The inputs gallery's moving cards.
 *
 * Each animated SVG loops on its own document clock; the cards add the
 * studio's own two controls, a play/pause and a scrubber, and a slower pace.
 *
 * The studio can pause by flipping `animation-play-state`, because there the
 * SVG is part of the page. Here it is a document inside an <object>, which CSS
 * cannot reach — but scripting can, and the Web Animations API drives the same
 * keyframes: pause(), play(), and currentTime for the scrub. Only while a card
 * is on screen, because a page of them all cycling at once is work nobody
 * asked for.
 */

import {
  documentNowMs,
  loopDurationMs,
  playheadMs,
  REDUCED_MOTION,
  SEEK_STEPS,
  seekTargetMs,
} from "./waapi";

/**
 * Slower than the export plays. These samples are short and dense, and each
 * one is watched cold, with no idea what is about to happen in it — at full
 * speed the moment a card exists to show has passed before it is found.
 * The stage on the landing page keeps 1×: there the visitor chose to watch.
 */
const PLAYBACK_RATE = 0.7;
type CardHandle = { show: () => void; hide: () => void };

function attachCardControls(media: HTMLObjectElement, controls: HTMLElement): CardHandle | null {
  const play = controls.querySelector(".input-play");
  const seek = controls.querySelector(".input-seek");
  const view = media.contentDocument;
  if (
    view === null ||
    !(play instanceof HTMLButtonElement) ||
    !(seek instanceof HTMLInputElement)
  ) {
    return null;
  }
  const durationMs = loopDurationMs(view);
  if (durationMs === 0) {
    return null;
  }

  for (const animation of view.getAnimations()) {
    animation.playbackRate = PLAYBACK_RATE;
  }

  let playing = true;
  let onScreen = true;

  const all = () => view.getAnimations();
  const setLabel = () => {
    play.textContent = playing ? "❚❚" : "▶";
    play.setAttribute(
      "aria-label",
      playing ? (play.dataset.labelPause ?? "Pause") : (play.dataset.labelPlay ?? "Play"),
    );
  };
  // Not play(): that rewinds anything already past its own end, so every
  // entrance the card had shown would run again. Restoring startTime resumes
  // each animation exactly where the pause held it.
  const resume = () => {
    const now = documentNowMs(view);
    for (const animation of all()) {
      const held = animation.currentTime;
      if (typeof held === "number") {
        animation.startTime = now - held / (animation.playbackRate || 1);
      } else {
        animation.play();
      }
    }
  };

  const seekTo = (positionMs: number) => {
    for (const animation of all()) {
      // Pause first, then place the local clock. Every track in a timeline
      // export shares delay zero and the piece's whole length, so local time
      // is document time, and a paused clock takes the position exactly —
      // going through startTime instead lands a frame late, enough at the
      // slider's end to tip over the loop boundary and show the first frame.
      animation.pause();
      animation.currentTime = positionMs;
    }
  };

  const tick = () => {
    if (!onScreen) {
      return;
    }
    seek.value = String(Math.round((playheadMs(view, durationMs) / durationMs) * SEEK_STEPS));
    window.requestAnimationFrame(tick);
  };

  play.addEventListener("click", () => {
    playing = !playing;
    if (playing) {
      resume();
    } else {
      for (const animation of all()) {
        animation.pause();
      }
    }
    setLabel();
  });

  seek.addEventListener("input", () => {
    // Taking the scrubber means taking the timeline: the loop holds still
    // under the hand that is holding it.
    playing = false;
    seekTo(seekTargetMs(seek, durationMs));
    setLabel();
  });

  controls.hidden = false;
  setLabel();
  window.requestAnimationFrame(tick);

  return {
    show: () => {
      onScreen = true;
      if (playing) {
        resume();
      }
      window.requestAnimationFrame(tick);
    },
    hide: () => {
      onScreen = false;
      for (const animation of all()) {
        animation.pause();
      }
    },
  };
}

const media = document.querySelectorAll(".input-media");
if (media.length > 0 && !window.matchMedia(REDUCED_MOTION).matches) {
  const handles = new WeakMap<HTMLObjectElement, CardHandle>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (!(target instanceof HTMLObjectElement)) {
          continue;
        }
        const handle = handles.get(target);
        if (!entry.isIntersecting) {
          handle?.hide();
          continue;
        }
        if (handle !== undefined) {
          handle.show();
          continue;
        }
        const controls = target.closest(".input-card")?.querySelector(".input-controls");
        if (!(controls instanceof HTMLElement)) {
          continue;
        }
        const start = () => {
          target.classList.remove("is-loading");
          target.classList.add("is-ready");
          const started = attachCardControls(target, controls);
          if (started !== null) {
            handles.set(target, started);
          }
        };
        if (target.data === "" && target.dataset.src !== undefined) {
          // The poster keeps the frame until this moment; the skeleton
          // covers the parse, so the finished still never rewinds to an
          // empty transcript on screen.
          target.classList.add("is-loading");
          target.addEventListener("load", start, { once: true });
          target.data = target.dataset.src;
          continue;
        }
        start();
      }
    },
    { threshold: 0.25 },
  );
  for (const element of media) {
    observer.observe(element);
  }
}
