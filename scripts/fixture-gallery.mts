/**
 * Contact-sheet generator for the fixture corpus: collects what
 * `pnpm render:fixtures` produced and writes an index.html next to it.
 * The grid shows every animation looping (reloaded per scene duration,
 * only while visible); clicking a card opens an in-page lightbox with the
 * looping animation large and the final-frame poster next to the
 * full-transcript (unscrolled) render below it.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildSvgentScene,
  DEFAULT_PROJECT,
  deserializeProject,
  imeConversionCount,
  type SvgentProject,
} from "@svgent/scene";

const outDir = process.argv[2] ?? "render-out/fixtures";
const fixturesDir = new URL("../fixtures/scripts/", import.meta.url);

const bases = (await readdir(outDir))
  .filter((name) => name.endsWith(".png") && !name.endsWith(".transcript.png"))
  .map((name) => name.replace(/\.png$/u, ""))
  .sort();
if (bases.length === 0) {
  console.error(`[svgent] no PNGs in ${outDir} — run "pnpm render:fixtures" first`);
  process.exit(1);
}

// Scene durations drive the loop cadence: each card reloads its animated SVG
// after the scene has finished plus a short hold.
const durations: Record<string, number> = {};
// Canvas width per page: the lightbox zooms in real pixels, and fixtures
// range from a wide desktop frame to a tall phone one.
const widths: Record<string, number> = {};
/** Filter tags per page, grouped so the chip rows can be labelled. */
const tags: Record<string, string[]> = {};

/**
 * What a fixture is, as the chips read it: which surface and flow it
 * renders, how it is dressed, and which authored features it exercises.
 * Tags are namespaced (`surface:tui`) so one flat list drives every row.
 */
function fixtureTags(project: SvgentProject): string[] {
  const { appearance, display, messages } = project;
  const roles = new Set(messages.map((message) => message.role));
  const has = (predicate: (message: (typeof messages)[number]) => boolean): boolean =>
    messages.some(predicate);
  const found = [
    `surface:${project.surface}`,
    `flow:${project.pagination.flow}`,
    `theme:${appearance.theme}`,
    `backdrop:${appearance.backdrop}`,
  ];
  for (const role of ["thinking", "tool", "permission", "choice", "image"]) {
    if (roles.has(role as (typeof messages)[number]["role"])) {
      found.push(`uses:${role}`);
    }
  }
  if (has((message) => message.decision === "deny")) {
    found.push("uses:deny");
  }
  if (has((message) => (message.freeform ?? "").trim().length > 0)) {
    found.push("uses:freeform");
  }
  if (has((message) => (message.images?.length ?? 0) > 0)) {
    found.push("uses:attachment");
  }
  if (has((message) => message.role === "user" && imeConversionCount(message.content) > 0)) {
    found.push("uses:ime");
  }
  if (has((message) => message.inputMode === "voice")) {
    found.push("uses:voice");
  }
  if (has((message) => message.content.includes("```"))) {
    found.push("uses:code");
  }
  if (has((message) => message.pageBreakBefore === true)) {
    found.push("uses:page-break");
  }
  // Against the defaults, not "has a false anywhere": tuiTitle/tuiClock are
  // off by default, so the naive test tagged every fixture in the corpus.
  if (
    (Object.keys(display) as Array<keyof typeof display>).some(
      (key) => display[key] !== DEFAULT_PROJECT.display[key],
    )
  ) {
    found.push("uses:chrome-parts");
  }
  if (appearance.transparentCanvas) {
    found.push("uses:transparent");
  }
  return found;
}

for (const file of (await readdir(fixturesDir)).filter((name) => name.endsWith(".json"))) {
  const stem = file.replace(/\.json$/u, "");
  const { project } = deserializeProject(await readFile(new URL(file, fixturesDir), "utf8"));
  const pageCount = buildSvgentScene(project, 0).pageCount;
  const pageTags = fixtureTags(project);
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const scene = buildSvgentScene(project, pageIndex);
    const key = `${stem}-${String(pageIndex + 1).padStart(2, "0")}`;
    durations[key] = scene.durationMs;
    widths[key] = project.appearance.canvasWidth;
    tags[key] = pageTags;
  }
}

/** Chip rows, in the order they are offered. */
const FILTER_GROUPS: Array<{ prefix: string; label: string }> = [
  { prefix: "surface", label: "Surface" },
  { prefix: "flow", label: "Flow" },
  { prefix: "theme", label: "Theme" },
  { prefix: "backdrop", label: "Backdrop" },
  { prefix: "uses", label: "Features" },
];
/**
 * One card per fixture, not per page: a deck's slides belong together, and
 * as separate cards the packing scattered them into whichever lanes were
 * short at the time.
 */
const decks = new Map<string, string[]>();
for (const base of bases) {
  const stem = base.replace(/-\d+$/u, "");
  decks.set(stem, [...(decks.get(stem) ?? []), base]);
}

const filterRows = FILTER_GROUPS.map((group) => {
  const values = [
    ...new Set(
      Object.values(tags)
        .flat()
        .filter((tag) => tag.startsWith(`${group.prefix}:`)),
    ),
  ].sort();
  const chips = values
    .map((tag) => {
      // Per card, matching the total: a four-page deck is one sample.
      const count = [...decks.values()].filter((pages) =>
        (tags[pages[0] ?? ""] ?? []).includes(tag),
      ).length;
      return `<button type="button" data-tag="${tag}">${tag.split(":")[1]} <em>${count}</em></button>`;
    })
    .join("");
  return `      <div class="filter-row"><span>${group.label}</span><div class="chips">${chips}</div></div>`;
}).join("\n");

const cards = [...decks]
  .map(([stem, pages]) => {
    const longestMs = Math.max(...pages.map((page) => durations[page] ?? 0));
    const pageTags = tags[pages[0] ?? ""] ?? [];
    const thumbs = pages
      .map(
        (page, index) =>
          `<button type="button" class="page" data-base="${page}"><img src="./${page}.animated.svg" alt="${page}" loading="lazy" />${
            pages.length > 1 ? `<span class="page-no">${index + 1}</span>` : ""
          }</button>`,
      )
      .join("");
    const chips = pageTags
      .map(
        (tag) =>
          `<button type="button" data-tag="${tag}" data-group="${tag.split(":")[0]}">${
            tag.split(":")[1]
          }</button>`,
      )
      .join("");
    return `    <figure data-tags="${pageTags.join(" ")}">
      <div class="pages" data-count="${pages.length}" style="--pages:${pages.length}">${thumbs}</div>
      <figcaption><span class="name">${stem}</span><span class="loop">${
        pages.length > 1 ? `${pages.length}p · ` : ""
      }loop ${(longestMs / 1_000).toFixed(1)}s</span></figcaption>
      <div class="card-tags">${chips}</div>
    </figure>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>svgent fixture gallery</title>
<style>
  body { margin: 24px; background: #0d0f14; color: #e9eaf0; font-family: ui-sans-serif, sans-serif; }
  h1 { font-size: 18px; font-weight: 600; }
  p.hint { color: #9aa1b0; font-size: 13px; }
  .filters { display: flex; flex-direction: column; gap: 6px; margin: 14px 0 18px; }
  .filter-row { display: flex; align-items: baseline; gap: 10px; }
  .filter-row > span { flex: none; width: 72px; font-size: 12px; color: #6f7686; font-family: ui-monospace, monospace; }
  .filter-row .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .filter-row button { font-size: 12px; padding: 2px 8px; font-family: ui-monospace, monospace; }
  .filter-row button.is-on { background: #8b7cf6; border-color: #8b7cf6; color: #0d0f14; }
  .filter-row button em { font-style: normal; opacity: 0.55; }
  .filter-bar { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: #9aa1b0; font-family: ui-monospace, monospace; }
  figure[hidden] { display: none; }
  /* The same chips as the filter rows, so what a card is and what you can
     narrow by are one vocabulary rather than two. */
  .card-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .card-tags button { font-size: 10.5px; line-height: 1.5; padding: 1px 6px; border-radius: 999px; font-family: ui-monospace, monospace; color: #8790a3; }
  .card-tags button[data-group="surface"] { color: #8b7cf6; border-color: #3b3560; }
  .card-tags button[data-group="uses"] { color: #7fb2d8; }
  .card-tags button.is-on { background: #8b7cf6; border-color: #8b7cf6; color: #0d0f14; }
  /* Masonry: the corpus mixes 16:9, square, 4:5 and 9:16 canvases, and a
     plain grid pads every row out to the tallest card in it. Multi-column
     packs them everywhere today; Grid Lanes does the same in DOM order
     where it exists (Safari 26.4+), so reading order survives there. */
  .grid { columns: 380px; column-gap: 20px; }
  figure { margin: 0 0 20px; break-inside: avoid; }
  @supports (display: grid-lanes) {
    .grid {
      display: grid-lanes;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
      gap: 20px;
      columns: auto;
    }
    figure { margin-bottom: 0; }
  }
  /* A deck's pages share one card and split its width, so a four-slide
     sample reads as one sample instead of four cards adrift in the lanes. */
  .pages { display: grid; grid-template-columns: repeat(var(--pages, 1), 1fr); gap: 4px; }
  .pages .page { padding: 0; border: 0; background: none; display: block; position: relative; cursor: zoom-in; }
  .pages .page-no { position: absolute; left: 4px; top: 4px; padding: 0 5px; border-radius: 999px; background: rgba(13, 15, 20, 0.78); color: #9aa1b0; font-family: ui-monospace, monospace; font-size: 10px; }
  figure img { width: 100%; height: auto; border-radius: 6px; border: 1px solid #2a2e39; background: #090a0f; display: block; }
  figcaption { margin-top: 6px; font-size: 11.5px; color: #9aa1b0; font-family: ui-monospace, monospace; display: flex; justify-content: space-between; gap: 8px; }
  figcaption .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  figcaption .loop { flex: none; }
  button { background: #171a23; color: #8b7cf6; border: 1px solid #2a2e39; border-radius: 6px; font: inherit; padding: 2px 8px; cursor: pointer; }
  button:hover { border-color: #8b7cf6; }
  /* Fixed geometry: fixtures range from a wide desktop frame to a tall
     phone one, and a dialog that sized itself to each one moved the
     prev/next buttons out from under the pointer on every step. */
  dialog { background: #0d0f14; color: #e9eaf0; border: 1px solid #2a2e39; border-radius: 12px; padding: 0; width: 96vw; height: 92vh; max-width: none; max-height: none; overflow: hidden; }
  dialog[open] { display: flex; flex-direction: column; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.72); }
  dialog .head { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid #2a2e39; font-family: ui-monospace, monospace; font-size: 13px; color: #9aa1b0; flex: none; }
  dialog .head .name { color: #e9eaf0; }
  dialog .head .close { margin-left: auto; font-size: 15px; line-height: 1; padding: 4px 10px; }
  .edge { position: absolute; top: 50%; transform: translateY(-50%); z-index: 2; width: 42px; height: 108px; font-size: 26px; line-height: 1; display: grid; place-items: center; background: rgba(13, 15, 20, 0.82); }
  .edge.prev { left: 8px; }
  .edge.next { right: 8px; }
  .compare { flex: 1 1 auto; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 58px; }
  .compare img { display: block; border-radius: 8px; background: #090a0f; }
  .compare .hero img { max-width: 100%; max-height: 56vh; width: auto; margin: 0 auto; cursor: zoom-in; }
  .stills { display: flex; gap: 12px; align-items: flex-start; }
  .stills > div { flex: 1 1 0; min-width: 0; }
  .stills img { width: 100%; height: auto; max-height: 26vh; object-fit: contain; }
  /* Zoomed: real pixels, stacked, and the pane scrolls. */
  .compare.is-zoom .stills { display: block; }
  .compare.is-zoom .stills > div + div { margin-top: 12px; }
  .compare.is-zoom img { width: calc(var(--w) * var(--zoom)); max-width: none; max-height: none; height: auto; object-fit: fill; margin: 0; cursor: zoom-out; }
  .compare .label { font-family: ui-monospace, monospace; font-size: 12px; color: #9aa1b0; margin-bottom: 6px; }
  dialog .bar { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid #2a2e39; font-family: ui-monospace, monospace; font-size: 13px; color: #9aa1b0; flex: none; }
  dialog .bar .hint { margin-right: auto; }
  dialog .bar .level { min-width: 44px; text-align: center; }
</style>
</head>
<body>
<h1>svgent fixture gallery</h1>
<p class="hint">Every input pattern in fixtures/scripts (${decks.size} samples / ${bases.length} pages; a multi-page script shares one card). The grid loops each animation. Click to enlarge: the animation on top, with the final frame and the full transcript (unscrolled) side by side below (←/→ to move, Esc to close, +/- or a click on the image to zoom). Regenerate with <code>pnpm render:fixtures</code>.</p>

<div class="filters">
${filterRows}
  <div class="filter-bar">
    <button type="button" id="filter-clear">Show all</button>
    <span id="filter-count"></span>
  </div>
</div>

<div class="grid">
${cards}
</div>

<dialog id="lightbox">
  <div class="head">
    <span class="name"></span>
    <span class="dims"></span>
    <button type="button" class="close" data-act="close" aria-label="close">✕</button>
  </div>
  <button type="button" class="edge prev" data-act="prev" aria-label="previous">‹</button>
  <button type="button" class="edge next" data-act="next" aria-label="next">›</button>
  <div class="compare">
    <div class="hero"><div class="label">animation (loop)</div><img class="anim" alt="animation" /></div>
    <div class="stills">
      <div><div class="label">final frame (poster)</div><img class="poster" alt="poster" /></div>
      <div><div class="label">full transcript (unscrolled)</div><img class="full" alt="full transcript" /></div>
    </div>
  </div>
  <div class="bar">
    <span class="hint">←/→ move · Esc close · click the image to toggle actual size</span>
    <button type="button" data-act="zoom-out" aria-label="zoom out">−</button>
    <span class="level">fit</span>
    <button type="button" data-act="zoom-in" aria-label="zoom in">+</button>
    <button type="button" data-act="zoom-fit">fit</button>
    <button type="button" data-act="replay">⟳ replay</button>
    <button type="button" data-act="prev">← prev</button>
    <button type="button" data-act="next">next →</button>
  </div>
</dialog>

<script>
  const bases = ${JSON.stringify(bases)};
  const durations = ${JSON.stringify(durations)};
  const widths = ${JSON.stringify(widths)};
  const HOLD_MS = 700;
  // Cache-busting query restarts the animated SVG from t=0.
  const animSrc = (base) => "./" + base + ".animated.svg?t=" + Date.now();

  // Loop = reload the play-once animated SVG after its scene duration, but
  // only while the card is on screen so 24 scenes do not churn at once.
  const timers = new Map();
  // A card can hold several pages, each looping on its own scene duration.
  const pagesOf = (figure) => [...figure.querySelectorAll(".page")];
  const startLoop = (figure) => {
    for (const page of pagesOf(figure)) {
      const base = page.dataset.base;
      if (timers.has(base)) {
        continue;
      }
      const replay = () => {
        page.querySelector("img").src = animSrc(base);
      };
      replay();
      timers.set(base, setInterval(replay, (durations[base] ?? 10_000) + HOLD_MS));
    }
  };
  const stopLoop = (figure) => {
    for (const page of pagesOf(figure)) {
      clearInterval(timers.get(page.dataset.base));
      timers.delete(page.dataset.base);
    }
  };
  // Filtering: chips within a row are alternatives, rows are combined —
  // "TUI and slides", never "TUI or slides", which is the only reading that
  // narrows as more chips are pressed.
  const figures = [...document.querySelectorAll(".grid figure")];
  const chips = [...document.querySelectorAll("[data-tag]")];
  const selected = new Set();
  const applyFilters = () => {
    const groups = new Map();
    for (const tag of selected) {
      const prefix = tag.split(":")[0];
      groups.set(prefix, [...(groups.get(prefix) ?? []), tag]);
    }
    let shown = 0;
    for (const figure of figures) {
      const own = (figure.dataset.tags ?? "").split(" ");
      const matches = [...groups.values()].every((row) => row.some((tag) => own.includes(tag)));
      figure.hidden = !matches;
      if (matches) {
        shown += 1;
      }
    }
    for (const chip of chips) {
      chip.classList.toggle("is-on", selected.has(chip.dataset.tag));
    }
    document.getElementById("filter-count").textContent =
      shown === figures.length
        ? figures.length + " samples"
        : shown + " / " + figures.length + " samples";
  };
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const tag = chip.dataset.tag;
      if (selected.has(tag)) {
        selected.delete(tag);
      } else {
        selected.add(tag);
      }
      applyFilters();
    });
  }
  document.getElementById("filter-clear").addEventListener("click", () => {
    selected.clear();
    applyFilters();
  });
  applyFilters();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          startLoop(entry.target);
        } else if (!entry.isIntersecting) {
          stopLoop(entry.target);
        }
      }
    },
    { threshold: 0.1 },
  );
  for (const figure of document.querySelectorAll(".grid figure")) {
    observer.observe(figure);
    for (const page of figure.querySelectorAll(".page")) {
      page.addEventListener("click", () => {
        openLightbox(bases.indexOf(page.dataset.base));
      });
    }
    for (const chip of figure.querySelectorAll(".card-tags button")) {
      chip.addEventListener("click", (event) => event.stopPropagation());
    }
  }

  const lightbox = document.getElementById("lightbox");
  const compare = lightbox.querySelector(".compare");
  const STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];
  let current = 0;
  let lightboxTimer = 0;
  // null = fit the pane; a number is a real-pixel multiplier of the canvas.
  let zoom = null;

  const applyZoom = () => {
    const width = widths[bases[current]] ?? 1080;
    compare.style.setProperty("--w", width + "px");
    compare.style.setProperty("--zoom", String(zoom ?? 1));
    compare.classList.toggle("is-zoom", zoom !== null);
    lightbox.querySelector(".level").textContent =
      zoom === null ? "fit" : Math.round(zoom * 100) + "%";
  };
  const setZoom = (next) => {
    zoom = next;
    applyZoom();
  };
  // Where "fit" currently sits on the same scale, so the first step out of
  // it moves by one notch from what is on screen rather than jumping.
  const fitRatio = () => {
    const width = widths[bases[current]] ?? 1080;
    const shown = lightbox.querySelector("img.anim").getBoundingClientRect().width;
    return shown > 0 ? shown / width : 1;
  };
  const stepZoom = (direction) => {
    const from = zoom ?? fitRatio();
    const next =
      direction > 0
        ? STEPS.find((step) => step > from + 0.001)
        : STEPS.filter((step) => step < from - 0.001).pop();
    setZoom(next ?? from);
  };

  const applyLightbox = () => {
    const base = bases[current];
    clearInterval(lightboxTimer);
    const replay = () => {
      lightbox.querySelector("img.anim").src = animSrc(base);
    };
    replay();
    lightboxTimer = setInterval(replay, (durations[base] ?? 10_000) + HOLD_MS);
    lightbox.querySelector("img.poster").src = "./" + base + ".png";
    lightbox.querySelector("img.full").src = "./" + base + ".transcript.png";
    lightbox.querySelector(".head .name").textContent = base;
    lightbox.querySelector(".dims").textContent = (widths[base] ?? "?") + "px wide";
    applyZoom();
  };
  const visibleBases = () => {
    const shown = figures
      .filter((figure) => !figure.hidden)
      .flatMap((figure) => [...figure.querySelectorAll(".page")].map((page) => page.dataset.base));
    return shown.length > 0 ? shown : bases;
  };
  const openLightbox = (index) => {
    // Stepping stays inside whatever the filters left on screen.
    const ring = visibleBases();
    const from = ring.indexOf(bases[current]);
    const step = index - current;
    current = bases.indexOf(
      from === -1 ? ring[0] : ring[(((from + step) % ring.length) + ring.length) % ring.length],
    );
    // Each fixture is judged on its own terms, so a new one opens fit.
    zoom = null;
    compare.scrollTo(0, 0);
    applyLightbox();
    if (!lightbox.open) {
      lightbox.showModal();
    }
  };
  lightbox.addEventListener("close", () => clearInterval(lightboxTimer));
  for (const button of lightbox.querySelectorAll('[data-act="prev"]')) {
    button.addEventListener("click", () => openLightbox(current - 1));
  }
  for (const button of lightbox.querySelectorAll('[data-act="next"]')) {
    button.addEventListener("click", () => openLightbox(current + 1));
  }
  lightbox.querySelector('[data-act="replay"]').addEventListener("click", () => applyLightbox());
  lightbox.querySelector('[data-act="close"]').addEventListener("click", () => lightbox.close());
  lightbox.querySelector('[data-act="zoom-in"]').addEventListener("click", () => stepZoom(1));
  lightbox.querySelector('[data-act="zoom-out"]').addEventListener("click", () => stepZoom(-1));
  lightbox.querySelector('[data-act="zoom-fit"]').addEventListener("click", () => setZoom(null));
  for (const image of compare.querySelectorAll("img")) {
    image.addEventListener("click", () => setZoom(zoom === null ? 1 : null));
  }
  document.addEventListener("keydown", (event) => {
    if (!lightbox.open) {
      return;
    }
    if (event.key === "ArrowLeft") {
      openLightbox(current - 1);
    }
    if (event.key === "ArrowRight") {
      openLightbox(current + 1);
    }
    if (event.key === "+" || event.key === "=") {
      stepZoom(1);
    }
    if (event.key === "-") {
      stepZoom(-1);
    }
    if (event.key === "0") {
      setZoom(null);
    }
  });
</script>
</body>
</html>
`;

await writeFile(path.join(outDir, "index.html"), html);
console.info(path.join(outDir, "index.html"));
