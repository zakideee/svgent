/**
 * Geometry that has to survive the settings the importer accepts.
 *
 * Padding is authored in px and then scaled by the type, so a large scale asks
 * for more inset than a small canvas has room for. Asked plainly,
 * `available - inset * 2` goes negative, and a negative width is not a cramped
 * drawing — the engine refuses the scene and nothing renders at all.
 *
 * Every combination here is inside the ranges the importer accepts, so anything
 * that fails is reachable by a script someone can write — and the studio and an
 * authoring patch reach the builders without passing through the importer at
 * all, so the same corners are checked from that side too.
 */

import { readdir, readFile } from "node:fs/promises";
import { createEngineAsync, type Engine, type LayoutNode } from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  deserializeProject,
  FONT_ALIAS,
  type SvgentProject,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let engine: Engine;

beforeAll(async () => {
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
      ...(await bundledFallbackFonts((slot) => loadFont(BUNDLED_FONT_FILES[slot]))),
    ],
  });
});

afterAll(() => engine?.dispose());

/** The smallest canvas the importer will keep, and the largest scales it allows. */
const CANVASES = [
  [640, 480],
  [800, 600],
  [1920, 1080],
] as const;
const MARGINS = [0, 64, 140] as const;
const PADDINGS = [0, 20, 80] as const;
/** Narrower than this and the column is not worth calling a transcript. */
const MIN_READABLE_BAND_PX = 40;

const SCALES = [
  [1, 1],
  [5, 1.6],
] as const;

/** What the importer keeps, so the sweep only covers settings a script can carry. */
function imported(over: Partial<SvgentProject["appearance"]>, surface: "app" | "tui") {
  const source = JSON.stringify({
    ...DEFAULT_PROJECT,
    surface,
    // Fenced code reaches furthest down the chain: a row gives a bubble, a
    // bubble gives markdown, markdown gives a code block with its own padding
    // and line-number gutter. A plain sentence stops short of all of it.
    messages: [
      ...DEFAULT_PROJECT.messages,
      { role: "user", content: "```js\nconst a = 1;\n```" },
      { role: "assistant", content: "```js\nconst b = 2;\n```" },
    ],
    appearance: { ...DEFAULT_PROJECT.appearance, ...over },
  });
  return deserializeProject(source) as unknown as {
    project: SvgentProject;
    warnings: string[];
  };
}

/** Every setting the sweep covers, as one flat list. */
function everySetting(): Array<Partial<SvgentProject["appearance"]>> {
  const settings: Array<Partial<SvgentProject["appearance"]>> = [];
  for (const [canvasWidth, canvasHeight] of CANVASES) {
    for (const windowMargin of MARGINS) {
      for (const windowPaddingX of PADDINGS) {
        for (const [fontScale, spacingScale] of SCALES) {
          settings.push({
            canvasWidth,
            canvasHeight,
            windowMargin,
            windowPaddingX,
            fontScale,
            spacingScale,
          });
        }
      }
    }
  }
  return settings;
}

function label(settings: Partial<SvgentProject["appearance"]>): string {
  return `${settings.canvasWidth}x${settings.canvasHeight} margin=${settings.windowMargin} padX=${settings.windowPaddingX} font=${settings.fontScale} spacing=${settings.spacingScale}`;
}

/** What the engine says when asked to lay the scene out, or nothing. */
function refusal(project: SvgentProject): string | null {
  try {
    const scene = buildSvgentScene(project, 0, { engine, fullHeight: false });
    engine.renderToLayoutTree(scene.vnode, {});
    return null;
  } catch (error) {
    return String(error).split("\n")[0] ?? "refused";
  }
}

describe("a scene the importer accepts renders", () => {
  for (const surface of ["app", "tui"] as const) {
    it(`${surface}: no accepted combination is refused`, () => {
      const refused = everySetting()
        .map((settings) => ({ settings, ...imported(settings, surface) }))
        .map((entry) => {
          const why = refusal(entry.project);
          return why === null ? null : `${label(entry.settings)}: ${why}`;
        })
        .filter((row): row is string => row !== null);
      expect(refused, "the importer accepted settings the engine will not draw").toEqual([]);
      // Every sweep here walks 54 settings through the engine, ~3s idle and
      // past the 5s default under load — a timeout that close to the work is
      // a coin toss, not a check. Same budget as the fixture corpus tests.
    }, 60_000);
  }
});

/**
 * The importer is not the only door. The studio edits appearance on the project
 * it already holds and builds the scene from it, and an authoring patch does the
 * same; neither passes through `deserializeProject`. What those doors let in has
 * to draw too.
 */
describe("a project built without the importer", () => {
  for (const surface of ["app", "tui"] as const) {
    it(`${surface}: still draws at the corners`, () => {
      const refused = everySetting()
        .map((over) => {
          const project: SvgentProject = {
            ...DEFAULT_PROJECT,
            surface,
            appearance: { ...DEFAULT_PROJECT.appearance, ...over },
          };
          const why = refusal(project);
          return why === null ? null : `${label(over)}: ${why}`;
        })
        .filter((row): row is string => row !== null);
      expect(refused, "a scene built without the importer was refused").toEqual([]);
    }, 60_000);
  }
});

/**
 * Drawing is the floor, not the goal. A column clamped to nothing satisfies the
 * engine and tells the reader nothing, so the corners have to leave something
 * behind to read.
 */
describe("what the corners leave to read", () => {
  it("keeps a transcript band wider than nothing", () => {
    const thin: string[] = [];
    for (const over of everySetting()) {
      const { project } = imported(over, "app");
      const scene = buildSvgentScene(project, 0, { engine, fullHeight: false });
      const root = engine.renderToLayoutTree(scene.vnode, {}).root;
      let band: { x: number; width: number } | null = null;
      const walk = (node: LayoutNode): void => {
        const meta = (node.vnode as { props?: { meta?: Record<string, string> } }).props?.meta;
        if (band === null && meta?.band === "transcript") {
          band = { x: node.bbox.x, width: node.bbox.width };
        }
        for (const child of node.children ?? []) {
          walk(child);
        }
      };
      walk(root);
      const measured = band as { x: number; width: number } | null;
      if (measured === null || measured.width < MIN_READABLE_BAND_PX) {
        thin.push(
          `${label(over)}: band=${measured === null ? "none" : Math.round(measured.width)}`,
        );
      }
    }
    expect(thin, "a corner left a transcript column too narrow to read").toEqual([]);
  }, 60_000);
});

/**
 * The clamp at the end of the build is for authored extremes, not for the
 * defaults. A shipped script that needs it has a builder computing a negative
 * value on ordinary input, and the clamp would swallow that regression without
 * a trace — so the count it reports stays pinned at zero here.
 */
describe("the scripts that ship", () => {
  it("build without the final clamp touching anything", async () => {
    const touched: string[] = [];
    let seen = 0;
    for (const dir of ["fixtures/scripts", "examples"]) {
      const root = new URL(`../../../${dir}/`, import.meta.url);
      const names = (await readdir(root)).filter((name) => name.endsWith(".json"));
      for (const name of names) {
        const source = await readFile(new URL(name, root), "utf8");
        const { project } = deserializeProject(source) as unknown as { project: SvgentProject };
        seen += 1;
        let pageCount = 1;
        for (let page = 0; page < pageCount; page += 1) {
          const scene = buildSvgentScene(project, page, { engine, fullHeight: false });
          pageCount = scene.pageCount;
          if (scene.clampedPropCount > 0) {
            touched.push(`${dir}/${name} page ${page + 1}: ${scene.clampedPropCount} clamped`);
          }
        }
      }
    }
    expect(seen, "no scripts were read").toBeGreaterThan(0);
    expect(touched, "the final clamp fired on a script that ships").toEqual([]);
  }, 60_000);
});
