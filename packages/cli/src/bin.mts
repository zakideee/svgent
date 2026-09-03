#!/usr/bin/env node
/**
 * Headless render CLI: turns svgent script JSON files into SVG / PNG / WebP /
 * GIF artifacts without a browser, so coding agents and shell pipelines can
 * produce the same output as the studio UI.
 *
 * Usage:
 *   pnpm render <script.json…> [--out DIR] [--formats LIST] [--pages all|N]
 *               [--lang ja|en] [--sans-font PATH] [--mono-font PATH] [--strict]
 *
 * MP4 encodes through a locally installed ffmpeg (Remotion-style frame
 * piping); without ffmpeg the format is rejected up front.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { createEngineAsync, type Engine } from "@boundsvg/core";
import { initWasm } from "@boundsvg/core/wasm";
import { BUNDLED_FONT_FILES, GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import { bundledFontPath, loadBundledBoundsvgWasm } from "@svgent/assets/node";
import {
  type AnimatedSvgIterations,
  assertIdentifierNamespace,
  DEFAULT_MOTION_EXPORT_QUALITY,
  type MotionExportQuality,
  RASTER_MAX_LONG_EDGE,
  RASTER_MAX_PIXELS,
  RENDERABLE_EXTENSIONS,
  RENDERABLE_KINDS,
  type RenderableKind,
  type ResolvedRasterScale,
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
  deserializeProject,
  draftTimelineIssues,
  FONT_ALIAS,
  type FontSlot,
  findProjectMissingGlyphs,
  MAX_DRAFT_RUN_CLUSTERS,
  MAX_PROJECT_DURATION_MS,
  type SvgentProject,
} from "@svgent/scene";
import { version as cliVersion } from "../package.json";
import {
  encodeMp4WithFfmpeg,
  ffmpegNotFoundMessage,
  probeFfmpeg,
  resolveFfmpegCommand,
} from "./mp4-ffmpeg.mjs";

const CLI_GENERATOR = Object.freeze({ name: "svgent", version: cliVersion });

type CliFormat = RenderableKind | "mp4" | "transcript-svg" | "transcript-png";

const CLI_FORMATS: readonly CliFormat[] = [
  ...RENDERABLE_KINDS,
  "mp4",
  "transcript-svg",
  "transcript-png",
];

const DEFAULT_FORMATS: CliFormat[] = ["poster-svg", "poster-png"];

const USAGE = `svgent render — script JSON to SVG/PNG/WebP/GIF artifacts

Usage:
  pnpm render <script.json…> [options]

Options:
  --out, -o <dir>      Output directory (default: render-out)
  --formats, -f <list> Comma-separated: ${CLI_FORMATS.join(", ")}
                       (default: ${DEFAULT_FORMATS.join(",")}; mp4 needs ffmpeg)
  --pages <all|N>      Page to render for slide flows, 1-based (default: all)
  --lang <ja|en>       Language for script validation warnings (default: en)
  --sans-font <path>   Font file overriding the sans slot (bundled subset otherwise)
  --mono-font <path>   Font file overriding the mono slot
  --scale <n>          Raster resolution multiplier 0.5–4 (default: 1).
                       Applies to png/webp/gif/mp4; SVG output is vector
  --motion-quality <economy|balanced|high>
                       Motion sampling/encoding profile (default: balanced)
  --svg-play <loop|once>
                       How many times the animated SVG plays (default: loop,
                       matching GIF and WebP)
  --id-namespace <s>   Distinguishes this render's CSS and \`<defs>\` names.
                       Letters, digits and \`-\`, starting with a letter or
                       digit. Needed only when several SVGs are expanded
                       inline into one HTML document — \`img\`, \`object\`
                       and \`iframe\` are separate documents and need nothing
  --allow-font-fetch   Let a script's Google Fonts choice reach the network.
                       Off by default: rendering a script is otherwise
                       offline, and the request carries every character the
                       script draws. Without it the bundled font is used and
                       the substitution is reported
  --strict             Exit with code 1 when the script produced validation warnings
  --help, -h           Show this help
`;

type CliOptions = {
  inputs: string[];
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
  /** Resolved ffmpeg command; set only when mp4 output was requested. */
  ffmpeg?: string;
};

function parsePages(raw: string | undefined): number | "all" {
  const pages = raw === "all" ? ("all" as const) : Number(raw);
  if (pages !== "all" && (!Number.isInteger(pages) || pages < 1)) {
    throw new Error(`--pages expects "all" or a 1-based page number, got "${raw}"`);
  }
  return pages;
}

function parseLang(raw: string | undefined): "ja" | "en" {
  if (raw !== "ja" && raw !== "en") {
    throw new Error(`--lang expects "ja" or "en", got "${raw}"`);
  }
  return raw;
}

function parseScale(raw: string | undefined): number {
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 4) {
    throw new Error(`--scale expects a number between 0.5 and 4, got "${raw}"`);
  }
  return scale;
}

function parseMotionQuality(raw: string | undefined): MotionExportQuality {
  if (raw !== "economy" && raw !== "balanced" && raw !== "high") {
    throw new Error(`--motion-quality expects "economy", "balanced", or "high", got "${raw}"`);
  }
  return raw;
}

function parseSvgPlay(raw: string | undefined): AnimatedSvgIterations {
  if (raw !== "loop" && raw !== "once") {
    throw new Error(`--svg-play expects "loop" or "once", got "${raw}"`);
  }
  return raw === "loop" ? "infinite" : "once";
}

/** MP4 is the one format that needs a local binary, so it is probed up front. */
function requireFfmpeg(): string {
  const ffmpeg = resolveFfmpegCommand();
  if (!probeFfmpeg(ffmpeg)) {
    throw new Error(ffmpegNotFoundMessage(ffmpeg));
  }
  return ffmpeg;
}

function parseCliOptions(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: "render-out" },
      formats: { type: "string", short: "f", default: DEFAULT_FORMATS.join(",") },
      "id-namespace": { type: "string" },
      pages: { type: "string", default: "all" },
      lang: { type: "string", default: "en" },
      "sans-font": { type: "string" },
      "mono-font": { type: "string" },
      scale: { type: "string", default: "1" },
      "motion-quality": { type: "string", default: DEFAULT_MOTION_EXPORT_QUALITY },
      "svg-play": { type: "string", default: "loop" },
      "allow-font-fetch": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    process.exit(values.help ? 0 : 2);
  }

  const formats = values.formats.split(",").map((entry) => entry.trim()) as CliFormat[];
  for (const format of formats) {
    if (!CLI_FORMATS.includes(format)) {
      throw new Error(`Unknown format "${format}". Supported formats: ${CLI_FORMATS.join(", ")}`);
    }
  }

  const idNamespace = values["id-namespace"];
  if (idNamespace !== undefined) {
    // Every other option is checked here, before a byte is written. Leaving
    // this one to the render would let a raster format succeed with a value
    // an SVG rejects, and a mixed --formats list write half its files first.
    assertIdentifierNamespace(idNamespace);
    if (positionals.length > 1) {
      // The stem a render names itself after is the surface and the page, not
      // the input file, so one namespace across several scripts of the same
      // surface produces exactly the collision the flag exists to prevent.
      throw new Error(
        "--id-namespace names one render; pass one script at a time, or run it once per script with a different value",
      );
    }
  }

  const pages = parsePages(values.pages);
  const lang = parseLang(values.lang);
  const scale = parseScale(values.scale);
  const motionQuality = parseMotionQuality(values["motion-quality"]);
  const animatedSvgIterations = parseSvgPlay(values["svg-play"]);
  const ffmpeg = formats.includes("mp4") ? requireFfmpeg() : undefined;

  return {
    inputs: positionals,
    outDir: values.out,
    formats,
    pages,
    lang,
    fontOverrides: {
      ...(values["sans-font"] ? { sans: values["sans-font"] } : {}),
      ...(values["mono-font"] ? { mono: values["mono-font"] } : {}),
    },
    strict: values.strict,
    allowFontFetch: values["allow-font-fetch"],
    scale,
    motionQuality,
    animatedSvgIterations,
    idNamespace,
    ...(ffmpeg ? { ffmpeg } : {}),
  };
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
      console.warn(
        `[svgent] ${slot} slot asks for the Google font "${choice.family}", which would send every character this script draws to fonts.googleapis.com — using the bundled font instead. Pass --allow-font-fetch to fetch it.`,
      );
      return readBundledFontFile(BUNDLED_FONT_FILES[slot]);
    }
    return fetchGoogleFontBinary(choice.family, collectProjectCharacters(project));
  }
  if (choice.source === "upload") {
    console.warn(
      `[svgent] ${slot} slot references an uploaded font ("${choice.fileName}") that script files do not embed — using the bundled font. Pass --${slot}-font to supply the file.`,
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
  options: CliOptions;
}): Promise<string> {
  const { engine, project, scene, kind, pageIndex, inputStem, options } = input;
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
    if (options.strict) {
      throw new Error(message);
    }
    console.warn(`[svgent] ${message}`);
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
    await writeFile(outPath, artifact);
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
    await encodeMp4WithFfmpeg({
      // parseCliOptions resolved the command before any rendering started.
      command: options.ffmpeg ?? "ffmpeg",
      engine,
      scene,
      background: project.appearance.background,
      outputPath: outPath,
      scale: options.scale,
      mp4FrameRate: motionSettings.mp4FrameRate,
      mp4Crf: motionSettings.mp4Crf,
    });
    return outPath;
  }
  const artifact = renderArtifact(engine, scene, {
    kind,
    scale: options.scale,
    motionQuality: options.motionQuality,
    animatedSvgIterations: options.animatedSvgIterations,
    onResolutionAdjusted,
    ...(options.idNamespace === undefined ? {} : { identifierNamespace: options.idNamespace }),
  });
  const outPath = `${stem}.${RENDERABLE_EXTENSIONS[kind]}`;
  await writeFile(outPath, artifact);
  return outPath;
}

async function renderScriptFile(inputPath: string, options: CliOptions): Promise<string[]> {
  const source = await readFile(inputPath, "utf8");
  const { project, warnings } = deserializeProject(source, options.lang);
  const timelineWarnings = draftTimelineIssues(project).map((issue) => {
    if (options.lang === "en") {
      return issue.detail;
    }
    switch (issue.code) {
      case "ime-run-too-long":
        return `${(issue.messageIndex ?? 0) + 1}件目のIME読みは1回の変換につき${MAX_DRAFT_RUN_CLUSTERS}文字以下に分けてください。`;
      case "duration-too-short":
        return `${(issue.messageIndex ?? 0) + 1}件目の表示時間ではIME変換・確定・補完を完了できません。`;
      case "project-too-long":
        return `アニメーションの総尺は${MAX_PROJECT_DURATION_MS / 1_000}秒以下にしてください。`;
    }
    return issue.detail;
  });
  for (const warning of [...warnings, ...timelineWarnings]) {
    console.warn(`[svgent] ${path.basename(inputPath)}: ${warning}`);
  }
  const warningCount = warnings.length + timelineWarnings.length;
  if (options.strict && warningCount > 0) {
    throw new Error(`${inputPath}: ${warningCount} validation warning(s) in --strict mode`);
  }

  const engine = await createEngineForProject(project, options);
  const written: string[] = [];
  try {
    // Nothing downstream reports this: the engine draws a box and carries on,
    // so an unattended render would ship tofu without a word.
    const missingGlyphs = findProjectMissingGlyphs(engine, project);
    if (missingGlyphs.length > 0) {
      const message =
        `${path.basename(inputPath)}: ${missingGlyphs.length} character(s) have no glyph ` +
        `in the selected fonts and render as boxes: ${describeMissingGlyphs(missingGlyphs)}`;
      if (options.strict) {
        throw new Error(message);
      }
      console.warn(`[svgent] ${message}`);
    }
    const pageCount = buildSvgentScene(project, 0).pageCount;
    if (options.pages !== "all" && options.pages > pageCount) {
      throw new Error(`${inputPath}: page ${options.pages} requested but only ${pageCount} exist`);
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
        written.push(
          await renderOnePage({ engine, project, scene, kind, pageIndex, inputStem, options }),
        );
      }
    }
  } finally {
    engine.dispose();
  }
  return written;
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  initWasm(loadBundledBoundsvgWasm() as Parameters<typeof initWasm>[0]);
  await mkdir(options.outDir, { recursive: true });
  for (const input of options.inputs) {
    const written = await renderScriptFile(input, options);
    for (const file of written) {
      console.info(file);
    }
  }
}

main().catch((cause: unknown) => {
  console.error(`[svgent] ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
});
