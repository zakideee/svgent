import { readFile } from "node:fs/promises";
import {
  createEngineAsync,
  type Engine,
  type IRNode,
  inspectScene,
  type SceneInspection,
} from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  buildTimeline,
  bundledFallbackFonts,
  composerDraftTimings,
  DEFAULT_PROJECT,
  draftClusterVisibleMs,
  FONT_ALIAS,
  type SvgentProject,
  sendMomentMs,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VISIBLE = 0.01;
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

afterAll(() => {
  engine?.dispose();
});

function projectFor(
  surface: "app" | "tui",
  content: string,
  inputMode?: "voice",
  canvasWidth = 800,
): SvgentProject {
  return {
    ...DEFAULT_PROJECT,
    surface,
    appearance: {
      ...DEFAULT_PROJECT.appearance,
      canvasWidth,
      canvasHeight: 700,
    },
    camera: { ...DEFAULT_PROJECT.camera, follow: false },
    timing: { ...DEFAULT_PROJECT.timing, userTypingCps: 10 },
    messages: [
      {
        id: "draft-under-test",
        role: "user",
        content,
        ...(inputMode ? { inputMode } : {}),
      },
    ],
  };
}

function inspected(project: SvgentProject, timeMs: number): SceneInspection {
  const scene = buildSvgentScene(project, 0, { engine });
  return inspectScene(engine, scene.vnode, { skipValidation: true, timeMs });
}

type MetaPaint = {
  meta: Record<string, string>;
  opacity: number;
  x: number;
  y: number;
  height: number;
};

function metaPaint(inspection: SceneInspection, matches: Record<string, string>): MetaPaint[] {
  const found: MetaPaint[] = [];
  const bboxes = new Map(
    inspection.bboxes.map((bbox) => [`${bbox.nodeId}\u0000${bbox.type}`, bbox.visualBBox]),
  );
  const walk = (node: IRNode, inheritedOpacity: number): void => {
    const opacity = inheritedOpacity * (node.type === "group" ? (node.opacity ?? 1) : 1);
    if (
      node.type === "group" &&
      node.meta !== undefined &&
      Object.entries(matches).every(([key, value]) => node.meta?.[key] === value)
    ) {
      const bbox = bboxes.get(`${node.nodeId}\u0000${node.type}`);
      found.push({
        meta: node.meta,
        opacity,
        x: bbox?.x ?? 0,
        y: bbox?.y ?? 0,
        height: bbox?.h ?? 0,
      });
    }
    for (const child of node.type === "group" ? (node.children ?? []) : []) {
      walk(child, opacity);
    }
  };
  walk(inspection.ir.root, 1);
  return found;
}

function visibleDraftInk(inspection: SceneInspection, messageId: string): number {
  let visible = 0;
  const walk = (node: IRNode, inheritedOpacity: number, inDraft: boolean): void => {
    const opacity = inheritedOpacity * (node.type === "group" ? (node.opacity ?? 1) : 1);
    const belongs = inDraft || (node.type === "group" && node.meta?.["draft-root"] === messageId);
    if (belongs && node.type === "text" && opacity > VISIBLE) {
      const hasInk = node.lines.some((line) => line.text.trim().length > 0);
      const unitsPaint =
        node.unitAnimationSamples === undefined ||
        node.unitAnimationSamples.some((sample) => (sample.opacity ?? 1) > VISIBLE);
      if (hasInk && unitsPaint) {
        visible += 1;
      }
    }
    for (const child of node.type === "group" ? (node.children ?? []) : []) {
      walk(child, opacity, belongs);
    }
  };
  walk(inspection.ir.root, 1, false);
  return visible;
}

function walkVnode(
  node: ReturnType<typeof buildSvgentScene>["vnode"],
  visit: (node: ReturnType<typeof buildSvgentScene>["vnode"]) => void,
): void {
  visit(node);
  for (const child of node.children as readonly unknown[]) {
    if (typeof child === "object" && child !== null && "type" in child) {
      walkVnode(child as ReturnType<typeof buildSvgentScene>["vnode"], visit);
    }
  }
}

function panelBoundaryTimes(project: SvgentProject): {
  scene: ReturnType<typeof buildSvgentScene>;
  times: number[];
} {
  const scene = buildSvgentScene(project, 0, { engine });
  const times = new Set<number>();
  walkVnode(scene.vnode, (node) => {
    const props = node.props as {
      meta?: Record<string, string>;
      animate?: { durationMs: number; delayMs?: number; keyframes: Array<{ at: number }> };
    };
    if (props.meta?.["composer-panel"] === undefined || props.animate === undefined) {
      return;
    }
    for (const frame of props.animate.keyframes) {
      times.add((props.animate.delayMs ?? 0) + frame.at * props.animate.durationMs);
    }
  });
  return { scene, times: [...times].sort((left, right) => left - right) };
}

describe.each(["app", "tui"] as const)("rendered %s draft", (surface) => {
  const content = `${"plain ".repeat(30)}\n${"あ".repeat(20)}[[漢字|${"かな".repeat(14)}]]`;

  it("keeps multiline IME marks tied to the grapheme that appears", () => {
    const project = projectFor(surface, content);
    const timeline = buildTimeline(project, project.messages);
    const timing = composerDraftTimings(timeline, project)[0];
    const phase = timing?.draft?.phases.find((candidate) => candidate.composing?.settled === false);
    if (!timing?.draft || !phase?.composing) {
      throw new Error("missing composing phase");
    }
    const cluster = phase.composing.to - 1;
    const appearsMs = draftClusterVisibleMs(phase, cluster, timing.draft.charsPerSecond);

    expect(
      metaPaint(inspected(project, appearsMs - 1), {
        "draft-mark": timing.message.id,
        cluster: String(cluster),
        state: "composing",
      }).every((paint) => paint.opacity <= VISIBLE),
    ).toBe(true);
    expect(
      metaPaint(inspected(project, appearsMs + 30), {
        "draft-mark": timing.message.id,
        cluster: String(cluster),
        state: "composing",
      }).some((paint) => paint.opacity > VISIBLE),
    ).toBe(true);
    const visibleRows = metaPaint(inspected(project, appearsMs + 30), {
      "draft-line": timing.message.id,
    }).filter((paint) => paint.opacity > VISIBLE);
    expect(new Set(visibleRows.map((paint) => paint.meta["source-line"])).size).toBeGreaterThan(1);
    const visibleMarks = metaPaint(inspected(project, appearsMs + 30), {
      "draft-mark": timing.message.id,
      state: "composing",
    }).filter((paint) => paint.opacity > VISIBLE);
    expect(new Set(visibleMarks.map((paint) => Math.round(paint.y))).size).toBeGreaterThan(1);
  });

  it("switches from composing to settled marks at conversion", () => {
    const project = projectFor(surface, content);
    const timing = composerDraftTimings(buildTimeline(project, project.messages), project)[0];
    const settled = timing?.draft?.phases.find(
      (candidate) => candidate.composing?.settled === true,
    );
    if (!timing?.draft || !settled?.composing) {
      throw new Error("missing settled phase");
    }
    const atMs = settled.showMs + 30;

    expect(
      metaPaint(inspected(project, atMs), {
        "draft-mark": timing.message.id,
        state: "composing",
      }).every((paint) => paint.opacity <= VISIBLE),
    ).toBe(true);
    expect(
      metaPaint(inspected(project, atMs), {
        "draft-mark": timing.message.id,
        state: "settled",
      }).some((paint) => paint.opacity > VISIBLE),
    ).toBe(true);
  });

  it("shrinks the visible panel when a long reading converts to a short value", () => {
    const project = projectFor(surface, `[[漢|${"かな".repeat(12)}]]`, undefined, 420);
    const timing = composerDraftTimings(buildTimeline(project, project.messages), project)[0];
    const settled = timing?.draft?.phases.find(
      (candidate) => candidate.composing?.settled === true,
    );
    if (!settled) {
      throw new Error("missing settled phase");
    }
    const panelHeightAt = (atMs: number): number =>
      Math.max(
        0,
        ...metaPaint(inspected(project, atMs), {})
          .filter((paint) => paint.meta["composer-panel"] !== undefined && paint.opacity > VISIBLE)
          .map((paint) => paint.height),
      );

    expect(panelHeightAt(settled.showMs - 1)).toBeGreaterThan(panelHeightAt(settled.showMs + 1));
  });

  it("still paints the finished draft one millisecond before send", () => {
    const project = projectFor(surface, content);
    const timing = composerDraftTimings(buildTimeline(project, project.messages), project)[0];
    if (!timing) {
      throw new Error("missing composer timing");
    }

    expect(
      visibleDraftInk(inspected(project, sendMomentMs(timing) - 1), timing.message.id),
    ).toBeGreaterThan(0);
  });

  it("never paints two translucent draft panels at a boundary", () => {
    const project = projectFor(surface, content);
    const { scene, times } = panelBoundaryTimes(project);
    expect(times.length).toBeGreaterThan(2);
    for (const boundary of times) {
      for (const timeMs of [boundary - 1, boundary, boundary + 1]) {
        const clamped = Math.max(0, Math.min(scene.durationMs, timeMs));
        const frame = inspectScene(engine, scene.vnode, {
          skipValidation: true,
          timeMs: clamped,
        });
        const visiblePanels = metaPaint(frame, {}).filter(
          (paint) => paint.meta["composer-panel"] !== undefined && paint.opacity > VISIBLE,
        ).length;
        expect(visiblePanels, `at ${clamped}ms`).toBeLessThanOrEqual(1);
      }
    }
  }, 15_000);
});

describe("voice input surfaces", () => {
  const content = "voice transcript ".repeat(40);

  it("lets the TUI grow and keep the newest rows visible", () => {
    const project = projectFor("tui", content, "voice");
    const timing = composerDraftTimings(buildTimeline(project, project.messages), project)[0];
    if (!timing?.draft) {
      throw new Error("missing TUI voice timing");
    }
    const frame = inspected(project, timing.draft.typingEndMs + 10);
    const grownPanels = metaPaint(frame, {}).filter(
      (paint) =>
        paint.meta["composer-panel"] !== undefined &&
        paint.meta["composer-panel"] !== "base" &&
        paint.opacity > VISIBLE,
    );
    const visibleRows = metaPaint(frame, { "draft-line": timing.message.id }).filter(
      (paint) => paint.opacity > VISIBLE,
    );

    expect(grownPanels.length).toBe(1);
    expect(visibleRows.length).toBe(4);
    expect(visibleDraftInk(frame, timing.message.id)).toBeGreaterThan(0);
  });

  it("keeps App voice input on its waveform surface", () => {
    const project = projectFor("app", content, "voice");
    const scene = buildSvgentScene(project, 0, { engine });
    let grownPanels = 0;
    walkVnode(scene.vnode, (node) => {
      const panel = (node.props as { meta?: Record<string, string> }).meta?.["composer-panel"];
      if (panel !== undefined && panel !== "base") {
        grownPanels += 1;
      }
    });

    expect(grownPanels).toBe(0);
  });
});

describe("TUI composition underline", () => {
  it("draws one full-height wave per terminal cell", () => {
    const scene = buildSvgentScene(projectFor("tui", "[[波線|なみせん]]"), 0, { engine });
    const paths: string[] = [];
    walkVnode(scene.vnode, (node) => {
      const props = node.props as {
        d?: string;
        meta?: Record<string, string>;
      };
      if (props.meta?.state === "composing" && props.d !== undefined) {
        paths.push(props.d);
      }
    });

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.match(/\bQ/g)?.length, path).toBe(2);
      const firstControl = path.match(/^M0 (-?[\d.]+) Q[\d.]+ (-?[\d.]+)/);
      if (!firstControl?.[1] || !firstControl[2]) {
        throw new Error(`unexpected composition wave: ${path}`);
      }
      // A quadratic Bezier reaches half the control-point offset, so 2.5px
      // here produces the intended 1.25px visible crest.
      expect(Number(firstControl[1]) - Number(firstControl[2])).toBeCloseTo(2.5, 3);
    }
  });
});

describe("draft scene transport", () => {
  it("survives worker-style cloning and is independent of measurement order", () => {
    const project = projectFor(
      "tui",
      `${"Fix TOPIC. While there, check DETAIL too. ".repeat(8)}[[確認|かくにん]]`,
    );
    const first = buildSvgentScene(project, 0, { engine });
    const cloned = structuredClone(first.vnode);
    const firstSvg = engine.renderToAnimatedSvg(cloned, {
      playback: { mode: "independent" },
      resourceIdPrefix: "draft-determinism",
    });

    // Exercise different geometry and a different font between the two builds;
    // neither WeakMap cache order nor the preceding probe may alter the scene.
    buildSvgentScene(projectFor("app", "unrelated proportional measurement"), 0, { engine });
    const second = buildSvgentScene(project, 0, { engine });
    const secondSvg = engine.renderToAnimatedSvg(second.vnode, {
      playback: { mode: "independent" },
      resourceIdPrefix: "draft-determinism",
    });

    expect(secondSvg).toBe(firstSvg);
  });
});
