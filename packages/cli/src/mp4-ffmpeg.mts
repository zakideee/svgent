/**
 * ffmpeg-backed MP4 encoding for the render CLI, Remotion-style: the engine
 * samples PNG frames headlessly and pipes them into a locally installed
 * ffmpeg. Nothing is bundled or downloaded — no ffmpeg, no MP4.
 *
 * Mirrors the flag contract of boundsvg packages/cli/src/mp4-export.ts so the
 * two CLIs produce equivalent files.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import type { Engine } from "@boundsvg/core";
import { provenanceCommentText, provenanceFor } from "@svgent/render";
import type { BuiltScene, GeneratorIdentity } from "@svgent/scene";

const DEFAULT_FRAME_RATE = 20;
const DEFAULT_CRF = 18;

/** Longest MP4 export accepted, in frames (3 minutes at 20 fps). */
const MAX_MP4_FRAMES = 3600;

const PROGRESS_EVERY_FRAMES = 40;

/**
 * `FFMPEG_PATH` wins so a caller can point at a specific build; otherwise the
 * bare name is handed to the OS, which knows how to search PATH.
 */
export function resolveFfmpegCommand(): string {
  const configured = process.env.FFMPEG_PATH?.trim();
  return configured ? configured : "ffmpeg";
}

/** Whether the resolved command is an ffmpeg that runs. */
export function probeFfmpeg(command: string): boolean {
  const probe = spawnSync(command, ["-version"], { stdio: "ignore" });
  return probe.error === undefined && probe.status === 0;
}

export function ffmpegNotFoundMessage(command: string): string {
  return [
    `mp4 output needs ffmpeg, but "${command}" did not run. Install it, set FFMPEG_PATH, or drop mp4 from --formats.`,
    "  macOS:   brew install ffmpeg",
    "  Ubuntu:  sudo apt install ffmpeg",
    "  Windows: winget install Gyan.FFmpeg",
  ].join("\n");
}

/** ffmpeg colors use 0xRRGGBB; scripts carry CSS-style #rrggbb. */
function toFfmpegColor(hex: string): string {
  return /^#[\da-f]{6}$/iu.test(hex) ? `0x${hex.slice(1)}` : "white";
}

export function buildFfmpegArgs(
  outputPath: string,
  background: string,
  options: {
    generator: GeneratorIdentity;
    /** Canonical provenance payload written as the MP4 comment. */
    provenanceComment: string;
    frameRate?: number;
    crf?: number;
  },
): string[] {
  const frameRate = options.frameRate ?? DEFAULT_FRAME_RATE;
  const crf = options.crf ?? DEFAULT_CRF;
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(frameRate),
    "-i",
    "-",
    "-c:v",
    "libx264",
    "-crf",
    String(crf),
    // H.264 in yuv420 needs even dimensions and has no alpha; padding right and
    // bottom keeps the frame at the top left where it was rendered.
    "-pix_fmt",
    "yuv420p",
    "-vf",
    `pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=${toFfmpegColor(background)}`,
    "-movflags",
    "+faststart",
    "-metadata",
    `encoding_tool=${options.generator.name}/${options.generator.version}`,
    "-metadata",
    `comment=${options.provenanceComment}`,
    "-y",
    outputPath,
  ];
}

/**
 * Render the scene's frame schedule and pipe it through ffmpeg into an MP4
 * file. Frames render lazily and each write waits for `drain`, so a long
 * export never buffers the whole clip in memory.
 */
export async function encodeMp4WithFfmpeg(input: {
  command: string;
  engine: Engine;
  scene: BuiltScene;
  background: string;
  outputPath: string;
  /** Raster resolution multiplier, independent of the authored canvas size. */
  scale?: number;
  /** Motion sample/playback rate resolved from the shared quality profile. */
  mp4FrameRate: number;
  /** libx264 constant-rate factor resolved from the shared quality profile. */
  mp4Crf: number;
}): Promise<void> {
  const { command, engine, scene, background, outputPath } = input;
  if (scene.generator === undefined) {
    throw new Error("MP4 export requires a runtime generator identity");
  }
  const scale = input.scale !== undefined && input.scale !== 1 ? { scale: input.scale } : {};
  const frameRate = input.mp4FrameRate;
  const frameCount = Math.max(2, Math.ceil((scene.durationMs / 1_000) * frameRate));
  if (frameCount > MAX_MP4_FRAMES) {
    throw new Error(
      `Scene is too long for MP4 (${frameCount} frames, max ${MAX_MP4_FRAMES}). Shorten timings or split pages.`,
    );
  }

  const child = spawn(
    command,
    buildFfmpegArgs(outputPath, background, {
      generator: scene.generator,
      provenanceComment: provenanceCommentText(provenanceFor(scene)),
      frameRate,
      crf: input.mp4Crf,
    }),
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  // Swallow write-side errors (e.g. EPIPE when ffmpeg dies early) — `close`
  // carries the exit code and stderr explains the failure.
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });

  process.stderr.write(`[svgent] mp4: ${frameCount} frames @ ${frameRate}fps → ffmpeg\n`);
  const timesMs = Array.from(
    { length: frameCount },
    (_unused, index) => (index * 1_000) / frameRate,
  );
  const frames = engine.renderFrames(scene.vnode, {
    timesMs,
    format: "png",
    rasterBackground: background,
    ...scale,
  });
  for (const frame of frames) {
    if (frame.format !== "png") {
      throw new Error(`MP4 export expected png frames, got ${frame.format}`);
    }
    if (!child.stdin.write(frame.data)) {
      await once(child.stdin, "drain");
    }
    if ((frame.index + 1) % PROGRESS_EVERY_FRAMES === 0) {
      process.stderr.write(`[svgent] mp4: frame ${frame.index + 1}/${frameCount}\n`);
    }
  }
  child.stdin.end();

  const code = await closed;
  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${String(code)}: ${stderrText.trim()}`);
  }
}
