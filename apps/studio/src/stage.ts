/**
 * The landing pages' demo stage.
 *
 * One authored session, rendered four ways: two surfaces × camera on and off.
 * The controls swap which of those four documents the stage holds, so the
 * comparison is like for like — same script, same theme, same backdrop.
 *
 * The file loops on its own document clock, but inside an <img> that is all
 * it would do. The document lives in an <object>, whose content scripting can
 * reach, so the visitor gets a pause and a scrubber over the loop.
 *
 * The markup carries no `data` at all, so a visitor without scripting keeps
 * the poster the object falls back to rather than an animation they cannot
 * control. That poster is also what someone who asked for reduced motion sees
 * until they press play.
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
 * Play/pause and scrub, the two controls the studio has over its preview.
 * There the SVG is part of the page and CSS can freeze it; here it is a
 * document inside an <object>, so the same keyframes are driven through the
 * Web Animations API instead. Called again whenever the stage loads another
 * of the four renderings.
 */
function attachTransport(media: HTMLObjectElement, transport: HTMLElement): void {
  const view = media.contentDocument;
  const play = transport.querySelector(".stage-play");
  const seek = transport.querySelector(".stage-seek");
  if (
    view === null ||
    !(play instanceof HTMLButtonElement) ||
    !(seek instanceof HTMLInputElement)
  ) {
    return;
  }
  const durationMs = loopDurationMs(view);
  if (durationMs === 0) {
    return;
  }
  let playing = true;
  const all = () => view.getAnimations();
  const label = () => {
    play.textContent = playing ? "❚❚" : "▶";
    play.setAttribute(
      "aria-label",
      playing ? (play.dataset.labelPause ?? "Pause") : (play.dataset.labelPlay ?? "Play"),
    );
  };
  const tick = () => {
    if (media.contentDocument !== view) {
      return;
    }
    seek.value = String(Math.round((playheadMs(view, durationMs) / durationMs) * SEEK_STEPS));
    window.requestAnimationFrame(tick);
  };
  play.onclick = () => {
    playing = !playing;
    const now = documentNowMs(view);
    for (const animation of all()) {
      if (!playing) {
        animation.pause();
        continue;
      }
      // Not play(): that resets a held clock, so the loop would restart
      // instead of continuing. Restoring startTime resumes each animation
      // exactly where the pause held it.
      const held = animation.currentTime;
      if (typeof held === "number") {
        animation.startTime = now - held / (animation.playbackRate || 1);
      } else {
        animation.play();
      }
    }
    label();
  };
  seek.oninput = () => {
    playing = false;
    const targetMs = seekTargetMs(seek, durationMs);
    for (const animation of all()) {
      // Pause first, then place the local clock. Every track in a timeline
      // export shares delay zero and the piece's whole length, so local time
      // is document time, and a paused clock takes the position exactly.
      // Going through startTime instead lands a frame late — enough, at the
      // slider's end, to tip over the loop boundary and show the first frame.
      animation.pause();
      animation.currentTime = targetMs;
    }
    label();
  };
  transport.hidden = false;
  // With a transport on screen, "Play from the start" would be a second play
  // affordance one row below the first — the loop never rests anyway — so the
  // caption's button retires.
  const caption = media.closest(".stage")?.querySelector(".stage-caption");
  if (caption instanceof HTMLElement) {
    caption.hidden = true;
  }
  label();
  window.requestAnimationFrame(tick);
}

const figure = document.querySelector(".stage");
const stage = document.querySelector(".stage-media");
const replay = document.querySelector(".stage-replay");
const controls = document.querySelector(".stage-controls");
const transport = document.querySelector(".stage-transport");
const source = document.querySelector(".stage-source");

function sourceFor(prefix: string, surface: string, zoom: boolean): string {
  return `${prefix}-${surface}${zoom ? "-zoom" : ""}-01.animated.svg`;
}

if (stage instanceof HTMLObjectElement && replay instanceof HTMLButtonElement) {
  const playLabel = replay.dataset.labelPlay ?? "Play";
  const replayLabel = (replay.textContent ?? "Replay").trim();
  const held = window.matchMedia(REDUCED_MOTION).matches;
  const prefix = figure instanceof HTMLElement ? (figure.dataset.hero ?? "") : "";

  let surface = "app";
  // A small screen reads the demo through the camera — without it the
  // transcript is toy type — while a wide one reads the type as it is.
  // Same breakpoint as the hero's two-column layout, for the same reason.
  let zoom = !window.matchMedia("(min-width: 1000px)").matches;
  /** The stage element in the document right now, which reload() replaces. */
  let current = stage;
  /** Until the first play, the stage still shows its fallback poster. */
  let loaded = false;

  const load = () => {
    current.classList.add("is-loading");
    current.classList.remove("is-ready");
    current.addEventListener(
      "load",
      () => {
        current.classList.remove("is-loading");
        current.classList.add("is-ready");
      },
      { once: true },
    );
    const file = sourceFor(prefix, surface, zoom);
    // A play button and a scrubber read as video. The one thing that says
    // otherwise is the file itself, so the label links straight to it.
    if (source instanceof HTMLAnchorElement) {
      // Carry the page that sent them, so the way back is the way they came.
      source.href = `/view/?src=${encodeURIComponent(file)}&from=${encodeURIComponent(window.location.pathname)}`;
    }
    current.data = file;
    loaded = true;
    replay.textContent = replayLabel;
    if (transport instanceof HTMLElement) {
      current.addEventListener("load", () => attachTransport(current, transport), { once: true });
    }
  };

  // Re-creating the element also restarts the motion, but re-parsing a
  // megabyte of SVG blanks the frame first, so it is only the fallback.
  const reload = () => {
    // cloneNode types as Node, but cloning an <object> yields an <object>.
    const fresh = current.cloneNode(true) as HTMLObjectElement;
    current.replaceWith(fresh);
    current = fresh;
    load();
  };

  const rewind = () => {
    const view = current.contentDocument;
    if (view === null || typeof view.getAnimations !== "function") {
      reload();
      return;
    }
    const animations = view.getAnimations();
    if (animations.length === 0) {
      reload();
      return;
    }
    for (const animation of animations) {
      animation.currentTime = 0;
      animation.play();
    }
  };

  replay.hidden = false;
  replay.addEventListener("click", () => {
    if (loaded) {
      rewind();
      return;
    }
    load();
  });

  if (controls instanceof HTMLElement) {
    controls.hidden = false;
    // The markup pins one pressed state; the width-dependent zoom default
    // means the truth is only known here.
    const syncPressed = () => {
      for (const option of controls.querySelectorAll("button")) {
        const active =
          option.dataset.surface === surface ||
          (option.dataset.zoom !== undefined && (option.dataset.zoom === "on") === zoom);
        option.setAttribute("aria-pressed", String(active));
      }
    };
    syncPressed();
    controls.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button === null || !controls.contains(button)) {
        return;
      }
      if (button.dataset.surface !== undefined) {
        surface = button.dataset.surface;
      } else if (button.dataset.zoom !== undefined) {
        zoom = button.dataset.zoom === "on";
      } else {
        return;
      }
      syncPressed();
      // A different document is a different file: setting `data` loads it and
      // its keyframes start from zero on their own.
      load();
    });
  }

  if (held) {
    replay.textContent = playLabel;
  } else {
    load();
  }
}
