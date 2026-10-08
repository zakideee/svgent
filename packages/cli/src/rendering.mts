/** Node rendering adapter for authored script files. */
import { constants as fileConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createEngineAsync, type Engine } from "@boundsvg/core";
import { initWasm } from "@boundsvg/core/wasm";
import { BUNDLED_FONT_FILES, GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import { bundledFontPath, loadBundledBoundsvgWasm } from "@svgent/assets/node";
import {
  type AnimatedSvgIterations,
  isAnimatedRasterKind,
  type MotionExportQuality,
  RASTER_MAX_LONG_EDGE,
  RASTER_MAX_PIXELS,
  RENDERABLE_EXTENSIONS,
  RENDERABLE_KINDS,
  type RenderableKind,
  type ResolvedRasterScale,
  renderAnimatedRaster,
  renderArtifact,
  resolveMotionExportSettings,
  resolveSceneRasterScale,
} from "@svgent/render";
import {
  type BuiltScene,
  buildGoogleFontCssUrl,
  buildSvgentScene,
  bundledFallbackFonts,
  collectProjectCharacters,
  describeMissingGlyphs,
  FONT_ALIAS,
  type FontSlot,
  findProjectMissingGlyphs,
  type SvgentProject,
} from "@svgent/scene";
import { version as cliVersion } from "../package.json";
import { encodeMp4WithFfmpeg } from "./mp4-ffmpeg.mjs";

/** Identity stamped on every CLI artifact. */
const CLI_GENERATOR = Object.freeze({ name: "svgent", version: cliVersion });

/** Artifact formats accepted by the command. */
export type CliFormat = RenderableKind | "mp4" | "transcript-svg" | "transcript-png";

/** Supported artifact formats. */
export const CLI_FORMATS: readonly CliFormat[] = [
  ...RENDERABLE_KINDS,
  "mp4",
  "transcript-svg",
  "transcript-png",
];

/** Rendering controls shared by render and snapshot commands. */
export type CliOptions = {
  outDir: string;
  formats: CliFormat[];
  /** Separates this render's document-global names from another's. */
  idNamespace: string | undefined;
  pages: "all" | number;
  lang: "ja" | "en";
  fontOverrides: Partial<Record<FontSlot, string>>;
  strict: boolean;
  /**
   * Whether a script may pull its font from Google Fonts. Off by default:
   * a script arriving from somewhere else should not be able to make the
   * renderer talk to a third party, and the subset request spells out every
   * character the script draws.
   */
  allowFontFetch: boolean;
  /** Raster resolution multiplier; vector SVG output ignores it. */
  scale: number;
  motionQuality: MotionExportQuality;
  /** How many times the animated SVG plays; other formats ignore it. */
  animatedSvgIterations: AnimatedSvgIterations;
  /** Warning messages emitted while rendering. */
  warnings: string[];
  /** Resolved ffmpeg command; set only when mp4 output was requested. */
  ffmpeg?: string;
};

import {
  assertScriptWarnings,
  CliError,
  type LoadedScript,
  readScriptFile,
} from "./script-file.mjs";

/** Artifact identity and actual output geometry. */
type Artifact = {
  path: string;
  format: CliFormat;
  page: number;
  widthPx: number;
  heightPx: number;
  durationMs: number;
  timeMs?: number;
};

type InputFile = { path: string; identity: string };
type ArtifactFiles = { sources: readonly InputFile[]; writtenArtifacts: Set<string> };
type RenderBatch = { inputPaths: readonly string[]; writtenArtifacts: Set<string> };

function reportWarning(options: CliOptions, message: string): void {
  options.warnings.push(message);
  console.warn(`[svgent] ${message}`);
  if (options.strict) {
    throw new CliError("WARNINGS", message, { warnings: options.warnings });
  }
}
async function fetchGoogleFontBinary(family: string, text: string): Promise<Uint8Array> {
  const cssUrl = buildGoogleFontCssUrl(family, text);
  const cssResponse = await fetch(cssUrl, { headers: { Accept: "text/css,*/*;q=0.1" } });
  if (!cssResponse.ok) {
    throw new Error(`Google Fonts css2 returned HTTP ${cssResponse.status} for "${family}"`);
  }
  const match = /src:\s*url\((https:[^)]+)\)/u.exec(await cssResponse.text());
  if (!match?.[1]) {
    throw new Error(`Google Fonts returned no font URL for "${family}"`);
  }
  const fontResponse = await fetch(match[1]);
  if (!fontResponse.ok) {
    throw new Error(`Font binary fetch failed with HTTP ${fontResponse.status} for "${family}"`);
  }
  return new Uint8Array(await fontResponse.arrayBuffer());
}

/**
 * Resolve one slot to font bytes. Upload-sourced choices have no binary in
 * the script file, so they need --sans-font/--mono-font or fall back to the
 * bundled font, mirroring what the UI does when importing such a script.
 */
async function resolveSlotData(
  project: SvgentProject,
  slot: FontSlot,
  options: CliOptions,
): Promise<Uint8Array> {
  const override = options.fontOverrides[slot];
  if (override) {
    return new Uint8Array(await readFile(override));
  }
  const choice = project.fonts[slot];
  if (choice.source === "google") {
    if (!options.allowFontFetch) {
      // Never a silent substitution: the render still succeeds, but the
      // reader of the log has to be able to see that the font on screen is
      // not the font the script asked for.
      reportWarning(
        options,
        `${slot} slot asks for the Google font "${choice.family}", which would send every character this script draws to fonts.googleapis.com — using the bundled font instead. Pass --allow-font-fetch to fetch it.`,
      );
      return readBundledFontFile(BUNDLED_FONT_FILES[slot]);
    }
    return fetchGoogleFontBinary(choice.family, collectProjectCharacters(project));
  }
  if (choice.source === "upload") {
    reportWarning(
      options,
      `${slot} slot references an uploaded font ("${choice.fileName}") that script files do not embed — using the bundled font. Pass --${slot}-font to supply the file.`,
    );
  }
  return readBundledFontFile(BUNDLED_FONT_FILES[slot]);
}

/** Read one of the fonts that ship with svgent. */
async function readBundledFontFile(fileName: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(bundledFontPath(fileName)));
}

async function createEngineForProject(
  project: SvgentProject,
  options: CliOptions,
): Promise<Engine> {
  const slots: FontSlot[] = ["sans", "mono"];
  const fonts = await Promise.all(
    slots.map(async (slot) => ({
      alias: FONT_ALIAS[slot],
      weight: 400,
      style: "normal" as const,
      data: await resolveSlotData(project, slot, options),
    })),
  );
  // The bundled pair is always registered under the fallback aliases so a
  // subset or upload that lacks a glyph resolves instead of drawing tofu.
  const fallbacks = await bundledFallbackFonts((slot) =>
    readBundledFontFile(BUNDLED_FONT_FILES[slot]),
  );
  return createEngineAsync({ fonts: [...fonts, ...fallbacks] });
}

async function assertArtifactDestination(
  outputPath: string,
  files: ArtifactFiles,
): Promise<number | undefined> {
  const { sources, writtenArtifacts } = files;
  const destination = path.join(
    await realpath(path.dirname(outputPath)),
    path.basename(outputPath),
  );
  if (sources.some((source) => source.path === destination)) {
    throw new CliError("INVALID_OUTPUT", "An artifact cannot replace an input file.");
  }
  try {
    const existing = await lstat(outputPath, { bigint: true });
    if (!existing.isFile() || existing.nlink !== 1n) {
      throw new CliError("INVALID_OUTPUT", "Artifact outputs must be regular files with one link.");
    }
    // File identity also protects case-insensitive paths and filesystem aliases.
    const identity = `${existing.dev}:${existing.ino}`;
    if (sources.some((source) => source.identity === identity)) {
      throw new CliError("INVALID_OUTPUT", "An artifact cannot replace an input file.");
    }
    if (writtenArtifacts.has(identity)) {
      throw new CliError(
        "OUTPUT_COLLISION",
        "This destination already holds another artifact from this render. Use separate output directories.",
      );
    }
    try {
      await access(outputPath, fileConstants.W_OK);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new CliError("INVALID_OUTPUT", "Artifact output is not writable.");
      }
      throw cause;
    }
    return Number(existing.mode & 0o777n);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
      throw cause;
    }
  }
}

async function writeArtifactFile(
  outputPath: string,
  files: ArtifactFiles,
  renderFile: (temporaryPath: string) => Promise<void>,
): Promise<void> {
  const previousMode = await assertArtifactDestination(outputPath, files);
  const temporaryRoot = await mkdtemp(path.join(path.dirname(outputPath), ".svgent-artifact-"));
  const temporaryPath = path.join(temporaryRoot, path.basename(outputPath));
  try {
    await renderFile(temporaryPath);
    const mode = (await assertArtifactDestination(outputPath, files)) ?? previousMode;
    if (mode !== undefined) {
      await chmod(temporaryPath, mode);
    }
    // Replacing the directory entry cannot follow a raced symlink into a source.
    await rename(temporaryPath, outputPath);
    const saved = await stat(outputPath, { bigint: true });
    files.writtenArtifacts.add(`${saved.dev}:${saved.ino}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Writes one artifact and returns its path. Transcript kinds rebuild the scene
 * at full height so content that scrolled away still lands in the file; MP4 is
 * the only kind that leaves the engine and goes through ffmpeg.
 */
async function renderOnePage(input: {
  engine: Engine;
  project: SvgentProject;
  scene: BuiltScene;
  kind: CliFormat;
  pageIndex: number;
  inputStem: string;
  files: ArtifactFiles;
  options: CliOptions;
}): Promise<string> {
  const { engine, project, scene, kind, pageIndex, inputStem, files, options } = input;
  const pageLabel = String(pageIndex + 1).padStart(2, "0");
  const stem = path.join(options.outDir, `${inputStem}-${pageLabel}`);
  // The engine lowers an oversized raster request instead of refusing it, so
  // an unreported --scale would hand back a smaller file than it named.
  const onResolutionAdjusted = (adjustment: ResolvedRasterScale): void => {
    const message =
      `${inputStem} page ${pageIndex + 1}: --scale ${options.scale} exceeds the ` +
      `${RASTER_MAX_LONG_EDGE}px / ${RASTER_MAX_PIXELS.toLocaleString()}px raster ceiling; ` +
      `rendering at ${adjustment.appliedScale.toFixed(2)}x ` +
      `(${adjustment.outputWidth}x${adjustment.outputHeight})`;
    reportWarning(options, message);
  };
  if (kind === "transcript-svg" || kind === "transcript-png") {
    const fullScene = buildSvgentScene(project, pageIndex, {
      fullHeight: true,
      engine,
      generator: CLI_GENERATOR,
      fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
    });
    const artifact = renderArtifact(engine, fullScene, {
      kind: kind === "transcript-svg" ? "poster-svg" : "poster-png",
      scale: options.scale,
      onResolutionAdjusted,
      // A transcript renders as a poster; without this it would name its
      // identifiers exactly as a poster of the same scene does.
      asTranscript: true,
      ...(options.idNamespace === undefined ? {} : { identifierNamespace: options.idNamespace }),
    });
    const outPath = `${stem}.${kind === "transcript-svg" ? "transcript.svg" : "transcript.png"}`;
    await writeArtifactFile(outPath, files, async (temporaryPath) => {
      await writeFile(temporaryPath, artifact, { flag: "wx" });
    });
    return outPath;
  }
  if (kind === "mp4") {
    const outPath = `${stem}.mp4`;
    // ffmpeg gets PNG frames from the same engine, so the raster ceiling
    // applies to video exactly as it does to stills.
    const videoScale = resolveSceneRasterScale(scene, options.scale);
    if (videoScale.adjusted) {
      onResolutionAdjusted(videoScale);
    }
    const motionSettings = resolveMotionExportSettings(options.motionQuality);
    await writeArtifactFile(outPath, files, async (temporaryPath) =>
      encodeMp4WithFfmpeg({
        // parseCliOptions resolved the command before any rendering started.
        command: options.ffmpeg ?? "ffmpeg",
        engine,
        scene,
        background: project.appearance.background,
        outputPath: temporaryPath,
        scale: options.scale,
        mp4FrameRate: motionSettings.mp4FrameRate,
        mp4Crf: motionSettings.mp4Crf,
      }),
    );
    return outPath;
  }
  if (isAnimatedRasterKind(kind)) {
    const outPath = `${stem}.${RENDERABLE_EXTENSIONS[kind]}`;
    await writeArtifactFile(outPath, files, async (temporaryPath) =>
      writeFile(
        temporaryPath,
        await renderAnimatedRaster(engine, scene, {
          kind,
          scale: options.scale,
          motionQuality: options.motionQuality,
          onResolutionAdjusted,
        }),
        { flag: "wx" },
      ),
    );
    return outPath;
  }
  const artifact = renderArtifact(engine, scene, {
    kind,
    scale: options.scale,
    animatedSvgIterations: options.animatedSvgIterations,
    onResolutionAdjusted,
    ...(options.idNamespace === undefined ? {} : { identifierNamespace: options.idNamespace }),
  });
  const outPath = `${stem}.${RENDERABLE_EXTENSIONS[kind]}`;
  await writeArtifactFile(outPath, files, async (temporaryPath) => {
    await writeFile(temporaryPath, artifact, { flag: "wx" });
  });
  return outPath;
}

/** Render one imported file through the shared scene and encoders. */
export async function renderScriptFile(
  inputPath: string,
  options: CliOptions,
  batch: RenderBatch = { inputPaths: [inputPath], writtenArtifacts: new Set() },
): Promise<{
  source: { path: string; sha256: string };
  warnings: string[];
  artifacts: Artifact[];
}> {
  const fontPaths = Object.values(options.fontOverrides).filter(
    (font): font is string => typeof font === "string",
  );
  const sources = await Promise.all(
    [...batch.inputPaths, ...fontPaths].map(async (input) => {
      const sourcePath = await realpath(input);
      const metadata = await stat(sourcePath, { bigint: true });
      return { path: sourcePath, identity: `${metadata.dev}:${metadata.ino}` };
    }),
  );
  await initializeRuntime();
  await mkdir(options.outDir, { recursive: true });
  const script = await readScriptFile(inputPath, options.lang);
  if (options.strict) {
    assertScriptWarnings(script);
  }
  const { project, warnings } = script;
  for (const warning of warnings) {
    reportWarning(options, warning);
  }
  const engine = await createEngineForProject(project, options);
  const artifacts: Artifact[] = [];
  try {
    // Nothing downstream reports this: the engine draws a box and carries on,
    // so an unattended render would ship tofu without a word.
    const missingGlyphs = findProjectMissingGlyphs(engine, project);
    if (missingGlyphs.length > 0) {
      const message =
        `${path.basename(inputPath)}: ${missingGlyphs.length} character(s) have no glyph ` +
        `in the selected fonts and render as boxes: ${describeMissingGlyphs(missingGlyphs)}`;
      reportWarning(options, message);
    }
    const pageCount = buildSvgentScene(project, 0).pageCount;
    if (options.pages !== "all" && options.pages > pageCount) {
      throw new CliError(
        "INVALID_ARGUMENT",
        `${inputPath}: page ${options.pages} requested but only ${pageCount} exist`,
      );
    }
    const pageIndexes =
      options.pages === "all"
        ? Array.from({ length: pageCount }, (_unused, index) => index)
        : [options.pages - 1];
    const inputStem = path.basename(inputPath).replace(/\.json$/u, "");

    for (const pageIndex of pageIndexes) {
      const scene = buildSvgentScene(project, pageIndex, {
        engine,
        generator: CLI_GENERATOR,
        fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
      });
      for (const kind of options.formats) {
        process.stderr.write(`[svgent] Rendering ${inputStem} page ${pageIndex + 1}: ${kind}\n`);
        const outputPath = await renderOnePage({
          engine,
          project,
          scene,
          kind,
          pageIndex,
          inputStem,
          files: { sources, writtenArtifacts: batch.writtenArtifacts },
          options,
        });
        const renderedScene = kind.startsWith("transcript-")
          ? buildSvgentScene(project, pageIndex, {
              engine,
              fullHeight: true,
              generator: CLI_GENERATOR,
              fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
            })
          : scene;
        artifacts.push(
          artifactFor(renderedScene, {
            outputPath,
            kind,
            scale: options.scale,
            motionQuality: options.motionQuality,
          }),
        );
      }
    }
  } finally {
    engine.dispose();
  }
  return {
    source: { path: script.path, sha256: script.sha256 },
    warnings: options.warnings,
    artifacts,
  };
}

function artifactFor(
  scene: BuiltScene,
  request: {
    outputPath: string;
    kind: CliFormat;
    scale: number;
    motionQuality: MotionExportQuality;
  },
): Artifact {
  const { outputPath, kind, scale } = request;
  const geometry = resolveSceneRasterScale(scene, kind.endsWith("svg") ? 1 : scale);
  return {
    path: path.resolve(outputPath),
    format: kind,
    page: scene.pageIndex + 1,
    widthPx: kind === "mp4" ? Math.ceil(geometry.outputWidth / 2) * 2 : geometry.outputWidth,
    heightPx: kind === "mp4" ? Math.ceil(geometry.outputHeight / 2) * 2 : geometry.outputHeight,
    durationMs:
      kind === "animated-svg" || isAnimatedRasterKind(kind as RenderableKind) || kind === "mp4"
        ? kind === "mp4"
          ? (Math.max(
              2,
              Math.ceil(
                (scene.durationMs *
                  resolveMotionExportSettings(request.motionQuality).mp4FrameRate) /
                  1000,
              ),
            ) *
              1000) /
            resolveMotionExportSettings(request.motionQuality).mp4FrameRate
          : scene.durationMs
        : 0,
  };
}

function initializeRuntime(): void {
  initWasm(loadBundledBoundsvgWasm() as Parameters<typeof initWasm>[0]);
}

/** Capture a page at an explicit moment as a provenance-stamped PNG. */
export async function snapshotScriptFile(
  script: LoadedScript,
  options: CliOptions,
  request: { page: number; timeMs: number; outputPath: string },
): Promise<Artifact> {
  initializeRuntime();
  if (options.strict) {
    assertScriptWarnings(script);
  }
  for (const warning of script.warnings) {
    reportWarning(options, warning);
  }
  const engine = await createEngineForProject(script.project, options);
  try {
    const scene = buildSvgentScene(script.project, request.page - 1, {
      engine,
      generator: CLI_GENERATOR,
      fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
    });
    if (request.page > scene.pageCount || request.timeMs < 0 || request.timeMs > scene.durationMs) {
      throw new CliError(
        "INVALID_ARGUMENT",
        "Snapshot page/time is outside this script's timeline.",
      );
    }
    const missing = findProjectMissingGlyphs(engine, script.project);
    if (missing.length > 0) {
      reportWarning(options, `Characters without glyphs: ${describeMissingGlyphs(missing)}`);
    }
    const geometry = resolveSceneRasterScale(scene, options.scale);
    if (geometry.adjusted) {
      reportWarning(options, `Raster scale lowered to ${geometry.appliedScale}.`);
    }
    const png = renderArtifact(engine, scene, {
      kind: "poster-png",
      scale: options.scale,
      timeMs: request.timeMs,
    });
    await writeFile(request.outputPath, png, { flag: "wx" });
    return {
      ...artifactFor(scene, {
        outputPath: request.outputPath,
        kind: "poster-png",
        scale: options.scale,
        motionQuality: options.motionQuality,
      }),
      timeMs: request.timeMs,
    };
  } finally {
    engine.dispose();
  }
}
