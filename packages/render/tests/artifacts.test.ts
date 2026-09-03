import { readdir, readFile } from "node:fs/promises";
import {
  RASTER_MAX_LONG_EDGE as BOUNDSVG_RASTER_MAX_LONG_EDGE,
  RASTER_MAX_PIXELS as BOUNDSVG_RASTER_MAX_PIXELS,
  createElement,
  createEngineAsync,
  type Engine,
  MAX_ANIMATION_SVG_PAYLOAD_CHARS,
} from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES, GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  DEFAULT_MOTION_EXPORT_QUALITY,
  documentIdPrefix,
  normalizeIdentifierNamespace,
  payloadSafeFps,
  RASTER_MAX_LONG_EDGE,
  RASTER_MAX_PIXELS,
  RENDERABLE_KINDS,
  type ResolvedRasterScale,
  renderArtifact,
  resolveMotionExportSettings,
  resolveRasterScale,
} from "@svgent/render";
import {
  type BuiltScene,
  buildSvgentScene as buildScene,
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  FONT_ALIAS,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { version as packageVersion } from "../package.json";
import {
  syntheticGif,
  syntheticPng,
  syntheticWebp,
  webpAlphaDeclarations,
} from "./container-fixtures.js";

const packageName = "svgent";
const TEST_GENERATOR = { name: packageName, version: packageVersion } as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

function buildSvgentScene(
  project: Parameters<typeof buildScene>[0],
  pageIndex: number,
  options: Parameters<typeof buildScene>[2] = {},
): BuiltScene {
  return buildScene(project, pageIndex, {
    ...options,
    generator: TEST_GENERATOR,
    fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
  });
}

/** Logical screen size from the GIF header (little-endian). */
/**
 * The loop count a GIF declares, read out of its Netscape application
 * extension. `0` means forever; a GIF that plays once omits the block.
 */
function gifLoopCount(bytes: Uint8Array): number | "absent" {
  for (let at = 0; at + 18 < bytes.length; at += 1) {
    if (bytes[at] !== 0x21 || bytes[at + 1] !== 0xff || bytes[at + 2] !== 0x0b) {
      continue;
    }
    const label = String.fromCharCode(...bytes.slice(at + 3, at + 14));
    if (label !== "NETSCAPE2.0") {
      continue;
    }
    // sub-block: length 3, id 1, then the count little-endian.
    return (bytes[at + 17] ?? 0) * 256 + (bytes[at + 16] ?? 0);
  }
  return "absent";
}

function gifSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/** Width/height straight out of the PNG IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function containsAscii(bytes: Uint8Array, text: string): boolean {
  const needle = new TextEncoder().encode(text);
  return bytes.some((_byte, offset) =>
    needle.every((needleByte, needleOffset) => bytes[offset + needleOffset] === needleByte),
  );
}

function tinyAnimatedScene(): BuiltScene {
  return {
    vnode: createElement(
      "Canvas",
      // renderArtifact refuses a scene whose canvas declares no provenance,
      // exactly as buildSvgentScene stamps it.
      { width: 8, height: 4, meta: { simulated: "true", "model-kind": "fictional" } },
      createElement("Box", { width: 8, height: 4, background: "#8b7cf6" }),
    ),
    durationMs: 100,
    pageCount: 1,
    pageIndex: 0,
    fileStem: "svgent-test-01",
    messageRevealMs: {},
    messagePage: {},
    messageTimings: [],
    // A hand-built vnode has no measured blocks to disagree about.
    measured: true,
    clampedPropCount: 0,
    generator: TEST_GENERATOR,
  };
}

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
      // The scene names these aliases in its fallback chains.
      ...(await bundledFallbackFonts((slot) => loadFont(BUNDLED_FONT_FILES[slot]))),
    ],
  });
});

afterAll(() => {
  engine?.dispose();
});

describe("headless artifact rendering", () => {
  it("uses the identity supplied by the owning runtime", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0);
    expect(scene.generator).toEqual(TEST_GENERATOR);
  });

  it("renders a poster SVG through the node engine", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    const svg = renderArtifact(engine, scene, "poster-svg");
    expect(typeof svg).toBe("string");
    expect(svg).toContain("<svg");
    expect(svg).toContain('simulated="true"');
    expect(svg).toContain("data:image/webp;base64,");
    expect(svg).toContain(
      `<metadata data-boundsvg-generator="${packageName}" data-boundsvg-generator-version="${packageVersion}"/>`,
    );
  });

  it.each(["app", "tui"] as const)("keeps %s scrub actions in rendered SVG metadata", (surface) => {
    const project = {
      ...DEFAULT_PROJECT,
      surface,
      messages: [
        { id: "choice", role: "choice" as const, content: "Choose", options: ["A", "B"] },
        { id: "permission", role: "permission" as const, content: "Edit files" },
        { id: "image", role: "image" as const, content: "Draw" },
      ],
    };
    const svg = renderArtifact(engine, buildSvgentScene(project, 0, { engine }), "poster-svg");
    expect(svg).toContain('data-boundsvg-meta-action="compose-user"');
    expect(svg).toContain('data-boundsvg-meta-action="select-choice"');
    expect(svg).toContain('data-boundsvg-meta-action="approve"');
    expect(svg).toContain('data-boundsvg-meta-action="replace-image"');
    expect(svg).toContain('data-boundsvg-meta-message-id="choice"');
  });

  it("renders a poster PNG with its generator identity", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    const png = renderArtifact(engine, scene, "poster-png");
    expect(png).toBeInstanceOf(Uint8Array);
    expect(Array.from((png as Uint8Array).slice(0, 4))).toEqual(PNG_SIGNATURE);
    expect(containsAscii(png as Uint8Array, `${packageName}/${packageVersion}`)).toBe(true);
    expect(containsAscii(png as Uint8Array, '{"simulated":true,"model-kind":"fictional"}')).toBe(
      true,
    );
    expect(renderArtifact(engine, scene, "poster-png")).toEqual(png);
  });

  it("embeds the identity in still WebP, animated WebP, and GIF containers", () => {
    const scene = tinyAnimatedScene();
    const stillWebp = renderArtifact(engine, scene, "poster-webp") as Uint8Array;
    const animatedWebp = renderArtifact(engine, scene, "animated-webp") as Uint8Array;
    const gif = renderArtifact(engine, scene, "gif") as Uint8Array;

    expect(containsAscii(stillWebp, `<boundsvg:name>${packageName}</boundsvg:name>`)).toBe(true);
    expect(containsAscii(animatedWebp, `<boundsvg:name>${packageName}</boundsvg:name>`)).toBe(true);
    expect(
      containsAscii(
        gif,
        `boundsvg-generator:{"name":"${packageName}","version":"${packageVersion}"}`,
      ),
    ).toBe(true);

    // The engine embeds only its generator identity; the provenance stamp
    // rides on the same containers.
    expect(containsAscii(stillWebp, "<svgent:simulated>true</svgent:simulated>")).toBe(true);
    expect(containsAscii(animatedWebp, "<svgent:simulated>true</svgent:simulated>")).toBe(true);
    expect(containsAscii(gif, '{"simulated":true,"model-kind":"fictional"}')).toBe(true);

    // The engine's still lossless output declares alpha in VP8L but not in
    // VP8X; the shipped file must not contradict itself.
    expect(webpAlphaDeclarations(stillWebp)).not.toMatchObject({
      vp8xAlpha: false,
      vp8lAlpha: true,
    });
  });

  it("refuses to draw a scene the engine never measured", () => {
    // Estimated block geometry drawn by a real engine is how a block ends up
    // with a hole in it, or on top of the next one.
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0);
    expect(scene.measured).toBe(false);
    expect(() => renderArtifact(engine, scene, "poster-svg")).toThrow(/without an engine/u);
  });

  it.each(RENDERABLE_KINDS)("keeps %s bytes deterministic with metadata", (kind) => {
    const scene = tinyAnimatedScene();
    expect(renderArtifact(engine, scene, kind)).toEqual(renderArtifact(engine, scene, kind));
  });

  it("keeps embedded generator metadata when the visible product mark is hidden", () => {
    const scene = buildSvgentScene(
      {
        ...DEFAULT_PROJECT,
        display: {
          ...DEFAULT_PROJECT.display,
          productMark: false,
          productVersion: false,
        },
      },
      0,
      { engine },
    );
    const svg = renderArtifact(engine, scene, "poster-svg");
    expect(svg).toContain(`data-boundsvg-generator="${packageName}"`);
    expect(svg).not.toContain(`data-boundsvg-text="${packageName} v${packageVersion}"`);
  });

  it("forwards the generator identity to every shared final-container renderer", () => {
    // Raster results pass through the provenance stamp, which parses the
    // container — the mocked bytes have to be minimally valid files.
    const renderToSvg = vi.fn((_input: unknown, _options?: unknown) => "<svg/>");
    const renderToAnimatedSvg = vi.fn((_input: unknown, _options?: unknown) => "<svg/>");
    const renderToPng = vi.fn((_input: unknown, _options?: unknown) => syntheticPng());
    const renderToWebp = vi.fn((_input: unknown, _options?: unknown) => syntheticWebp());
    const renderToAnimatedWebp = vi.fn((_input: unknown, _options?: unknown) => syntheticWebp());
    const renderToAnimatedGif = vi.fn((_input: unknown, _options?: unknown) => syntheticGif(true));
    const mockEngine = {
      renderToSvg,
      renderToAnimatedSvg,
      renderToPng,
      renderToWebp,
      renderToAnimatedWebp,
      renderToAnimatedGif,
    } as unknown as Engine;
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });

    renderArtifact(mockEngine, scene, "poster-svg");
    expect(renderToSvg.mock.calls.at(-1)?.[1]).toMatchObject({ generator: TEST_GENERATOR });
    renderArtifact(mockEngine, scene, "animated-svg");
    expect(renderToAnimatedSvg.mock.calls.at(-1)?.[1]).toMatchObject({
      generator: TEST_GENERATOR,
      playback: { mode: "timeline", durationMs: scene.durationMs, iterations: "infinite" },
    });
    renderArtifact(mockEngine, scene, { kind: "animated-svg", animatedSvgIterations: "once" });
    expect(renderToAnimatedSvg.mock.calls.at(-1)?.[1]).toMatchObject({
      playback: { mode: "timeline", durationMs: scene.durationMs, iterations: 1 },
    });
    renderArtifact(mockEngine, scene, "poster-png");
    expect(renderToPng.mock.calls.at(-1)?.[1]).toMatchObject({ generator: TEST_GENERATOR });
    renderArtifact(mockEngine, scene, "poster-webp");
    expect(renderToWebp.mock.calls.at(-1)?.[1]).toMatchObject({ generator: TEST_GENERATOR });
    renderArtifact(mockEngine, scene, "animated-webp");
    expect(renderToAnimatedWebp.mock.calls.at(-1)?.[1]).toMatchObject({
      generator: TEST_GENERATOR,
    });
    renderArtifact(mockEngine, scene, "gif");
    expect(renderToAnimatedGif.mock.calls.at(-1)?.[1]).toMatchObject({
      generator: TEST_GENERATOR,
    });
  });

  it("applies shared motion sampling profiles without changing the legacy default", () => {
    expect(DEFAULT_MOTION_EXPORT_QUALITY).toBe("balanced");
    expect(resolveMotionExportSettings("economy")).toEqual({
      animatedRasterFps: 8,
      mp4FrameRate: 10,
      mp4Crf: 28,
    });
    expect(resolveMotionExportSettings("balanced")).toEqual({
      animatedRasterFps: 12,
      mp4FrameRate: 15,
      mp4Crf: 23,
    });
    expect(resolveMotionExportSettings("high")).toEqual({
      animatedRasterFps: 20,
      mp4FrameRate: 20,
      mp4Crf: 18,
    });

    const renderToSvg = vi.fn(() => "<svg/>");
    const renderToAnimatedWebp = vi.fn((_input: unknown, _options: { fps?: number }) =>
      syntheticWebp(),
    );
    const mockEngine = { renderToSvg, renderToAnimatedWebp } as unknown as Engine;
    renderArtifact(mockEngine, tinyAnimatedScene(), {
      kind: "animated-webp",
      motionQuality: "economy",
    });
    expect(renderToAnimatedWebp.mock.calls[0]?.[1]).toMatchObject({ fps: 8 });
  });
});

describe("raster resolution ceiling", () => {
  it("uses boundsvg's exported raster limits", () => {
    expect(RASTER_MAX_LONG_EDGE).toBe(BOUNDSVG_RASTER_MAX_LONG_EDGE);
    expect(RASTER_MAX_PIXELS).toBe(BOUNDSVG_RASTER_MAX_PIXELS);
  });

  it("leaves a request inside the ceiling alone", () => {
    expect(resolveRasterScale({ width: 1920, height: 1080, requestedScale: 2 })).toMatchObject({
      appliedScale: 2,
      outputWidth: 3840,
      outputHeight: 2160,
      adjusted: false,
    });
  });

  it("clamps on the long edge", () => {
    // 1080x1920 x3 would be 3240x5760 — the 5760 long edge is what binds.
    const resolved = resolveRasterScale({ width: 1080, height: 1920, requestedScale: 3 });
    expect(resolved.adjusted).toBe(true);
    expect(Math.max(resolved.outputWidth, resolved.outputHeight)).toBeLessThanOrEqual(
      RASTER_MAX_LONG_EDGE,
    );
  });

  it("clamps on total pixels", () => {
    // 2560x2560 x2 stays under the long edge only after the pixel cap bites.
    const resolved = resolveRasterScale({ width: 2560, height: 2560, requestedScale: 2 });
    expect(resolved.adjusted).toBe(true);
    expect(resolved.outputWidth * resolved.outputHeight).toBeLessThanOrEqual(RASTER_MAX_PIXELS + 1);
  });

  it("rejects a degenerate canvas instead of returning a plan for it", () => {
    // The engine's contract: a canvas axis that is not positive and finite is a
    // structured rejection, not a plan the caller has to sanity-check. Clamping
    // to 1px would silently change the aspect ratio and the returned scale.
    expect(() => resolveRasterScale({ width: 0, height: 0, requestedScale: 3 })).toThrow(
      /invalid canvas width/i,
    );
  });

  // The contract test exercises the exported predictor against the engine
  // that actually rasterizes. 1080x1920 is bound by the pixel cap, 2560x640
  // by the long edge, so both ceilings are load-bearing in real output.
  it.each([
    [1080, 1920, 1, false],
    [1080, 1920, 2, false],
    [1080, 1920, 3, true],
    [1080, 1920, 4, true],
    [2560, 640, 1, false],
    [2560, 640, 2, true],
  ])("matches the engine's own output for %ix%i at scale %i", (width, height, scale, expectAdjusted) => {
    const project = {
      ...DEFAULT_PROJECT,
      appearance: { ...DEFAULT_PROJECT.appearance, canvasWidth: width, canvasHeight: height },
    };
    const scene = buildSvgentScene(project, 0, { engine });
    const predicted = resolveRasterScale({ width, height, requestedScale: scale });
    expect(predicted.adjusted).toBe(expectAdjusted);
    const bytes = renderArtifact(engine, scene, { kind: "poster-png", scale }) as Uint8Array;
    expect(pngSize(bytes)).toEqual({
      width: predicted.outputWidth,
      height: predicted.outputHeight,
    });
  });

  // The ceiling belongs to the raster path, not to the still path alone, so
  // an animated kind has to land where a poster would. A wide, short canvas
  // keeps the clamp on the long edge, so the assertion costs ~1MP a frame
  // instead of the 8MP a pixel-capped one would.
  it("applies the same ceiling to animated output", () => {
    const scene: BuiltScene = {
      ...tinyAnimatedScene(),
      vnode: createElement(
        "Canvas",
        {
          width: 3_000,
          height: 200,
          meta: { simulated: "true", "model-kind": "fictional" },
        },
        createElement("Box", { width: 3_000, height: 200, background: "#8b7cf6" }),
      ),
    };
    const predicted = resolveRasterScale({ width: 3_000, height: 200, requestedScale: 2 });
    expect(predicted.adjusted).toBe(true);
    expect(predicted.outputWidth).toBe(RASTER_MAX_LONG_EDGE);
    const bytes = renderArtifact(engine, scene, { kind: "gif", scale: 2 }) as Uint8Array;
    expect(gifSize(bytes)).toEqual({
      width: predicted.outputWidth,
      height: predicted.outputHeight,
    });
  });

  /*
   * The one option whose migration nothing else covers. 0.2 asked for `loop: 0`
   * and 0.3 asks for a total play count, and the changelog says GIF alone
   * changed how it stores one — it omits this block entirely for a single
   * play. No GIF is committed, and reading the header's screen size cannot
   * tell a file that plays once from a file that plays forever.
   */
  it("declares a GIF that plays forever", () => {
    // Quarter scale: what is read is the header, and every pixel encoded to
    // reach it is time spent proving nothing.
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    const bytes = renderArtifact(engine, scene, { kind: "gif", scale: 0.25 }) as Uint8Array;
    expect(gifLoopCount(bytes)).toBe(0);
  }, 30_000);

  it("reports an adjustment to the caller instead of shrinking in silence", () => {
    const project = {
      ...DEFAULT_PROJECT,
      appearance: { ...DEFAULT_PROJECT.appearance, canvasWidth: 1080, canvasHeight: 1920 },
    };
    const scene = buildSvgentScene(project, 0, { engine });
    const seen: ResolvedRasterScale[] = [];
    renderArtifact(engine, scene, {
      kind: "poster-png",
      scale: 4,
      onResolutionAdjusted: (adjustment) => seen.push(adjustment),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.appliedScale).toBeLessThan(4);

    const quiet: ResolvedRasterScale[] = [];
    renderArtifact(engine, scene, {
      kind: "poster-png",
      scale: 2,
      onResolutionAdjusted: (adjustment) => quiet.push(adjustment),
    });
    expect(quiet).toHaveLength(0);
  });

  it("budgets animation payloads from boundsvg's exported transport cap", () => {
    const svgChars = 1_000_000;
    const scene = { ...tinyAnimatedScene(), durationMs: 10_000 };
    const renderToSvg = vi.fn(() => "x".repeat(svgChars));
    const mockEngine = { renderToSvg } as unknown as Engine;
    const perFrameChars = svgChars + 4_096;
    const expectedFrameBudget = Math.floor(
      (MAX_ANIMATION_SVG_PAYLOAD_CHARS * 0.92) / perFrameChars,
    );
    const expectedFps = Math.floor(expectedFrameBudget / (scene.durationMs / 1_000));

    expect(payloadSafeFps(mockEngine, scene)).toBe(expectedFps);
  });
});

/**
 * Two renders expanded inline into one HTML document share that document's
 * CSS and fragment namespace. Everything a render names after its scene — the
 * `@keyframes`, the generated classes, the `<defs>` a `url(#…)` resolves —
 * is built from the file stem, which is only the surface and the page. Two
 * scripts on the same surface therefore name things identically, the last
 * `@keyframes` of a given name wins, and one document's element animates on
 * the other's timing. The namespace is what pulls them apart.
 */
describe("identifier namespaces", () => {
  const capture = (svg: string, pattern: RegExp): Set<string> => {
    const found = new Set<string>();
    for (const match of svg.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined) {
        found.add(value);
      }
    }
    return found;
  };
  const names = (svg: string) => ({
    keyframes: capture(svg, /@keyframes\s+([^\s{]+)/gu),
    ids: capture(svg, /(?:\s|<)id="([^"]+)"/gu),
    classes: new Set(
      [...capture(svg, /class="([^"]+)"/gu)].flatMap((value) => value.split(/\s+/u)),
    ),
    refs: capture(svg, /url\(#([^)]+)\)/gu),
  });

  it("keeps two namespaced renders of one scene disjoint", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    const first = names(
      renderArtifact(engine, scene, {
        kind: "animated-svg",
        identifierNamespace: "one",
      }) as string,
    );
    const second = names(
      renderArtifact(engine, scene, {
        kind: "animated-svg",
        identifierNamespace: "two",
      }) as string,
    );
    expect(first.keyframes.size).toBeGreaterThan(0);
    expect(first.classes.size).toBeGreaterThan(0);
    expect(first.ids.size).toBeGreaterThan(0);
    for (const [what, a, b] of [
      ["keyframes", first.keyframes, second.keyframes],
      ["classes", first.classes, second.classes],
      ["ids", first.ids, second.ids],
    ] as const) {
      expect(
        [...a].filter((name) => b.has(name)),
        `${what} shared between namespaces`,
      ).toEqual([]);
    }
    // And each document's references still land inside it.
    for (const [refs, ids] of [
      [first.refs, first.ids],
      [second.refs, second.ids],
    ] as const) {
      expect(refs.size, "a document with no references proves nothing").toBeGreaterThan(0);
      expect([...refs].filter((ref) => !ids.has(ref))).toEqual([]);
    }
  });

  /*
   * The renderer appends to the prefix it is given, so two prefixes sharing a
   * document have to be pairwise prefix-free rather than merely different:
   * `…-poster-a` would otherwise hand `…-poster-ab` names beginning with its
   * own. Both halves of that are reachable from the documented use — one
   * render namespaced and its neighbour not, and two namespaces where one
   * spells the start of the other.
   *
   * Pinned on the prefixes themselves. Rendering two of them and comparing the
   * names that come back does not discriminate: whether the overlap surfaces
   * depends on which suffixes the renderer happens to append today, so that
   * test passes on the broken scheme too.
   */
  /*
   * The guarantee is a property of `documentIdPrefix`, so it only holds where
   * the prefix is built by it. A hand-written one anywhere in the workspace —
   * an export path, a new preview, a probe — opts out of the shape without
   * anything noticing.
   */
  it("builds every prefix it hands the renderer", async () => {
    const roots = ["../../render/src/", "../../scene/src/", "../../studio/src/", "../../cli/src/"];
    const walk = async (dir: URL): Promise<Array<[string, string]>> => {
      const out: Array<[string, string]> = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
        if (entry.isDirectory()) {
          out.push(...(await walk(child)));
        } else if (/\.tsx?$/u.test(entry.name)) {
          out.push([child.pathname, await readFile(child, "utf8")]);
        }
      }
      return out;
    };
    const offenders: string[] = [];
    let seen = 0;
    for (const root of roots) {
      for (const [file, source] of await walk(new URL(root, import.meta.url))) {
        for (const match of source.matchAll(/resourceIdPrefix:\s*(.+)$/gmu)) {
          seen += 1;
          const value = (match[1] ?? "").trim();
          // `resourceIdPrefix(` is this module's own wrapper, which builds
          // through the helper on both of its branches.
          if (!/^(documentIdPrefix|resourceIdPrefix)\(/u.test(value)) {
            offenders.push(`${file.split("/packages/")[1]}: ${value}`);
          }
        }
      }
    }
    expect(seen, "no prefixes found at all").toBeGreaterThan(4);
    expect(offenders, "a prefix written by hand").toEqual([]);
  });

  it("builds prefixes no other prefix can begin", () => {
    const parts = [
      ["svgent-app-01", "poster"],
      ["svgent-app-01", "poster", "a"],
      ["svgent-app-01", "poster", "ab"],
      ["svgent-app-01", "transcript-poster"],
      ["svgent-app-01", "animation"],
      ["preview", "r1", "1"],
      ["preview", "r1", "12"],
      ["preview", "r1", "static"],
      ["thumb", "r1", "qa"],
      ["thumb", "r1", "qa-long"],
    ];
    const built = parts.map((each) => documentIdPrefix(...each));
    expect(new Set(built).size, "two part lists built one prefix").toBe(built.length);
    const overlapping = built.flatMap((one) =>
      built
        .filter((other) => other !== one && other.startsWith(one))
        .map((other) => `${one} ⊂ ${other}`),
    );
    expect(overlapping, "a prefix another one begins with").toEqual([]);
  });

  it("refuses the character that closes a prefix", () => {
    // `_` is what makes the shape prefix-free, so no part may carry one.
    expect(() => documentIdPrefix("pane_left")).toThrow(/identifierNamespace/u);
    expect(normalizeIdentifierNamespace("_R_1_")).not.toContain("_");
  });

  it("separates a transcript from a poster of the same scene", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    const poster = names(renderArtifact(engine, scene, "poster-svg") as string);
    const transcript = names(
      renderArtifact(engine, scene, { kind: "poster-svg", asTranscript: true }) as string,
    );
    expect(poster.ids.size).toBeGreaterThan(0);
    expect([...poster.ids].filter((id) => transcript.ids.has(id))).toEqual([]);
    // And a caller who happens to pick "transcript" as their own namespace
    // still lands somewhere else: the two are different axes.
    const collidingName = names(
      renderArtifact(engine, scene, {
        kind: "poster-svg",
        identifierNamespace: "transcript",
      }) as string,
    );
    expect([...collidingName.ids].filter((id) => transcript.ids.has(id))).toEqual([]);
  });

  it("refuses a namespace that would not survive a class name", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    expect(() =>
      renderArtifact(engine, scene, { kind: "poster-svg", identifierNamespace: "two words" }),
    ).toThrow(/identifierNamespace/u);
  });

  it("leaves the names alone when no namespace is given", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    const svg = renderArtifact(engine, scene, "animated-svg") as string;
    expect(svg).toContain(`${scene.fileStem}-animation`);
    // An empty namespace is the one input that could produce a doubled
    // separator, and it is refused before a prefix is built.
    expect(() =>
      renderArtifact(engine, scene, { kind: "animated-svg", identifierNamespace: "" }),
    ).toThrow(/identifierNamespace/u);
  });
});

/*
 * The reordering only keeps kinds apart while `fileStem` stays a closed shape
 * with none of the kind tags inside it. Name an output after its script — a
 * plausible feature — and a script called `svgent-app-01-poster` reintroduces
 * exactly the aliasing the order removed. Fail here rather than in a `<defs>`.
 */
describe("the assumption the kind order rests on", () => {
  const KIND_TAGS = ["poster", "animation", "transcript-poster"];

  it("keeps the scene's own name clear of every kind tag", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { engine });
    expect(scene.fileStem).toMatch(/^svgent-(app|tui)-\d{2}$/u);
    expect(KIND_TAGS.filter((tag) => scene.fileStem.includes(tag))).toEqual([]);
  });

  it("has no kind tag that starts with another", () => {
    const overlapping = KIND_TAGS.flatMap((tag) =>
      KIND_TAGS.filter((other) => other !== tag && other.startsWith(`${tag}-`)).map(
        (other) => `${other} starts with ${tag}`,
      ),
    );
    // `transcript-poster` deliberately ends with a tag rather than starting
    // with one: the head is what a namespace could otherwise imitate.
    expect(overlapping).toEqual([]);
  });
});
