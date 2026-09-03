import { readdir, readFile } from "node:fs/promises";
import { createEngineAsync, type Engine, validate } from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES, GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import { renderArtifact } from "@svgent/render";
import {
  buildSvgentScene,
  bundledFallbackFonts,
  collectChromeCharacters,
  collectProjectCharacters,
  DEFAULT_PROJECT,
  deserializeProject,
  FONT_ALIAS,
  findMissingGlyphs,
  findProjectMissingGlyphs,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FIXTURES_URL = new URL("../../fixtures/scripts/", import.meta.url);
const TEST_GENERATOR = { name: "svgent-test", version: "1.0.0" } as const;

/**
 * Every fixture in fixtures/scripts must import, build valid scenes for all
 * of its pages, and render page 1 through the real engine — this is the
 * pre-GUI safety net for exotic user input. `warnings-` fixtures exist to
 * exercise the clamping path and are the only ones allowed (required, even)
 * to produce import warnings.
 */
let names: string[] = [];
let engine: Engine;

beforeAll(async () => {
  names = (await readdir(FIXTURES_URL)).filter((name) => name.endsWith(".json")).sort();
  await initNodeWasm();
  const loadFont = async (file: string) => new Uint8Array(await readFile(bundledFontPath(file)));
  engine = await createEngineAsync({
    fonts: [
      {
        alias: FONT_ALIAS.sans,
        weight: 400,
        style: "normal",
        data: await loadFont("NotoSansJP-Regular.subset.woff2"),
      },
      {
        alias: FONT_ALIAS.mono,
        weight: 400,
        style: "normal",
        data: await loadFont("JetBrainsMono-Regular.woff2"),
      },
      // The scene names these aliases in its fallback chains.
      ...(await bundledFallbackFonts((slot) => loadFont(BUNDLED_FONT_FILES[slot]))),
    ],
  });
});

afterAll(() => {
  engine?.dispose();
});

describe("fixture script corpus", () => {
  it("has the corpus in place", () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
  });

  it("imports and builds valid scenes for every fixture and page", async () => {
    for (const name of names) {
      const source = await readFile(new URL(name, FIXTURES_URL), "utf8");
      const { project, warnings } = deserializeProject(source);
      if (name.startsWith("warnings-")) {
        expect(warnings.length, `${name} should exercise the warning path`).toBeGreaterThan(0);
      } else {
        expect(warnings, `${name} should import cleanly`).toEqual([]);
      }

      const pageCount = buildSvgentScene(project, 0).pageCount;
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const scene = buildSvgentScene(project, pageIndex, {
          engine,
          generator: TEST_GENERATOR,
          fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
        });
        expect(scene.durationMs, `${name} page ${pageIndex + 1}`).toBeGreaterThan(0);
        expect(() => validate(scene.vnode), `${name} page ${pageIndex + 1}`).not.toThrow();
      }

      // One real render per fixture: validation cannot catch wasm-level
      // layout or shaping failures.
      const svg = renderArtifact(
        engine,
        buildSvgentScene(project, 0, {
          engine,
          generator: TEST_GENERATOR,
          fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
        }),
        "poster-svg",
      );
      expect(svg, name).toContain("<svg");

      // Full-height poster variant (no scroll viewport) must stay valid too.
      const fullScene = buildSvgentScene(project, 0, {
        fullHeight: true,
        engine,
        generator: TEST_GENERATOR,
        fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
      });
      expect(() => validate(fullScene.vnode), `${name} full`).not.toThrow();
      const fullSvg = renderArtifact(engine, fullScene, "poster-svg");
      expect(fullSvg, `${name} full`).toContain("<svg");
    }
    // Two real renders per fixture through wasm land this near vitest's 5s
    // default, so a loaded machine fails it for timing rather than breakage.
  }, 60_000);

  /**
   * The animated SVG rides the document timeline, which narrows what a track
   * may author — finite values in the timeline domain, repeating tracks that
   * end where they began. A scene that steps outside still renders as a
   * poster but throws as an animated SVG, so every fixture is compiled both
   * ways it can play.
   */
  it("compiles every fixture onto the animated SVG timeline, looping and once", async () => {
    for (const name of names) {
      const source = await readFile(new URL(name, FIXTURES_URL), "utf8");
      const { project } = deserializeProject(source);
      const scene = buildSvgentScene(project, 0, {
        engine,
        generator: TEST_GENERATOR,
        fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
      });
      const looping = renderArtifact(engine, scene, "animated-svg");
      expect(looping, name).toContain("<svg");
      expect(looping, `${name} should loop by default`).toContain("infinite");
      const once = renderArtifact(engine, scene, {
        kind: "animated-svg",
        animatedSvgIterations: "once",
      });
      expect(once, `${name} played once should declare no infinite animation`).not.toContain(
        "infinite",
      );
    }
  }, 60_000);
});

describe("font coverage", () => {
  /**
   * The preventive check: everything svgent draws on its own account has to be
   * in the fonts that ship with it. A new spinner frame, box character, or
   * status word the bundled pair lacks fails here the moment it is written —
   * rather than reaching a user as a box, on whichever font they happened to
   * pick. Author text is a separate problem, handled by the runtime warning.
   */
  it("covers every character svgent itself draws with the bundled fonts", () => {
    const chrome = collectChromeCharacters();
    expect(chrome.length).toBeGreaterThan(80);
    expect(findMissingGlyphs(engine, chrome)).toEqual([]);
  });

  it("requests every character the scene will draw", async () => {
    // The subset request is what Google Fonts is asked for; anything drawn but
    // unrequested comes back absent and renders as tofu.
    const gaps: string[] = [];
    for (const name of names) {
      const source = await readFile(new URL(name, FIXTURES_URL), "utf8");
      const { project } = deserializeProject(source, "en");
      const requested = new Set(collectProjectCharacters(project));
      const drawn = new Set<string>();
      const pageCount = buildSvgentScene(project, 0).pageCount;
      for (let page = 0; page < pageCount; page += 1) {
        const scene = buildSvgentScene(project, page, { engine });
        for (const node of engine.renderToTextOutlines(scene.vnode, {
          showMissingGlyphs: true,
        })) {
          for (const character of node.text) {
            drawn.add(character);
          }
        }
      }
      const unrequested = [...drawn].filter(
        (character) => character.trim() !== "" && !requested.has(character),
      );
      if (unrequested.length > 0) {
        gaps.push(`${name}: ${unrequested.join("")}`);
      }
    }
    expect(gaps).toEqual([]);
    // Same budget as the corpus test above, and for the same reason: this walks
    // every fixture through the engine. It ran in 2.8s on an idle machine and
    // 4.9s under load, which left it failing the 5s default about half the time
    // — a timeout that close to the work is a coin toss, not a check.
  }, 60_000);

  // No shipped script may render a box. A sample that always shows tofu on the
  // fonts svgent ships with is a broken sample, whatever it was meant to
  // exercise — the detection itself is covered below without shipping one.
  it("renders every shipped script with no tofu at all", async () => {
    const offenders: string[] = [];
    for (const name of names) {
      const source = await readFile(new URL(name, FIXTURES_URL), "utf8");
      const { project } = deserializeProject(source, "en");
      const missing = findProjectMissingGlyphs(engine, project).join("");
      if (missing !== "") {
        offenders.push(`${name}: ${missing}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still detects glyphs the bundled fonts do not carry", () => {
    // Emoji and Hangul are outside the bundled subset, and always will be —
    // the point is that an author is told rather than shipped boxes.
    expect(findMissingGlyphs(engine, "🚀한")).toEqual(["한", "🚀"]);
    expect(findMissingGlyphs(engine, "日本語 and English")).toEqual([]);
  });

  it("agrees with a full scene scan about what is missing", () => {
    // findMissingGlyphs probes the character set instead of the transcript for
    // speed; this pins that shortcut to the ground truth it stands in for.
    // Built here rather than shipped as a fixture, because no sample of ours
    // should render boxes.
    const project = {
      ...DEFAULT_PROJECT,
      messages: [
        { id: "a", role: "user" as const, content: "絵文字🎨と한국어" },
        { id: "b", role: "assistant" as const, content: "Emoji: 🚀✨ / 狐" },
      ],
    };
    const scanned = new Set<string>();
    const pageCount = buildSvgentScene(project, 0).pageCount;
    for (let page = 0; page < pageCount; page += 1) {
      const scene = buildSvgentScene(project, page, { engine });
      for (const node of engine.renderToTextOutlines(scene.vnode, {
        showMissingGlyphs: true,
      })) {
        for (const path of node.paths) {
          if (path.missingGlyph === true) {
            for (const character of path.text) {
              scanned.add(character);
            }
          }
        }
      }
    }
    expect(scanned.size).toBeGreaterThan(0);
    expect(findMissingGlyphs(engine, collectProjectCharacters(project))).toEqual(
      [...scanned].sort(),
    );
  });
});
