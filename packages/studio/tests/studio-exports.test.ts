import type { ResolvedBrowserFont } from "@boundsvg/browser";
import { createElement, type Engine } from "@boundsvg/core";
import type { BuiltScene } from "@svgent/scene";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportMotionQualityApplies,
  exportResourceModeApplies,
  exportRunDisabled,
  exportScaleApplies,
  exportScaleOptions,
  isSimpleExportChoice,
} from "../src/export-panel.js";
import {
  assessBrowserMotionExport,
  browserMotionEstimateStatus,
  studioEntryExportScale,
} from "../src/export-policy.js";
import {
  exceedsMp4FrameLimit,
  exportArtifact,
  resolveExportWorkerConcurrency,
} from "../src/exports.js";
import { UI_STRINGS } from "../src/i18n.js";

const mocks = vi.hoisted(() => ({
  encodePngFramesToMp4: vi.fn(),
  renderToMp4: vi.fn(),
  workerPoolCreate: vi.fn(),
  poolRenderFrames: vi.fn(),
  poolDispose: vi.fn(),
  workerEngineCreate: vi.fn(),
  workerRenderToAnimatedGif: vi.fn(),
  workerRenderToAnimatedWebp: vi.fn(),
  workerEngineDispose: vi.fn(),
}));

const TEST_GENERATOR = { name: "embedded-studio", version: "1.2.3" } as const;

// Mirrors packages/render/tests/container-fixtures.ts, which this suite
// cannot import across the workspace boundary. A change to how the stampers
// walk a container updates both copies.
function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

/** Smallest MP4 the provenance stamp can rewrite: ftyp, empty moov, mdat. */
function syntheticMp4(): Uint8Array {
  const parts = [
    mp4Box("ftyp", new TextEncoder().encode("isom0000")),
    mp4Box("moov", new Uint8Array(0)),
    mp4Box("mdat", new Uint8Array([0, 1])),
  ];
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** 1x1 header-only GIF: signature, screen descriptor, trailer. */
function syntheticGif(): Uint8Array {
  const bytes = new Uint8Array(14);
  bytes.set(new TextEncoder().encode("GIF89a"), 0);
  bytes[6] = 1;
  bytes[8] = 1;
  bytes[13] = 0x3b;
  return bytes;
}

/** WebP container holding only the engine-style XMP chunk. */
function syntheticWebp(): Uint8Array {
  const encoder = new TextEncoder();
  const xmp = encoder.encode(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>',
  );
  const padded = xmp.length % 2 === 1 ? 1 : 0;
  const bytes = new Uint8Array(12 + 8 + xmp.length + padded);
  bytes.set(encoder.encode("RIFF"), 0);
  bytes.set(encoder.encode("WEBP"), 8);
  bytes.set(encoder.encode("XMP "), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, xmp.length, true);
  bytes.set(xmp, 20);
  return bytes;
}

vi.mock("@boundsvg/video", () => ({
  encodePngFramesToMp4: mocks.encodePngFramesToMp4,
  renderToMp4: mocks.renderToMp4,
}));

vi.mock("@boundsvg/worker", () => ({
  WorkerPool: { create: mocks.workerPoolCreate },
  WorkerEngine: { create: mocks.workerEngineCreate },
}));

const scene: BuiltScene = {
  vnode: createElement(
    "Canvas",
    // Exports refuse a scene whose canvas declares no provenance, exactly as
    // buildSvgentScene stamps it.
    { width: 8, height: 4, meta: { simulated: "true", "model-kind": "fictional" } },
    createElement("Box", { width: 8, height: 4, background: "#8b7cf6" }),
  ),
  durationMs: 100,
  measured: true,
  clampedPropCount: 0,
  pageCount: 1,
  pageIndex: 0,
  fileStem: "svgent-test-01",
  messageRevealMs: {},
  messagePage: {},
  messageTimings: [],
  generator: TEST_GENERATOR,
};

const fonts: ResolvedBrowserFont[] = [
  {
    alias: "test-sans",
    weight: 400,
    style: "normal",
    data: new Uint8Array([1]),
  },
];

const engine = {
  renderToSvg: vi.fn(() => "<svg/>"),
  renderToPng: vi.fn(() => new Uint8Array([1])),
} as unknown as Engine;

describe("studio export generator metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("Worker", class {});
    vi.stubGlobal("VideoEncoder", class {});
    mocks.poolRenderFrames.mockReturnValue(
      (async function* () {
        yield { format: "png", data: new Uint8Array([1]), timeMs: 0 };
      })(),
    );
    mocks.workerPoolCreate.mockResolvedValue({
      renderFrames: mocks.poolRenderFrames,
      dispose: mocks.poolDispose,
    });
    // Encoder results pass through the provenance stamp, which parses the
    // container — the mocked bytes have to be minimally valid files.
    mocks.encodePngFramesToMp4.mockResolvedValue(syntheticMp4());
    mocks.renderToMp4.mockResolvedValue(syntheticMp4());
    mocks.workerRenderToAnimatedGif.mockResolvedValue(syntheticGif());
    mocks.workerRenderToAnimatedWebp.mockResolvedValue(syntheticWebp());
    mocks.workerEngineCreate.mockResolvedValue({
      renderToAnimatedGif: mocks.workerRenderToAnimatedGif,
      renderToAnimatedWebp: mocks.workerRenderToAnimatedWebp,
      dispose: mocks.workerEngineDispose,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds metadata only to the completed worker-encoded MP4", async () => {
    await exportArtifact({
      engine,
      scene,
      kind: "mp4",
      mp4Background: "#090b10",
      fonts,
      t: UI_STRINGS.en,
    });

    expect(mocks.poolRenderFrames.mock.calls[0]?.[1]).not.toHaveProperty("generator");
    expect(mocks.encodePngFramesToMp4.mock.calls[0]?.[1]).toMatchObject({
      frameRate: 15,
      generator: TEST_GENERATOR,
    });
    expect(mocks.workerPoolCreate.mock.calls[0]?.[0]).toMatchObject({
      concurrency: 2,
      timeout: 120_000,
    });
  });

  it("preserves metadata on the in-process MP4 fallback", async () => {
    mocks.workerPoolCreate.mockRejectedValueOnce(new Error("workers unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await exportArtifact({
        engine,
        scene,
        kind: "mp4",
        mp4Background: "#090b10",
        fonts,
        t: UI_STRINGS.en,
      });
    } finally {
      warning.mockRestore();
    }

    expect(mocks.renderToMp4.mock.calls[0]?.[2]).toMatchObject({
      generator: TEST_GENERATOR,
    });
  });

  it.each([
    ["gif", mocks.workerRenderToAnimatedGif],
    ["animated-webp", mocks.workerRenderToAnimatedWebp],
  ] as const)("passes metadata through the worker %s export", async (kind, renderMock) => {
    await exportArtifact({
      engine,
      scene,
      kind,
      mp4Background: "#090b10",
      fonts,
      t: UI_STRINGS.en,
    });

    expect(renderMock.mock.calls[0]?.[1]).toMatchObject({ generator: TEST_GENERATOR });
  });

  it("refuses a scene without provenance before any encoder runs", async () => {
    const bare: BuiltScene = {
      ...scene,
      vnode: createElement(
        "Canvas",
        { width: 8, height: 4 },
        createElement("Box", { width: 8, height: 4, background: "#8b7cf6" }),
      ),
    };
    await expect(
      exportArtifact({
        engine,
        scene: bare,
        kind: "animated-webp",
        mp4Background: "#090b10",
        fonts,
        t: UI_STRINGS.en,
      }),
    ).rejects.toThrow(/without provenance/u);
    expect(mocks.workerEngineCreate).not.toHaveBeenCalled();
    expect(mocks.workerRenderToAnimatedWebp).not.toHaveBeenCalled();
  });

  it("refuses a scene without generator identity before any encoder runs", async () => {
    const bare: BuiltScene = { ...scene, generator: undefined };
    await expect(
      exportArtifact({
        engine,
        scene: bare,
        kind: "mp4",
        mp4Background: "#090b10",
        fonts,
        t: UI_STRINGS.en,
      }),
    ).rejects.toThrow(/without generator identity/u);
    expect(mocks.workerPoolCreate).not.toHaveBeenCalled();
    expect(mocks.encodePngFramesToMp4).not.toHaveBeenCalled();
  });

  it("stamps provenance onto every encoder output", async () => {
    for (const kind of ["mp4", "gif", "animated-webp"] as const) {
      const result = await exportArtifact({
        engine,
        scene,
        kind,
        mp4Background: "#090b10",
        fonts,
        t: UI_STRINGS.en,
      });
      const text = new TextDecoder().decode(new Uint8Array(await result.blob.arrayBuffer()));
      if (kind === "animated-webp") {
        expect(text).toContain("<svgent:simulated>true</svgent:simulated>");
        expect(text).toContain("<svgent:model-kind>fictional</svgent:model-kind>");
      } else {
        expect(text).toContain('{"simulated":true,"model-kind":"fictional"}');
      }
    }
  });

  it("applies explicit motion quality and resource controls", async () => {
    await exportArtifact({
      engine,
      scene,
      kind: "mp4",
      mp4Background: "#090b10",
      fonts,
      motionQuality: "economy",
      resourceMode: "memory",
      t: UI_STRINGS.en,
    });

    expect(mocks.workerPoolCreate.mock.calls[0]?.[0]).toMatchObject({ concurrency: 1 });
    expect(mocks.encodePngFramesToMp4.mock.calls[0]?.[1]).toMatchObject({ frameRate: 10 });
  });

  it("keeps the measured low-level motion request available unchanged", async () => {
    await exportArtifact({
      engine,
      scene,
      kind: "animated-webp",
      mp4Background: "#090b10",
      fonts,
      scale: 2,
      motionQuality: "high",
      t: UI_STRINGS.en,
    });

    expect(mocks.workerRenderToAnimatedWebp.mock.calls[0]?.[1]).toMatchObject({
      fps: 20,
      scale: 2,
    });
  });

  it("refuses the Studio no-fallback mode instead of freezing the main thread", async () => {
    mocks.workerPoolCreate.mockRejectedValueOnce(new Error("workers unavailable"));

    await expect(
      exportArtifact({
        engine,
        scene,
        kind: "mp4",
        mp4Background: "#090b10",
        fonts,
        allowInProcessMotionFallback: false,
        t: UI_STRINGS.en,
      }),
    ).rejects.toThrow("Motion Workers are unavailable");
    expect(mocks.renderToMp4).not.toHaveBeenCalled();
  });
});

describe("MP4 frame-size limit", () => {
  it.each([
    [1920, 1080, 1],
    [1920, 1080, 2],
    [2560, 1440, 2],
    [2560, 2560, 2],
  ])("encodes %ix%i at x%i", (width, height, scale) => {
    expect(exceedsMp4FrameLimit(width, height, scale)).toBe(false);
  });

  it("rejects a frame past the top H.264 level", () => {
    // 7680x7680 needs 230 400 macroblocks; level 6.0 tops out at 139 264.
    expect(exceedsMp4FrameLimit(2560, 2560, 3)).toBe(true);
  });
});

describe("export scale applicability", () => {
  it.each([
    "poster-svg",
    "animated-svg",
    "transcript-svg",
    "script",
  ] as const)("offers no scale factor for %s", (kind) => {
    expect(exportScaleApplies(kind)).toBe(false);
  });

  it.each([
    "poster-png",
    "poster-webp",
    "transcript-png",
    "animated-webp",
    "gif",
    "mp4",
  ] as const)("offers a scale factor for %s", (kind) => {
    expect(exportScaleApplies(kind)).toBe(true);
  });

  it("offers downscaling for motion without changing still-image scale choices", () => {
    expect(exportScaleOptions("mp4")).toEqual([0.5, 0.75, 1]);
    expect(exportScaleOptions("gif")).toEqual([0.5, 0.75, 1]);
    expect(exportScaleOptions("poster-png")).toEqual([0.5, 0.75, 1, 2, 3]);
  });

  it.each(["animated-webp", "gif", "mp4"] as const)("offers motion quality for %s", (kind) => {
    expect(exportMotionQualityApplies(kind)).toBe(true);
  });

  it.each([
    "poster-png",
    "animated-svg",
    "script",
  ] as const)("does not offer motion quality for %s", (kind) => {
    expect(exportMotionQualityApplies(kind)).toBe(false);
  });

  it("offers MP4 worker controls only for MP4", () => {
    expect(exportResourceModeApplies("mp4")).toBe(true);
    expect(exportResourceModeApplies("gif")).toBe(false);
  });
});

describe("Studio browser-motion admission policy", () => {
  it("caps browser motion at authored size while allowing downscaling", () => {
    expect(studioEntryExportScale("poster-png", 2)).toBe(2);
    expect(studioEntryExportScale("animated-webp", 2)).toBe(1);
    expect(studioEntryExportScale("gif", 0.75)).toBe(0.75);
    expect(studioEntryExportScale("mp4", 0.5)).toBe(0.5);
    expect(studioEntryExportScale("mp4", 0.25)).toBe(0.5);
  });

  it("keeps raster motion out of the simple wizard", () => {
    expect(isSimpleExportChoice("poster-png")).toBe(true);
    expect(isSimpleExportChoice("animated-svg")).toBe(true);
    expect(isSimpleExportChoice("mp4")).toBe(false);
    expect(isSimpleExportChoice("gif")).toBe(false);
  });

  it("blocks the run button while an entry policy is unresolved or blocked", () => {
    expect(
      exportRunDisabled({
        kind: "mp4",
        engineReady: true,
        busy: false,
        issueCount: 0,
        entryBlocked: true,
      }),
    ).toBe(true);
  });

  it("classifies device estimates without changing the render request", () => {
    expect(browserMotionEstimateStatus(59_999)).toBe("ready");
    expect(browserMotionEstimateStatus(60_001)).toBe("warning");
    expect(browserMotionEstimateStatus(180_001)).toBe("blocked");
  });

  it("blocks greater-than-FHD browser motion before probing a frame", () => {
    const largeScene: BuiltScene = {
      ...scene,
      vnode: createElement(
        "Canvas",
        { width: 3_840, height: 2_160 },
        createElement("Box", { width: 3_840, height: 2_160, background: "#8b7cf6" }),
      ),
    };
    const largeEngine = {
      renderToSvg: vi.fn(() => "<svg/>"),
      renderToPng: vi.fn(() => new Uint8Array([1])),
    } as unknown as Engine;

    const assessment = assessBrowserMotionExport({
      engine: largeEngine,
      scene: largeScene,
      kind: "mp4",
      scale: 1,
      motionQuality: "balanced",
      workerCount: 2,
    });

    expect(assessment).toMatchObject({ status: "blocked", reason: "resolution" });
    expect(largeEngine.renderToSvg).not.toHaveBeenCalled();
    expect(largeEngine.renderToPng).not.toHaveBeenCalled();
  });

  it("admits an authored 4K canvas when downscaled to FHD before probing", () => {
    const largeScene: BuiltScene = {
      ...scene,
      vnode: createElement(
        "Canvas",
        { width: 3_840, height: 2_160 },
        createElement("Box", { width: 3_840, height: 2_160, background: "#8b7cf6" }),
      ),
    };
    const largeEngine = {
      renderToSvg: vi.fn(() => "<svg/>"),
      renderToPng: vi.fn(() => new Uint8Array([1])),
    } as unknown as Engine;

    const assessment = assessBrowserMotionExport({
      engine: largeEngine,
      scene: largeScene,
      kind: "mp4",
      scale: 0.5,
      motionQuality: "balanced",
      workerCount: 2,
    });

    expect(assessment).toMatchObject({ width: 1_920, height: 1_080, reason: "none" });
    expect(largeEngine.renderToPng).toHaveBeenCalledWith(
      largeScene.vnode,
      expect.objectContaining({ scale: 0.5 }),
    );
  });

  it("blocks animated raster when the advertised fps would be reduced", () => {
    const longScene = { ...scene, durationMs: 20_000 };
    const largePayloadEngine = {
      renderToSvg: vi.fn(() => "x".repeat(1_000_000)),
      renderToPng: vi.fn(() => new Uint8Array([1])),
    } as unknown as Engine;

    const assessment = assessBrowserMotionExport({
      engine: largePayloadEngine,
      scene: longScene,
      kind: "animated-webp",
      scale: 1,
      motionQuality: "economy",
      workerCount: 1,
    });

    expect(assessment.status).toBe("blocked");
    expect(assessment.reason).toBe("fps");
    expect(assessment.effectiveFps).toBeLessThan(assessment.requestedFps);
    expect(largePayloadEngine.renderToPng).not.toHaveBeenCalled();
  });
});

describe("MP4 worker concurrency", () => {
  it("keeps the default bounded and makes high parallelism explicit", () => {
    expect(resolveExportWorkerConcurrency("memory", 16)).toBe(1);
    expect(resolveExportWorkerConcurrency("balanced", 16)).toBe(2);
    expect(resolveExportWorkerConcurrency("speed", 16)).toBe(4);
    expect(resolveExportWorkerConcurrency("speed", 2)).toBe(2);
  });
});
