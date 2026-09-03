import type { MessageTiming, SessionMessage } from "@svgent/scene";
import {
  appMessageBand,
  DEFAULT_PROJECT,
  metricsFor,
  paletteFor,
  planCameraTrack,
  type SceneEnv,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

function timing(
  role: SessionMessage["role"],
  startMs: number,
  revealEndMs: number,
  index: number,
): MessageTiming {
  return {
    message: { id: `m-${index}`, role, content: "x" },
    startMs,
    revealEndMs,
    settledMs: revealEndMs,
  };
}

/** Bands are laid out at the default font scale, like the shipped default. */
const METRICS = metricsFor(DEFAULT_PROJECT);
/** No engine: bands fall back to the ratio estimate, which is deterministic. */
const ENV: SceneEnv = {
  project: DEFAULT_PROJECT,
  product: { name: "svgent-test", version: "1.0.0" },
  palette: paletteFor(DEFAULT_PROJECT),
  metrics: METRICS,
  engine: undefined,
};

// A narrow row on a wide canvas leaves the fit room to reach the zoom cap.
/** The real per-role bands, at the test row width. */
function bands(
  timings: MessageTiming[],
  rowWidth = 900,
): Array<{ offsetX: number; width: number }> {
  return timings.map((entry) =>
    appMessageBand({
      message: entry.message,
      rowWidth,
      env: ENV,
      align: DEFAULT_PROJECT.appearance.messageAlign,
    }),
  );
}

const BASE = {
  gap: 14,
  contentTop: 400,
  rowLeft: 500,
  leadingHeight: 0,
  typingTargets: [],
  extraShots: [],
  contentWidths: [],
  canvasWidth: 1920,
  canvasHeight: 1080,
  durationMs: 12_000,
  zoom: 1.6,
  style: "sync" as const,
};

describe("planCameraTrack", () => {
  it("opens on the full view, frames subjects at their own width, and pulls back out", () => {
    const track = planCameraTrack({
      ...BASE,
      timings: [
        timing("user", 0, 1_500, 0),
        timing("assistant", 3_400, 6_000, 1),
        timing("user", 8_000, 9_200, 2),
      ],
      messageBands: bands([
        timing("user", 0, 1_500, 0),
        timing("assistant", 3_400, 6_000, 1),
        timing("user", 8_000, 9_200, 2),
      ]),
      heights: [80, 500, 80],
      scrollMoves: [{ startMs: 8_000, toY: 400 }],
    });
    expect(track).not.toBeNull();
    const frames = track?.keyframes ?? [];
    expect(frames[0]).toMatchObject({ at: 0, transform: { scaleX: 1, translateY: 0 } });
    expect(frames[frames.length - 1]).toMatchObject({ at: 1, transform: { scaleX: 1 } });
    for (let index = 1; index < frames.length; index += 1) {
      expect((frames[index]?.at ?? 0) > (frames[index - 1]?.at ?? 0)).toBe(true);
    }
    // Shots engage, and a right-hung user bubble aims the camera left of
    // its own center: translateX = k(Cx − cx) < 0 for cx > Cx.
    const zoomed = frames.filter((frame) => (frame.transform?.scaleX ?? 1) > 1);
    expect(zoomed.length).toBeGreaterThan(0);
    expect(zoomed.some((frame) => (frame.transform?.translateX ?? 0) < 0)).toBe(true);
  });

  it("fits the zoom to the subject instead of applying the cap blindly", () => {
    const wideTimings = [timing("assistant", 2_000, 4_000, 0)];
    const wide = planCameraTrack({
      ...BASE,
      rowLeft: 60,
      // An assistant card nearly as wide as the canvas: the fit must land
      // well under the 1.6 cap.
      timings: wideTimings,
      messageBands: bands(wideTimings, 1_800),
      heights: [300],
      scrollMoves: [],
    });
    const kOf = (track: typeof wide): number =>
      Math.max(...(track?.keyframes ?? []).map((frame) => frame.transform?.scaleX ?? 1));
    expect(kOf(wide)).toBeLessThan(1.2);
    const narrow = planCameraTrack({
      ...BASE,
      timings: [timing("thinking", 2_000, 4_000, 0)],
      messageBands: bands([timing("thinking", 2_000, 4_000, 0)]),
      heights: [60],
      scrollMoves: [],
    });
    expect(kOf(narrow)).toBeCloseTo(BASE.zoom, 5);
  });

  it("aims at the post-scroll position of a late message", () => {
    const early = planCameraTrack({
      ...BASE,
      timings: [timing("assistant", 2_000, 4_000, 0)],
      messageBands: bands([timing("assistant", 2_000, 4_000, 0)]),
      heights: [500],
      scrollMoves: [],
    });
    const scrolled = planCameraTrack({
      ...BASE,
      timings: [timing("assistant", 2_000, 4_000, 0)],
      messageBands: bands([timing("assistant", 2_000, 4_000, 0)]),
      heights: [500],
      scrollMoves: [{ startMs: 2_000, toY: 200 }],
    });
    const aimOf = (track: typeof early): number => {
      const frame = (track?.keyframes ?? []).find((entry) => (entry.transform?.scaleX ?? 1) > 1);
      return frame?.transform?.translateY ?? Number.NaN;
    };
    const kOf = (track: typeof early): number =>
      (track?.keyframes ?? []).find((entry) => (entry.transform?.scaleX ?? 1) > 1)?.transform
        ?.scaleX ?? Number.NaN;
    // Scrolling the content up by 200 moves the target up, so the camera
    // translates down by k × 200 relative to the unscrolled aim.
    expect(aimOf(scrolled) - aimOf(early)).toBeCloseTo(kOf(early) * 200, 5);
  });

  it("watches the typed draft before framing the landed user bubble", () => {
    const track = planCameraTrack({
      ...BASE,
      timings: [timing("user", 500, 4_000, 0)],
      messageBands: bands([timing("user", 500, 4_000, 0)]),
      heights: [80],
      typingTargets: [{ startMs: 500, target: { x: 200, y: 900, width: 500, height: 120 } }],
      scrollMoves: [],
    });
    const zoomedFrames = (track?.keyframes ?? []).filter(
      (frame) => (frame.transform?.scaleX ?? 1) > 1,
    );
    const aims = [...new Set(zoomedFrames.map((frame) => frame.transform?.translateY))];
    // Two distinct aims: composer first (low on the canvas → camera
    // translates up, negative is not guaranteed by clamp, so just count).
    expect(aims.length).toBe(2);
  });

  it("frames the ink, not the box, and keeps one zoom per kind", () => {
    // Two tool rows in one script, one short and one long: the wider ink
    // sets the shared zoom, so identical events lean in identically.
    const track = planCameraTrack({
      ...BASE,
      timings: [timing("tool", 1_000, 1_600, 0), timing("tool", 4_000, 4_600, 1)],
      messageBands: bands([timing("tool", 1_000, 1_600, 0), timing("tool", 4_000, 4_600, 1)]),
      heights: [40, 40],
      contentWidths: [200, 700],
      scrollMoves: [{ startMs: 4_000, toY: 300 }],
    });
    const zoomFrames = (track?.keyframes ?? []).filter(
      (frame) => (frame.transform?.scaleX ?? 1) > 1,
    );
    const scales = new Set(zoomFrames.map((frame) => frame.transform?.scaleX));
    expect(scales.size).toBe(1);
    // …and that zoom is the wide row's fit, tighter than the band's own.
    const shared = [...scales][0] as number;
    expect(shared).toBeCloseTo(Math.min(BASE.zoom, 1920 / (700 + 112)), 5);
  });

  it("interleaves in-message close-ups in time order", () => {
    const track = planCameraTrack({
      ...BASE,
      timings: [timing("choice", 1_000, 1_400, 0)],
      messageBands: bands([timing("choice", 1_000, 1_400, 0)]),
      heights: [400],
      extraShots: [
        { anchorMs: 3_000, target: { x: 520, y: 600, width: 400, height: 150 }, kind: "x" },
      ],
      scrollMoves: [],
    });
    const zoomFrames = (track?.keyframes ?? []).filter(
      (frame) => (frame.transform?.scaleX ?? 1) > 1,
    );
    const aims = [...new Set(zoomFrames.map((frame) => frame.transform?.translateY))];
    // The card shot first, then the options close-up.
    expect(aims.length).toBe(2);
  });

  it("merges shots that would only make the camera twitch", () => {
    const track = planCameraTrack({
      ...BASE,
      timings: [timing("thinking", 1_200, 1_600, 0), timing("tool", 1_500, 2_100, 1)],
      messageBands: bands([timing("thinking", 1_200, 1_600, 0), timing("tool", 1_500, 2_100, 1)]),
      heights: [40, 40],
      scrollMoves: [],
    });
    const zoomFrames = (track?.keyframes ?? []).filter(
      (frame) => (frame.transform?.scaleX ?? 1) > 1,
    );
    const distinctAims = new Set(zoomFrames.map((frame) => frame.transform?.translateY));
    expect(distinctAims.size).toBe(1);
  });

  it("lands before, with, or after its event by style", () => {
    const shotTimings = [timing("thinking", 3_000, 3_400, 0)];
    const trackFor = (style: "anticipate" | "sync" | "trail") =>
      planCameraTrack({
        ...BASE,
        style,
        timings: shotTimings,
        messageBands: bands(shotTimings),
        heights: [60],
        scrollMoves: [],
      });
    const landAtMs = (track: ReturnType<typeof trackFor>): number => {
      const frame = (track?.keyframes ?? []).find((entry) => (entry.transform?.scaleX ?? 1) > 1);
      return (frame?.at ?? 0) * BASE.durationMs;
    };
    // Anticipate lands on the anchor; sync lands one glide after it;
    // trail starts late on purpose and lands later still.
    expect(landAtMs(trackFor("anticipate"))).toBeCloseTo(3_000, 0);
    expect(landAtMs(trackFor("sync"))).toBeGreaterThan(3_000);
    expect(landAtMs(trackFor("trail"))).toBeGreaterThan(landAtMs(trackFor("sync")));
  });

  it("returns null when the camera would never engage", () => {
    expect(
      planCameraTrack({
        ...BASE,
        zoom: 1,
        timings: [timing("user", 0, 900, 0)],
        messageBands: bands([timing("user", 0, 900, 0)]),
        heights: [60],
        scrollMoves: [],
      }),
    ).toBeNull();
    expect(
      planCameraTrack({
        ...BASE,
        timings: [],
        messageBands: bands([]),
        heights: [],
        scrollMoves: [],
      }),
    ).toBeNull();
  });
});

describe("horizontal message placement", () => {
  const band = (role: "user" | "assistant", align: "role" | "center", content = "x".repeat(400)) =>
    appMessageBand({
      message: { id: "m", role, content },
      rowWidth: 900,
      env: ENV,
      align,
    });

  it("sizes the user bubble to its content, capped by the maximum", () => {
    const tiny = band("user", "role", "うん");
    const long = band("user", "role", "x".repeat(400));
    // The ratio is a maximum, not the width: a two-character message must not
    // get the same box as a paragraph.
    expect(tiny.width).toBeLessThan(long.width / 2);
    // Both stay flush to the same right edge, which is what reads as "mine".
    expect(tiny.offsetX + tiny.width).toBe(long.offsetX + long.width);
    // The agent card is not content-sized; it runs the row.
    const agentTiny = band("assistant", "role", "うん");
    const agentLong = band("assistant", "role", "x".repeat(400));
    expect(agentTiny.width).toBe(agentLong.width);
  });

  it("hangs the user bubble right and runs the agent from the left by default", () => {
    const user = band("user", "role");
    const agent = band("assistant", "role");
    // The agent starts at the row's edge and the user hangs off the far side…
    expect(agent.offsetX).toBeLessThan(user.offsetX);
    // …but they finish together. The two are told apart by width, not by a
    // trailing gap on one of them.
    expect(user.offsetX + user.width).toBe(agent.offsetX + agent.width);
  });

  it("centres a card in its row when asked, leaving equal margins", () => {
    for (const role of ["user", "assistant"] as const) {
      const { offsetX, width } = band(role, "center");
      const left = offsetX;
      const right = 900 - (offsetX + width);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
    }
  });
});
