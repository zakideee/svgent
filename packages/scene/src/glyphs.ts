/**
 * Which characters a project needs a font for, and which ones no loaded font
 * could draw.
 *
 * The subset request has to name every character the scene will draw, not just
 * the ones the author typed: the renderers generate their own text — approval
 * wording, image-card labels, the shimmer, a link marker — and choose the
 * Japanese variant from the message content. A hand-kept list of that chrome
 * drifts from the code that emits it, so the set is read back off the built
 * scene instead.
 */

import { Canvas, type Engine, Text } from "@boundsvg/core";
import { SANS_FALLBACK, SANS_FONT } from "./env.js";
import { DEFAULT_PROJECT, type SvgentProject } from "./model.js";
import { buildSvgentScene } from "./scene.js";

/**
 * Characters requested even when the current scene does not draw them.
 *
 * Editing is live but the subset is fetched per project, so the font in hand
 * always lags the text being typed by one fetch. Carrying the keyboard's worth
 * of ASCII means the lag is invisible for the common case instead of showing a
 * row of tofu on every keystroke.
 */
const TYPING_HEADROOM_GLYPHS =
  " !\"#$%&'()*+,-./0123456789:;<=>?@" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`" +
  "abcdefghijklmnopqrstuvwxyz{|}~";

/** Collect every string the vnode tree carries, wherever it sits. */
function feedVNodeText(node: unknown, out: Set<string>): void {
  if (typeof node === "string") {
    for (const character of node) {
      out.add(character);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      feedVNodeText(child, out);
    }
    return;
  }
  if (node !== null && typeof node === "object") {
    feedVNodeText((node as { children?: unknown }).children, out);
  }
}

/**
 * Every character the project can put on screen, across all of its pages.
 *
 * Deliberately engine-free: the subset has to be known before a font exists to
 * measure with, and the vnode tree already carries the final text — only
 * layout needs measurement, not the strings themselves.
 */
export function collectProjectCharacters(project: SvgentProject): string {
  const set = new Set<string>(TYPING_HEADROOM_GLYPHS);
  // Both surfaces, not just the active one: the app and the terminal draw
  // different chrome, and a subset tied to the current choice would show tofu
  // for however long the refetch after a surface switch takes.
  for (const surface of ["app", "tui"] as const) {
    const variant = project.surface === surface ? project : { ...project, surface };
    const pageCount = buildSvgentScene(variant, 0).pageCount;
    for (let page = 0; page < pageCount; page += 1) {
      feedVNodeText(buildSvgentScene(variant, page).vnode, set);
    }
  }
  // Alt text rides along: it is not drawn, but it is authored content that a
  // later renderer could surface, and it costs a handful of glyphs.
  for (const message of project.messages) {
    for (const image of message.images ?? []) {
      for (const character of image.alt) {
        set.add(character);
      }
    }
  }
  return [...set].sort().join("");
}

/**
 * Message shapes that between them reach every literal a renderer can emit:
 * one of each role, both approval outcomes, a freeform choice.
 */
const CHROME_PROBE_ROLES = [
  { role: "user", inputMode: "voice" },
  { role: "thinking" },
  { role: "tool", language: "bash" },
  { role: "permission", decision: "allow" },
  { role: "permission", decision: "deny" },
  { role: "permission", decision: "allow-always" },
  { role: "assistant" },
  { role: "image" },
  { role: "choice", chosenIndex: 0 },
  { role: "choice" },
] as const;

/** Every axis that switches a renderer to a different set of literals. */
const CHROME_PROBE_VARIANTS = [
  { imageSkeleton: "dots", flow: "scroll", tuiStatusHints: false },
  { imageSkeleton: "sweep", flow: "slides", tuiStatusHints: true },
  { imageSkeleton: "tiles", flow: "scroll", tuiStatusHints: true },
] as const;

function chromeProbeProject(options: {
  base: SvgentProject;
  filler: string;
  cjkFiller: string;
  parity: 0 | 1;
}) {
  const { base, filler, cjkFiller, parity } = options;
  return {
    ...base,
    title: filler,
    modelLabel: filler,
    workspaceLabel: filler,
    branchLabel: filler,
    messages: CHROME_PROBE_ROLES.map((shape, index) => ({
      ...shape,
      id: `chrome-${index}`,
      // The approval and image wording switches on whether the message reads
      // as CJK, so the probe has to carry both scripts through every role.
      content: index % 2 === parity ? filler : cjkFiller,
      ...(shape.role === "choice" ? { options: [filler, cjkFiller] } : {}),
    })),
  } as SvgentProject;
}

/**
 * Every character svgent draws on its own account — chrome, status wording,
 * spinner frames, the image shimmer — with nothing an author typed.
 *
 * Derived rather than listed. A hand-kept inventory of this is exactly what
 * drifted from the code before and shipped a subset with no plain hyphen in
 * it; two probes that differ only in their filler text isolate the same set
 * without anyone having to remember to update it. Characters common to both
 * runs cannot have come from the filler, so what remains is svgent's own.
 */
export function collectChromeCharacters(): string {
  const chrome = new Set<string>();
  for (const variant of CHROME_PROBE_VARIANTS) {
    // Both parities, so every role is exercised in both chrome languages
    // rather than only the one its position happens to select.
    for (const parity of [0, 1] as const) {
      const base = {
        ...DEFAULT_PROJECT,
        appearance: { ...DEFAULT_PROJECT.appearance, imageSkeleton: variant.imageSkeleton },
        pagination: { ...DEFAULT_PROJECT.pagination, flow: variant.flow },
        display: { ...DEFAULT_PROJECT.display, tuiStatusHints: variant.tuiStatusHints },
      } as SvgentProject;
      const drawn = (
        [
          ["a", "あ"],
          ["b", "い"],
        ] as const
      ).map(([filler, other]) => {
        const seen = new Set<string>();
        const probe = chromeProbeProject({ base, filler, cjkFiller: other, parity });
        for (const surface of ["app", "tui"] as const) {
          const scoped = { ...probe, surface };
          const pageCount = buildSvgentScene(scoped, 0).pageCount;
          for (let page = 0; page < pageCount; page += 1) {
            feedVNodeText(buildSvgentScene(scoped, page).vnode, seen);
          }
        }
        return seen;
      });
      const [first, second] = drawn;
      if (first === undefined || second === undefined) {
        continue;
      }
      for (const character of first) {
        if (second.has(character) && character.trim() !== "") {
          chrome.add(character);
        }
      }
    }
  }
  return [...chrome].sort().join("");
}

/**
 * Characters no loaded font can draw, sorted and de-duplicated.
 *
 * boundsvg reports no warning for a missing glyph — it marks the synthetic
 * tofu outline and moves on — so coverage is read back off the outlines.
 * Probing the character set rather than the scene keeps this cheap enough to
 * run on every edit: cost follows the number of distinct characters, not the
 * size of the transcript.
 *
 * One chain is enough to answer for both. Every chain ends at the same
 * bundled pair, so the two differ in order but not in what they cover.
 */
export function findMissingGlyphs(engine: Engine, characters: string): string[] {
  const probe = [...new Set(characters)].filter((character) => character.trim() !== "").join("");
  if (probe.length === 0) {
    return [];
  }
  const missing = new Set<string>();
  try {
    const nodes = engine.renderToTextOutlines(
      Canvas(
        { width: 8, height: 8 },
        Text({ font: SANS_FONT, fallback: SANS_FALLBACK, fontSizePx: 16, wrap: "none" }, probe),
      ),
      { showMissingGlyphs: true },
    );
    for (const node of nodes) {
      for (const path of node.paths) {
        if (path.missingGlyph === true) {
          for (const character of path.text) {
            missing.add(character);
          }
        }
      }
    }
  } catch {
    // No outline extractor on this engine build — report nothing rather than
    // blocking an export over a diagnostic.
    return [];
  }
  return [...missing].sort();
}

/** Characters of this project that no loaded font can draw. */
export function findProjectMissingGlyphs(engine: Engine, project: SvgentProject): string[] {
  return findMissingGlyphs(engine, collectProjectCharacters(project));
}

/** `狐 (U+72D0)` — what to show a user who has to act on the character. */
export function describeMissingGlyphs(characters: readonly string[], limit = 12): string {
  const shown = characters
    .slice(0, limit)
    .map(
      (character) =>
        `${character} (U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")})`,
    )
    .join(", ");
  return characters.length > limit ? `${shown}, +${characters.length - limit}` : shown;
}
