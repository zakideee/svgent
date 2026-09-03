import type { ResolvedBrowserFont } from "@boundsvg/browser";
import { type Engine, toSceneDocument, type VNode } from "@boundsvg/core";
import {
  type AnimatedSvgIterations,
  type ArtifactProvenance,
  DEFAULT_MOTION_EXPORT_QUALITY,
  type MotionExportQuality,
  payloadSafeFps,
  provenanceFor,
  RENDERABLE_EXTENSIONS,
  type RenderableKind,
  renderArtifact,
  resolveMotionExportSettings,
  resolveSceneRasterScale,
  stampGifProvenance,
  stampMp4Provenance,
  stampWebpProvenance,
} from "@svgent/render";
import type { BuiltScene } from "@svgent/scene";
import type { UiStrings } from "./i18n.js";

export type ExportKind = RenderableKind | "mp4" | "transcript-svg" | "transcript-png";

type ExportProgress = {
  done: number;
  total: number;
};

type ExportInput = {
  engine: Engine;
  scene: BuiltScene;
  kind: ExportKind;
  mp4Background: string;
  /** The engine's active font set, forwarded to MP4 worker rendering. */
  fonts: ResolvedBrowserFont[];
  /**
   * Raster resolution multiplier, independent of the authored canvas size.
   * Vector SVG kinds ignore it.
   */
  scale?: number;
  /** Motion sampling rate; ignored by still and vector exports. */
  motionQuality?: MotionExportQuality;
  /** How many times the animated SVG plays; other kinds ignore it. */
  animatedSvgIterations?: AnimatedSvgIterations;
  /** MP4 raster worker parallelism; ignored by other exports. */
  resourceMode?: ExportResourceMode;
  onProgress?: (progress: ExportProgress) => void;
  /**
   * Estimated total duration for exports that emit no per-frame progress
   * (animated WebP/GIF run as one opaque worker call).
   */
  onEstimate?: (etaMs: number) => void;
  /** Cancels worker-based motion exports; the in-process fallback cannot stop. */
  signal?: AbortSignal;
  /**
   * The Studio entry sets this false: a missing Worker must fail before a
   * multi-minute main-thread freeze. Direct API callers keep the historical
   * fallback by default, which also preserves the performance baseline path.
   */
  allowInProcessMotionFallback?: boolean;
  t: UiStrings;
};

export type ExportResourceMode = "memory" | "balanced" | "speed";

export const DEFAULT_EXPORT_RESOURCE_MODE: ExportResourceMode = "balanced";

/**
 * Resolve MP4 raster parallelism without multiplying WASM memory by the
 * previous implicit six-worker ceiling. Speed is explicit opt-in and remains
 * capped at four; the balanced path follows boundsvg's measured default of 2.
 */
export function resolveExportWorkerConcurrency(
  mode: ExportResourceMode,
  hardwareConcurrency: number,
): number {
  if (mode === "memory") {
    return 1;
  }
  if (mode === "balanced") {
    return 2;
  }
  const available = Number.isFinite(hardwareConcurrency)
    ? Math.max(1, Math.floor(hardwareConcurrency))
    : 4;
  return Math.min(4, Math.max(2, available - 2));
}

/** Callers discriminate on the name, so this message never reaches the UI. */
function abortError(): Error {
  const error = new Error("Export aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function throwIfInProcessMotionFallbackDisabled(input: ExportInput): void {
  if (input.allowInProcessMotionFallback === false) {
    throw new Error(input.t.errorMotionWorkersUnavailable);
  }
}

/**
 * A finished render's name, split so the part that says what it is survives.
 *
 * The suffix comes from the kind rather than from the last dot in the name:
 * `animated.svg`, `transcript.png` and `animated.webp` are all two segments,
 * and reading only the last one calls a poster and an animation the same
 * thing. That is the distinction the row has to keep when the name is cut.
 */
export function splitExportFileName(
  kind: ExportKind,
  fileName: string,
): {
  stem: string;
  suffix: string;
} {
  const suffix = `.${EXTENSION_BY_KIND[kind]}`;
  return fileName.endsWith(suffix)
    ? { stem: fileName.slice(0, -suffix.length), suffix }
    : { stem: fileName, suffix: "" };
}

const MIME_BY_KIND: Record<ExportKind, string> = {
  "transcript-svg": "image/svg+xml",
  "transcript-png": "image/png",
  "poster-svg": "image/svg+xml",
  "animated-svg": "image/svg+xml",
  "poster-png": "image/png",
  "poster-webp": "image/webp",
  "animated-webp": "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
};

const EXTENSION_BY_KIND: Record<ExportKind, string> = {
  ...RENDERABLE_EXTENSIONS,
  mp4: "mp4",
  "transcript-svg": "transcript.svg",
  "transcript-png": "transcript.png",
};

/** A finished export held in memory until the user asks to save it. */
export type ExportResult = {
  kind: ExportKind;
  fileName: string;
  blob: Blob;
};

/** Hand a finished export to the browser's download flow. */
/**
 * Object URLs for finished renders, kept until the next run replaces them.
 *
 * They cannot be revoked beside the click. Safari on iOS answers a download
 * with a sheet and does not read the URL until the reader taps through it,
 * which is seconds later — by then a URL revoked in the same tick is gone from
 * the blob registry, and the tap lands on `WebKitBlobResource error 1`.
 */
/**
 * The blob URLs one export runner has handed out. Owned rather than global:
 * every studio on the page runs its own, so releasing a finished batch can
 * never take away the URL another studio's preview is reading, or the one its
 * download has not opened yet. A blob that never reaches a registry is a blob
 * that leaks, so minting and releasing live in the same object.
 */
export type ExportUrls = {
  /** The URL a finished render is read from, for both saving and previewing. */
  url: (blob: Blob) => string;
  /** Give up every URL this runner minted. */
  releaseAll: () => void;
};

export function createExportUrls(): ExportUrls {
  const minted = new Map<Blob, string>();
  return {
    url: (blob) => {
      const existing = minted.get(blob);
      if (existing !== undefined) {
        return existing;
      }
      const objectUrl = URL.createObjectURL(blob);
      minted.set(blob, objectUrl);
      return objectUrl;
    },
    releaseAll: () => {
      for (const objectUrl of minted.values()) {
        URL.revokeObjectURL(objectUrl);
      }
      minted.clear();
    },
  };
}

/**
 * Whether the artifact can be handed to the system's own share sheet.
 *
 * A capability, not a platform: asked of the browser rather than guessed from
 * the device, so the button appears exactly where it would work. Desktop
 * browsers that decline simply keep the one button they had.
 */
export function canShareExport(result: ExportResult): boolean {
  return (
    typeof navigator.canShare === "function" && navigator.canShare({ files: [exportFile(result)] })
  );
}

function exportFile(result: ExportResult): File {
  return new File([result.blob], result.fileName, { type: result.blob.type });
}

/**
 * Hands the artifact to the share sheet, where the reader picks the
 * destination — the post, the chat, the photo library, or a file.
 *
 * Nothing is awaited before the call. A share has to be made while the click
 * that asked for it is still the window's transient activation, and a browser
 * that has lost it refuses. The blob is already in memory, so the file is
 * built in the same tick and handed over immediately.
 *
 * No title, either: with one present, iOS has been observed to share the text
 * and leave the file behind.
 */
export async function shareExport(result: ExportResult): Promise<void> {
  await navigator.share({ files: [exportFile(result)] });
}

export function downloadExport(urls: ExportUrls, result: ExportResult): void {
  downloadBlob(urls, result.blob, result.fileName);
}

export function downloadBlob(urls: ExportUrls, blob: Blob, fileName: string): void {
  const link = document.createElement("a");
  link.href = urls.url(blob);
  link.download = fileName;
  // A new tab, so the studio's own document survives the hand-off. Opening the
  // artifact in place unloads the app: the reader who taps "view" and comes
  // back finds the session gone, and the blob its document owned goes with it.
  // Browsers that honour `download` never navigate and ignore the target.
  link.target = "_blank";
  link.rel = "noopener";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

export function isMp4Supported(): boolean {
  return typeof globalThis.VideoEncoder !== "undefined";
}

/**
 * Whether this kind emits vector output. Vector artifacts carry no pixel
 * grid, so the raster scale factor neither changes them nor belongs in
 * their file name.
 */
function isVectorExport(kind: ExportKind): boolean {
  return kind === "poster-svg" || kind === "animated-svg" || kind === "transcript-svg";
}

/**
 * The moment of the save, compact enough for a file name. Two saves of the
 * same scene are different files — without this the browser invents its own
 * "(1)" suffixes to say so.
 */
export function exportTimestamp(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/**
 * File name for one export. The `@Nx` tag reports the scale the bytes really
 * carry: the engine lowers an oversized raster request rather than refusing
 * it, so naming the file after the request would misdescribe it.
 */
function exportFileName(scene: BuiltScene, kind: ExportKind, requestedScale: number): string {
  const stamp = exportTimestamp();
  if (isVectorExport(kind) || requestedScale === 1) {
    return `${scene.fileStem}-${stamp}.${EXTENSION_BY_KIND[kind]}`;
  }
  const { appliedScale } = resolveSceneRasterScale(scene, requestedScale);
  const tag = appliedScale === 1 ? "" : `@${Number(appliedScale.toFixed(2))}x`;
  return `${scene.fileStem}${tag}-${stamp}.${EXTENSION_BY_KIND[kind]}`;
}

/**
 * Refuses an unexportable scene before any encoding: the worker and MP4
 * paths run for minutes, and a scene that cannot be stamped must not cost a
 * render first. renderArtifact repeats both checks for the kinds it serves.
 */
function resolveExportProvenance(scene: BuiltScene): ArtifactProvenance {
  const provenance = provenanceFor(scene);
  if (scene.generator === undefined) {
    throw new Error(
      "Refusing to export a scene without generator identity: pass the owning runtime name and version to buildSvgentScene",
    );
  }
  return provenance;
}

/** The kinds `renderArtifact` serves in-process, with the studio's options mapped. */
function renderDirectArtifact(
  input: ExportInput,
  kind: RenderableKind,
  rasterScale: number | undefined,
): Uint8Array | string {
  return renderArtifact(input.engine, input.scene, {
    kind,
    animatedSvgIterations: input.animatedSvgIterations ?? "infinite",
    ...(rasterScale !== undefined ? { scale: rasterScale } : {}),
  });
}

export async function exportArtifact(input: ExportInput): Promise<ExportResult> {
  const { engine, scene, kind } = input;
  const provenance = resolveExportProvenance(scene);
  const rasterScale = input.scale !== undefined && input.scale !== 1 ? input.scale : undefined;
  const fileName = exportFileName(scene, kind, input.scale ?? 1);
  let bytes: Uint8Array | string;
  if (kind === "mp4") {
    if (!isMp4Supported()) {
      throw new Error(input.t.errorMp4Unsupported);
    }
    bytes = stampMp4Provenance(await exportMp4(input), provenance);
  } else if (kind === "animated-webp" || kind === "gif") {
    // The worker render path returns raw engine bytes; stamping is idempotent,
    // so the in-process fallback (already stamped by renderArtifact) passes
    // through unchanged.
    const raster = await exportAnimatedRaster(input, kind);
    bytes =
      kind === "gif"
        ? stampGifProvenance(raster, provenance)
        : stampWebpProvenance(raster, provenance);
  } else if (kind === "transcript-svg" || kind === "transcript-png") {
    // The caller hands in a fullHeight scene; only the artifact kind maps.
    // It renders as a poster, and a poster of the same scene would otherwise
    // name its identifiers identically — same surface, same page, same kind
    // tag. Two of them in one document would collide, so the transcript says
    // which one it is.
    bytes = renderArtifact(engine, scene, {
      kind: kind === "transcript-svg" ? "poster-svg" : "poster-png",
      asTranscript: true,
      ...(rasterScale !== undefined ? { scale: rasterScale } : {}),
    });
  } else {
    bytes = renderDirectArtifact(input, kind, rasterScale);
  }
  throwIfAborted(input.signal);
  const body = typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  return { kind, fileName, blob: new Blob([body], { type: MIME_BY_KIND[kind] }) };
}

/** Long scenes take minutes to rasterize and encode; 30 s would cut them off. */
const ANIMATED_RASTER_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Animated WebP/GIF rasterize and encode every frame in one synchronous wasm
 * call — on the main thread that freezes the tab for minutes until the
 * browser kills the page. Run it in a Worker engine instead; fall back to
 * the in-process renderer when workers are unavailable.
 */
async function exportAnimatedRaster(
  input: ExportInput,
  kind: "animated-webp" | "gif",
): Promise<Uint8Array> {
  const { engine, scene, signal } = input;
  throwIfAborted(signal);
  const rasterScale = input.scale !== undefined && input.scale !== 1 ? input.scale : undefined;
  const motionSettings = resolveMotionExportSettings(
    input.motionQuality ?? DEFAULT_MOTION_EXPORT_QUALITY,
  );
  const options = {
    durationMs: scene.durationMs,
    fps: payloadSafeFps(engine, scene, motionSettings.animatedRasterFps),
    iterations: "infinite" as const,
    generator: scene.generator,
    ...(rasterScale !== undefined ? { scale: rasterScale } : {}),
  };
  if (input.onEstimate) {
    // One probe frame prices the machine; encode overhead rides on a fudge
    // factor. Good enough for a "walk away or wait" call.
    const probeStart = performance.now();
    engine.renderToPng(scene.vnode, {
      timeMs: scene.durationMs / 2,
      ...(rasterScale !== undefined ? { scale: rasterScale } : {}),
    });
    const perFrameMs = performance.now() - probeStart;
    const frameCount = Math.max(2, Math.ceil((scene.durationMs / 1_000) * options.fps));
    input.onEstimate(perFrameMs * frameCount * 1.3);
  }
  // Flips once a worker engine exists: from then on an error is a real
  // render failure that must surface — re-running the whole render on the
  // main thread would cause exactly the multi-minute freeze the worker
  // exists to prevent.
  let workerReady = false;
  try {
    const { WorkerEngine } = await import("@boundsvg/worker");
    const fonts = input.fonts;
    if (fonts.length === 0) {
      throw new Error(`No fonts resolved for ${kind} export`);
    }
    const workerEngine = await WorkerEngine.create({
      worker: new Worker(new URL("@boundsvg/worker/worker", import.meta.url), { type: "module" }),
      // Buffers are transferred into the Worker, so hand over copies.
      fonts: fonts.map((font) => ({
        alias: font.alias,
        weight: font.weight,
        style: font.style,
        data: font.data.slice().buffer,
      })),
      timeout: ANIMATED_RASTER_TIMEOUT_MS,
    });
    workerReady = true;
    // Terminating the Worker is the cancel mechanism: the pending render
    // promise loses its responder and the abort race below surfaces first.
    const onAbort = () => workerEngine.dispose();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const sceneDocument = toSceneDocument(scene.vnode as VNode);
      const render =
        kind === "gif"
          ? workerEngine.renderToAnimatedGif(sceneDocument, options)
          : workerEngine.renderToAnimatedWebp(sceneDocument, options);
      const abort = abortRejection(signal);
      try {
        return await Promise.race([render, abort.rejection]);
      } finally {
        abort.detach();
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      workerEngine.dispose();
    }
  } catch (cause) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (workerReady) {
      throw cause;
    }
    throwIfInProcessMotionFallbackDisabled(input);
    // Worker path unavailable (no module workers, blocked worker script):
    // fall back to the slower in-process renderer rather than failing.
    console.warn(
      `svgent: worker ${kind} export unavailable, falling back to in-process render`,
      cause,
    );
    return renderArtifact(engine, scene, {
      kind,
      motionQuality: input.motionQuality ?? DEFAULT_MOTION_EXPORT_QUALITY,
      ...(rasterScale !== undefined ? { scale: rasterScale } : {}),
    }) as Uint8Array;
  }
}

/**
 * A promise that only ever rejects — when the signal aborts. Returns the
 * detach alongside it: the winner of the race has to remove the listener,
 * or a long-lived signal would accumulate one per export.
 */
function abortRejection(signal: AbortSignal | undefined): {
  rejection: Promise<never>;
  detach: () => void;
} {
  let onAbort: (() => void) | null = null;
  const rejection = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return {
    rejection,
    detach: () => {
      if (onAbort) {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

const LEGACY_MP4_FRAME_RATE = 20;

/** A single 4K-equivalent frame may legitimately exceed the worker default. */
const MP4_FRAME_WORKER_TIMEOUT_MS = 2 * 60 * 1_000;

/**
 * H.264 High-profile levels in ascending order, with the frame size each one
 * covers in 16×16 macroblocks. The encoder library defaults to level 4.0,
 * which stops at 1080p — every larger canvas and every ×2/×3 scale needs the
 * level raised or the browser rejects the configuration outright.
 */
const H264_LEVELS: Array<{ codec: string; maxMacroblocks: number }> = [
  { codec: "avc1.640028", maxMacroblocks: 8_192 },
  { codec: "avc1.64002a", maxMacroblocks: 8_704 },
  { codec: "avc1.640032", maxMacroblocks: 22_080 },
  { codec: "avc1.640033", maxMacroblocks: 36_864 },
  { codec: "avc1.64003c", maxMacroblocks: 139_264 },
];

/** MP4 frames are padded to even dimensions before they reach the encoder. */
function mp4FrameSize(width: number, height: number, scale: number): [number, number] {
  return [Math.ceil((width * scale) / 2) * 2, Math.ceil((height * scale) / 2) * 2];
}

/**
 * Whether H.264 can describe a frame this large at all. Pure arithmetic on
 * the level table so the export dialog can warn before an encode starts;
 * `pickH264Codec` still asks the browser what it will actually accept.
 */
export function exceedsMp4FrameLimit(width: number, height: number, scale: number): boolean {
  const [w, h] = mp4FrameSize(width, height, scale);
  const macroblocks = Math.ceil(w / 16) * Math.ceil(h / 16);
  const top = H264_LEVELS[H264_LEVELS.length - 1];
  return top === undefined || macroblocks > top.maxMacroblocks;
}

/**
 * Lowest level this runtime will actually accept for the frame. Hardware
 * encoders decline sizes the spec permits, so the browser is asked rather
 * than trusted to match the table; null means nothing will encode a frame
 * this large and the caller should say so before rendering anything. When
 * no probe exists the table's own answer goes through, leaving the encoder
 * to report the real reason as it did before.
 */
export async function pickH264Codec(
  width: number,
  height: number,
  frameRate = LEGACY_MP4_FRAME_RATE,
): Promise<string | null> {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const candidates = H264_LEVELS.filter((level) => macroblocks <= level.maxMacroblocks);
  const probe = globalThis.VideoEncoder?.isConfigSupported;
  if (typeof probe !== "function") {
    return candidates[0]?.codec ?? null;
  }
  for (const level of candidates) {
    try {
      const support = await probe.call(globalThis.VideoEncoder, {
        codec: level.codec,
        width,
        height,
        framerate: frameRate,
      });
      if (support.supported) {
        return level.codec;
      }
    } catch {
      // Not describable for this runtime — try the next level up.
    }
  }
  return null;
}

/** Even-padded MP4 frame size for a canvas at an export scale. */
export function mp4FrameSizeFor(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  const [w, h] = mp4FrameSize(width, height, scale);
  return { width: w, height: h };
}

/**
 * MP4 export samples every frame through a WorkerPool so rasterization runs
 * in parallel off the main thread — the single-threaded path froze the tab
 * for minutes on long scenes. Falls back to in-process rendering when module
 * workers are unavailable.
 */
async function exportMp4(input: ExportInput): Promise<Uint8Array> {
  const { scene, signal } = input;
  const motionSettings = resolveMotionExportSettings(
    input.motionQuality ?? DEFAULT_MOTION_EXPORT_QUALITY,
  );
  const frameRate = motionSettings.mp4FrameRate;
  // Shared by the worker and the in-process paths below.
  const progressOption = input.onProgress
    ? {
        onProgress: (done: number, total: number) => {
          input.onProgress?.({ done, total });
        },
      }
    : {};
  throwIfAborted(signal);
  const rasterScale = input.scale !== undefined && input.scale !== 1 ? input.scale : undefined;
  const background = input.mp4Background;
  const frameCount = Math.max(2, Math.ceil((scene.durationMs / 1_000) * frameRate));
  const timesMs = Array.from(
    { length: frameCount },
    (_unused, index) => (index * 1_000) / frameRate,
  );
  // Decided before a single frame is rasterized: an unencodable size should
  // cost the user a message, not minutes of rendering that then throws.
  // Frames go through the engine's raster ceiling like any other raster
  // export, so the level is chosen for the size that will really be encoded.
  const applied = resolveSceneRasterScale(scene, input.scale ?? 1);
  const [frameWidth, frameHeight] = [
    Math.ceil(applied.outputWidth / 2) * 2,
    Math.ceil(applied.outputHeight / 2) * 2,
  ];
  const codec = await pickH264Codec(frameWidth, frameHeight, frameRate);
  if (codec === null) {
    throw new Error(input.t.errorMp4TooLarge(frameWidth, frameHeight));
  }
  const codecOption = { codec };

  // Flips once the pool exists: from then on an error is a real render
  // failure that must surface, not a cue to redo the render on the main
  // thread (see exportAnimatedRaster).
  let poolReady = false;
  try {
    const [{ WorkerPool }, { encodePngFramesToMp4 }] = await Promise.all([
      import("@boundsvg/worker"),
      import("@boundsvg/video"),
    ]);
    const fonts = input.fonts;
    if (fonts.length === 0) {
      throw new Error("No fonts resolved for MP4 export");
    }
    const concurrency = resolveExportWorkerConcurrency(
      input.resourceMode ?? DEFAULT_EXPORT_RESOURCE_MODE,
      globalThis.navigator?.hardwareConcurrency ?? 4,
    );
    const pool = await WorkerPool.create({
      worker: () =>
        new Worker(new URL("@boundsvg/worker/worker", import.meta.url), { type: "module" }),
      concurrency,
      timeout: MP4_FRAME_WORKER_TIMEOUT_MS,
      // Buffers are transferred into the pool snapshot, so hand over copies.
      fonts: fonts.map((font) => ({
        alias: font.alias,
        weight: font.weight,
        style: font.style,
        data: font.data.slice().buffer,
      })),
    });
    poolReady = true;
    // Disposing the pool terminates the frame workers mid-schedule; the
    // abort race below turns that into a clean AbortError.
    const onAbort = () => pool.dispose();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // The worker protocol transports the flattened SceneNode form, not the
      // {type, props, children} vnode shape.
      const sceneDocument = toSceneDocument(scene.vnode as VNode);
      const frames = pool.renderFrames(sceneDocument, {
        timesMs,
        format: "png",
        rasterBackground: background,
        // Frames arrive pre-scaled, so the encoder gets no scale of its own.
        ...(rasterScale !== undefined ? { scale: rasterScale } : {}),
      });
      const pngFrames = (async function* () {
        for await (const frame of frames) {
          if (frame.format !== "png") {
            throw new Error(`MP4 export expected png frames, got ${frame.format}`);
          }
          yield { data: frame.data, timeMs: frame.timeMs };
        }
      })();
      const encode = encodePngFramesToMp4(pngFrames, {
        frameRate,
        frameCount,
        background,
        generator: scene.generator,
        ...codecOption,
        ...progressOption,
      });
      const abort = abortRejection(signal);
      try {
        return await Promise.race([encode, abort.rejection]);
      } finally {
        abort.detach();
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      pool.dispose();
    }
  } catch (cause) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (poolReady) {
      throw cause;
    }
    throwIfInProcessMotionFallbackDisabled(input);
    // Worker path unavailable (no module workers, blocked worker script):
    // fall back to the slower in-process renderer rather than failing.
    console.warn("svgent: worker MP4 export unavailable, falling back to in-process render", cause);
    const { renderToMp4 } = await import("@boundsvg/video");
    return renderToMp4(input.engine, scene.vnode, {
      durationMs: scene.durationMs,
      frameRate,
      background,
      generator: scene.generator,
      ...codecOption,
      ...(rasterScale !== undefined ? { scale: rasterScale } : {}),
      ...progressOption,
    });
  }
}
