import {
  type Engine,
  MAX_ANIMATION_SVG_PAYLOAD_CHARS,
  RASTER_MAX_LONG_EDGE,
  RASTER_MAX_PIXELS,
  type ResolvedRasterScale,
  resolveRasterScale,
} from "@boundsvg/core";
import type { BuiltScene } from "@svgent/scene";
import { animatedRasterFps } from "@svgent/scene";
import {
  provenanceFor,
  stampGifProvenance,
  stampPngProvenance,
  stampWebpProvenance,
} from "./provenance.js";

/**
 * Artifact kinds the core engine can render in any runtime — browser and
 * Node share this path. MP4 is encoded elsewhere: WebCodecs in the studio UI
 * (src/exports.ts), ffmpeg in the CLI (scripts/mp4-ffmpeg.mts).
 */
export type RenderableKind =
  | "poster-svg"
  | "animated-svg"
  | "poster-png"
  | "poster-webp"
  | "animated-webp"
  | "gif";

export const RENDERABLE_KINDS: readonly RenderableKind[] = [
  "poster-svg",
  "animated-svg",
  "poster-png",
  "poster-webp",
  "animated-webp",
  "gif",
];

export const RENDERABLE_EXTENSIONS: Record<RenderableKind, string> = {
  "poster-svg": "svg",
  "animated-svg": "animated.svg",
  "poster-png": "png",
  "poster-webp": "webp",
  "animated-webp": "animated.webp",
  gif: "gif",
};

/** Motion sampling presets shared by Studio and CLI exports. */
export type MotionExportQuality = "economy" | "balanced" | "high";

/** How many times an animated SVG plays: loop like GIF/WebP, or run once. */
export type AnimatedSvgIterations = "infinite" | "once";

export type MotionExportSettings = {
  /** Upper bound for animated WebP/GIF sampling. */
  animatedRasterFps: number;
  /** MP4 sampling and playback rate. */
  mp4FrameRate: number;
  /** libx264 CRF used by the local CLI encoder (lower is higher quality). */
  mp4Crf: number;
};

/**
 * The balanced default cuts raster work without changing canvas resolution.
 * High preserves the pre-profile 20 fps behavior; economy is intended for
 * drafts and resource-constrained devices.
 */
export const DEFAULT_MOTION_EXPORT_QUALITY: MotionExportQuality = "balanced";

const MOTION_EXPORT_SETTINGS: Readonly<Record<MotionExportQuality, MotionExportSettings>> = {
  economy: { animatedRasterFps: 8, mp4FrameRate: 10, mp4Crf: 28 },
  balanced: { animatedRasterFps: 12, mp4FrameRate: 15, mp4Crf: 23 },
  high: { animatedRasterFps: 20, mp4FrameRate: 20, mp4Crf: 18 },
};

export function resolveMotionExportSettings(quality: MotionExportQuality): MotionExportSettings {
  return MOTION_EXPORT_SETTINGS[quality];
}

export { RASTER_MAX_LONG_EDGE, RASTER_MAX_PIXELS, resolveRasterScale };
export type { ResolvedRasterScale };

/** Canvas dimensions the scene was built at, read off its root vnode. */
function sceneCanvasSize(scene: BuiltScene): { width: number; height: number } {
  const props = (scene.vnode as { props?: { width?: number; height?: number } }).props;
  return { width: props?.width ?? 0, height: props?.height ?? 0 };
}

/** What a raster export of this scene will actually measure. */
export function resolveSceneRasterScale(
  scene: BuiltScene,
  requestedScale: number,
): ResolvedRasterScale {
  const { width, height } = sceneCanvasSize(scene);
  return resolveRasterScale({ width, height, requestedScale });
}

/**
 * Animated WebP/GIF ship every sampled frame as SVG text across the wasm
 * boundary, capped at 64M characters total. Text is outlined to paths, so
 * frames are big and near-constant in size — probe one frame and lower the
 * fps until the whole schedule fits.
 */
export function payloadSafeFps(
  engine: Engine,
  scene: BuiltScene,
  maximumFps = Number.POSITIVE_INFINITY,
): number {
  const baseFps = Math.min(animatedRasterFps(scene.durationMs), maximumFps);
  const probe = engine.renderToSvg(scene.vnode, {
    timeMs: scene.durationMs / 2,
    resourceIdPrefix: documentIdPrefix("payload-probe"),
  });
  const perFrameChars = probe.length + 4_096;
  const frameBudget = Math.floor((MAX_ANIMATION_SVG_PAYLOAD_CHARS * 0.92) / perFrameChars);
  const durationSeconds = Math.max(scene.durationMs, 1_000) / 1_000;
  const fpsBudget = Math.floor(frameBudget / durationSeconds);
  return Math.max(1, Math.min(baseFps, fpsBudget));
}

/**
 * What a render calls itself inside its identifiers. A transcript is drawn as
 * a poster but is a different artifact, so it says so here rather than
 * borrowing a namespace value — a caller's own `--id-namespace transcript`
 * would otherwise alias with it, and silently.
 */
type ArtifactKindTag = "poster" | "animation" | "transcript-poster";

/**
 * A CSS identifier accepts more than this, but a value that has to survive
 * being read back out of a class name and a `url(#…)` is better kept plain.
 */
const IDENTIFIER_NAMESPACE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/u;

/**
 * Reduces a value that was not chosen for this purpose — React's `useId`
 * returns `_R_1_` — to one `assertIdentifierNamespace` accepts. It has to
 * start with a letter or digit and be non-empty, so a leading run of
 * separators is replaced rather than dropped: deleting them would map `-x`
 * and `x` onto the same name.
 *
 * Reserved for values this package invents. A value a caller chose goes
 * through `assertIdentifierNamespace`, because deleting characters is not
 * injective — `pane/left` and `pane.left` would become one namespace, which
 * is the collision the namespace exists to prevent.
 */
export function normalizeIdentifierNamespace(value: string): string {
  const kept = value.replaceAll(/[^a-zA-Z0-9-]/gu, "");
  const stem = IDENTIFIER_NAMESPACE.test(kept) ? kept : `n${kept}`;
  // Deleting characters is not injective, and what arrives here is React's,
  // not this package's: two roots given `identifierPrefix` values of `a_` and
  // `a` would otherwise be handed one namespace and drive each other's
  // preview. The stem stays readable; the digest is what keeps them apart.
  return `${stem}-${digest(value)}`;
}

/** A short stable token for a value, in the alphabet a namespace accepts. */
function digest(value: string): string {
  let hash = 0x81_1c_9d_c5;
  for (let at = 0; at < value.length; at += 1) {
    hash ^= value.charCodeAt(at);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}

/** Throws unless the value can be part of a class name and a `url(#…)`. */
export function assertIdentifierNamespace(value: string): void {
  if (!IDENTIFIER_NAMESPACE.test(value)) {
    throw new Error(
      `identifierNamespace must be letters, digits or "-" and start with a letter or digit; got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Joins the parts of a document-global name and closes it with `_`.
 *
 * Two prefixes sharing a document have to be pairwise prefix-free, not merely
 * different: the renderer appends to what it is given, so `…-poster` and
 * `…-poster-a` would hand one render names that begin with the other's. That
 * is reachable from the documented use — `--id-namespace a` beside
 * `--id-namespace ab`, or one render namespaced and its neighbour not.
 *
 * `_` is what closes them, and it is the one character a part may not contain.
 * Every prefix therefore holds exactly one `_`, at its end: if one were a
 * proper prefix of another, the shorter one's `_` would sit inside the longer,
 * which cannot happen. Prefix-freeness is a property of the shape, not of the
 * values that happen to be in use.
 *
 * Distinctness is not. `-` both separates the parts and is legal inside one,
 * so `("a-b", "c")` and `("a", "b-c")` build the same prefix. The callers here
 * pass a fixed leading word and one identifier, which cannot collide that way;
 * a caller that varies the shape of its part list has to keep them apart
 * itself.
 */
export function documentIdPrefix(...parts: readonly string[]): string {
  if (parts.length === 0) {
    throw new Error("documentIdPrefix needs at least one part");
  }
  for (const part of parts) {
    assertIdentifierNamespace(part);
  }
  return `${parts.join("-")}_`;
}

/**
 * What every document-global name in one SVG is built from. The kind tag
 * separates a poster from an animation of the same scene; the namespace, when
 * given, separates this render from any other sharing a document with it.
 */
function resourceIdPrefix(
  scene: BuiltScene,
  kindTag: ArtifactKindTag,
  namespace: string | undefined,
): string {
  // The kind comes first and is drawn from a closed set, so no namespace can
  // spell its way into another kind's names: a poster always reads
  // `…-poster` where a transcript reads `…-transcript-poster`.
  return namespace === undefined
    ? documentIdPrefix(scene.fileStem, kindTag)
    : documentIdPrefix(scene.fileStem, kindTag, namespace);
}

/** Render one artifact for a built scene; SVG kinds return markup text, raster kinds bytes. */
export function renderArtifact(
  engine: Engine,
  scene: BuiltScene,
  request:
    | RenderableKind
    | {
        kind: RenderableKind;
        scale?: number;
        /** Sampling preset for animated WebP/GIF. Other kinds ignore it. */
        motionQuality?: MotionExportQuality;
        /**
         * How many times the animated SVG plays — "infinite" (the default)
         * loops the way GIF and WebP are encoded to, "once" rests on the
         * final frame. Other kinds ignore it.
         */
        animatedSvgIterations?: AnimatedSvgIterations;
        /**
         * Called when the engine's raster ceiling lowered the scale. Without
         * it an oversized request just returns a smaller file in silence.
         */
        onResolutionAdjusted?: (adjustment: ResolvedRasterScale) => void;
        /**
         * Distinguishes this render's document-global identifiers from
         * another's. An SVG names its `@keyframes`, its generated classes and
         * its `<defs>` after the scene's file stem, which is only the surface
         * and the page number — so two renders of different scripts on the
         * same surface name things identically. Alone in a file that collides
         * with nothing. Expanded inline into one HTML document they share a
         * namespace, the last `@keyframes` of a given name wins, and elements
         * animate on another document's timing.
         *
         * Pass a value per inlined render. `<img>`, `<object>` and `<iframe>`
         * are separate documents and need none. Raster kinds carry no
         * identifiers and ignore it.
         */
        identifierNamespace?: string;
        /**
         * A transcript is drawn as a poster but is a different artifact of the
         * same scene. Without this the two name their identifiers identically
         * and cannot share a document.
         */
        asTranscript?: boolean;
      },
): Uint8Array | string {
  const {
    kind,
    scale: requestedScale,
    motionQuality,
    animatedSvgIterations,
    onResolutionAdjusted,
    identifierNamespace,
    asTranscript,
  } = typeof request === "string"
    ? {
        kind: request,
        scale: undefined,
        motionQuality: undefined,
        animatedSvgIterations: undefined,
        onResolutionAdjusted: undefined,
        identifierNamespace: undefined,
        asTranscript: undefined,
      }
    : request;
  if (!scene.measured) {
    // The scene placed its rows by estimate and this engine would lay the
    // glyphs out for real. Two sources of truth for one layout is how blocks
    // come out with holes in them, or on top of each other.
    throw new Error(
      "Refusing to render a scene built without an engine: pass the rendering engine to buildSvgentScene so the layout is measured by whatever draws it",
    );
  }
  if (scene.generator === undefined) {
    throw new Error(
      "Refusing to render a scene without generator identity: pass the owning runtime name and version to buildSvgentScene",
    );
  }
  // SVG kinds carry provenance as canvas meta through the engine; raster
  // containers lose it in encoding, so it is stamped onto the bytes below.
  const provenance = provenanceFor(scene);
  // Raster resolution multiplier, independent of the authored canvas size.
  // Vector SVG output stays untouched — it scales losslessly anyway.
  const scale =
    requestedScale !== undefined && requestedScale !== 1 ? { scale: requestedScale } : {};
  if (onResolutionAdjusted !== undefined && requestedScale !== undefined) {
    const resolved = resolveSceneRasterScale(scene, requestedScale);
    if (resolved.adjusted) {
      onResolutionAdjusted(resolved);
    }
  }
  switch (kind) {
    case "poster-svg":
      return engine.renderToSvg(scene.vnode, {
        timeMs: scene.durationMs,
        resourceIdPrefix: resourceIdPrefix(
          scene,
          asTranscript === true ? "transcript-poster" : "poster",
          identifierNamespace,
        ),
        generator: scene.generator,
      });
    case "animated-svg":
      return engine.renderToAnimatedSvg(scene.vnode, {
        // One document clock either way, so a once-through file and a looping
        // one carry identical motion. The default loops the way GIF and WebP
        // are encoded to — a README cannot script a replay, so a file that
        // rests on its last frame gives a late reader nothing.
        playback: {
          mode: "timeline",
          durationMs: scene.durationMs,
          iterations: animatedSvgIterations === "once" ? 1 : "infinite",
        },
        reducedMotion: "pause",
        resourceIdPrefix: resourceIdPrefix(scene, "animation", identifierNamespace),
        generator: scene.generator,
      });
    case "poster-png":
      return stampPngProvenance(
        engine.renderToPng(scene.vnode, {
          timeMs: scene.durationMs,
          generator: scene.generator,
          ...scale,
        }),
        provenance,
      );
    case "poster-webp":
      return stampWebpProvenance(
        engine.renderToWebp(scene.vnode, {
          timeMs: scene.durationMs,
          generator: scene.generator,
          ...scale,
        }),
        provenance,
      );
    case "animated-webp": {
      const quality = motionQuality ?? "high";
      const settings = resolveMotionExportSettings(quality);
      return stampWebpProvenance(
        engine.renderToAnimatedWebp(scene.vnode, {
          durationMs: scene.durationMs,
          fps: payloadSafeFps(engine, scene, settings.animatedRasterFps),
          iterations: "infinite",
          generator: scene.generator,
          ...scale,
        }),
        provenance,
      );
    }
    case "gif": {
      const quality = motionQuality ?? "high";
      const settings = resolveMotionExportSettings(quality);
      return stampGifProvenance(
        engine.renderToAnimatedGif(scene.vnode, {
          durationMs: scene.durationMs,
          fps: payloadSafeFps(engine, scene, settings.animatedRasterFps),
          iterations: "infinite",
          generator: scene.generator,
          ...scale,
        }),
        provenance,
      );
    }
  }
}
