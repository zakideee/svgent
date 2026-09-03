import { readFile } from "node:fs/promises";
import type { AnyVNode } from "@boundsvg/core";
import { createEngineAsync, type Engine } from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPOSER_MAX_EXTRA_LINES, planDraftTyping, sendMomentMs } from "../src/composer.js";
import {
  DRAFT_FONT_FEATURES,
  type DraftWrapOptions,
  planDraftLayoutSequence,
  planDraftText,
  visibleDraftPrefixLength,
} from "../src/draft-layout.js";
import { resolveDraftTyping } from "../src/draft-typing.js";
import {
  MONO_FALLBACK,
  MONO_FONT,
  metricsFor,
  paletteFor,
  SANS_FALLBACK,
  SANS_FONT,
  type SceneEnv,
} from "../src/env.js";
import { draftGraphemes } from "../src/graphemes.js";
import { measureLineWidthPx } from "../src/measure.js";
import {
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  FONT_ALIAS,
  type SessionMessage,
  type SvgentProject,
} from "../src/model.js";
import { buildSvgentScene } from "../src/scene.js";
import { buildTimeline, composerDraftTimings } from "../src/timeline.js";
import { planTuiDraftGrowth } from "../src/tui-composer.js";

type ShoveFrame = { at: number; transform?: { translateY?: number } };
type ShoveTrack = { keyframes?: ShoveFrame[]; durationMs?: number; delayMs?: number };

function isVNode(value: unknown): value is AnyVNode {
  return typeof value === "object" && value !== null && "type" in value;
}

function directStandoffReleases(node: AnyVNode): number[] {
  const props = node.props as { animate?: ShoveTrack; meta?: Record<string, string> };
  if (props.meta?.["composer-standoff"] !== "transcript") {
    return [];
  }
  const track = props.animate;
  const frames = track?.keyframes ?? [];
  if (!frames.some((frame) => (frame.transform?.translateY ?? 0) !== 0)) {
    return [];
  }
  return frames.flatMap((frame, index) => {
    const previous = frames[index - 1];
    const releases =
      previous !== undefined &&
      (previous.transform?.translateY ?? 0) !== 0 &&
      (frame.transform?.translateY ?? 0) === 0;
    return releases
      ? [Math.round(frame.at * (track?.durationMs ?? 0) + (track?.delayMs ?? 0))]
      : [];
  });
}

/** Every instant a stand-off track hands the rows back, in whole ms. */
function standoffReleases(root: AnyVNode): number[] {
  return [
    ...directStandoffReleases(root),
    ...(root.children as readonly unknown[])
      .filter(isVNode)
      .flatMap((child) => standoffReleases(child)),
  ];
}

const CHARS_PER_SECOND = 10;
const PROMPT_FONT_PX = 20;
const PROMPT_LINE_PX = 31;

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

function draftPlan(content: string, draftWidth: number) {
  const message = { id: "draft", role: "user" as const, content };
  const project: SvgentProject = {
    ...DEFAULT_PROJECT,
    surface: "tui",
    timing: { ...DEFAULT_PROJECT.timing, userTypingCps: CHARS_PER_SECOND },
    messages: [message],
  };
  const timeline = buildTimeline(project, project.messages);
  const timing = composerDraftTimings(timeline, project)[0];
  if (!timing) {
    throw new Error("test draft did not produce a composer timing");
  }
  const env: SceneEnv = {
    project,
    product: { name: "svgent-test", version: "1.0.0" },
    palette: paletteFor(project),
    metrics: metricsFor(project),
    engine,
  };
  const plan = planTuiDraftGrowth({
    env,
    userTimings: [timing],
    draftWidth,
    promptFontPx: PROMPT_FONT_PX,
    promptLinePx: PROMPT_LINE_PX,
  }).get(message.id);
  if (!plan) {
    throw new Error("test draft did not produce a TUI growth plan");
  }
  return { plan, timing };
}

function renderedLineCount(text: string, widthPx: number): number {
  return engine.measureTextBlock({
    text,
    fontFamily: MONO_FONT,
    fallback: MONO_FALLBACK,
    fontSizePx: PROMPT_FONT_PX,
    wrap: "char",
    whiteSpace: "pre-wrap",
    maxWidth: widthPx,
  }).lineCount;
}

describe("TUI draft growth", () => {
  it("grows when the typed prefix actually wraps, not when its IME phase opens", () => {
    const widthPx = 600;
    const content = `${"plain ".repeat(30)}[[漢字|かな]]`;
    const { plan, timing } = draftPlan(content, widthPx);
    const phase = planDraftTyping({
      content,
      startMs: timing.startMs,
      charsPerSecond: CHARS_PER_SECOND,
    })[0];
    if (!phase) {
      throw new Error("test content did not produce an IME phase");
    }

    const clusters = draftGraphemes(phase.text);
    const visibleAtOpen = visibleDraftPrefixLength(phase, CHARS_PER_SECOND, phase.showMs);
    let previousCount = renderedLineCount(clusters.slice(0, visibleAtOpen).join(""), widthPx);
    let expectedWrapMs: number | undefined;
    for (let length = visibleAtOpen + 1; length <= clusters.length; length += 1) {
      const count = renderedLineCount(clusters.slice(0, length).join(""), widthPx);
      if (count > previousCount) {
        const typedFrom = phase.typed?.from ?? 0;
        const typedStartMs = phase.typed?.startMs ?? phase.showMs;
        expectedWrapMs = typedStartMs + ((length - typedFrom - 1) / CHARS_PER_SECOND) * 1_000;
        break;
      }
      previousCount = count;
    }

    expect(expectedWrapMs).toBeDefined();
    expect(plan.steps[0]).toEqual({ atMs: expectedWrapMs, extraLines: 1 });
    expect(plan.steps[0]?.atMs ?? 0).toBeGreaterThan(phase.showMs + 1_000);
  });

  it("shrinks at conversion when a long reading becomes a short written form", () => {
    const content = "[[漢|かなかなかなかな]]";
    const { plan, timing } = draftPlan(content, 100);
    const phases = planDraftTyping({
      content,
      startMs: timing.startMs,
      charsPerSecond: CHARS_PER_SECOND,
    });

    // The width changes on the conversion key, not on the commit that follows
    // it: the written form is what the composer has to fit.
    const converted = phases?.find((phase) => phase.text === "漢");

    expect(plan.maxExtraLines).toBe(1);
    expect(plan.steps.map((step) => step.extraLines)).toEqual([1, 0]);
    expect(converted?.composing?.settled).toBe(true);
    expect(plan.steps.at(-1)?.atMs).toBe(converted?.showMs);
  });

  it("reflows at Tab acceptance when completion inserts a longer settled value", () => {
    const content = "aa {{abcdefghij|a}}";
    const widthPx = 100;
    const { plan, timing } = draftPlan(content, widthPx);
    const phases = planDraftTyping({
      content,
      startMs: timing.startMs,
      charsPerSecond: CHARS_PER_SECOND,
    });
    const settled = phases?.at(-1);
    if (!settled) {
      throw new Error("test content did not produce a completion settlement phase");
    }

    expect(plan.steps).toEqual([
      {
        atMs: settled.showMs,
        extraLines: renderedLineCount(settled.text, widthPx) - 1,
      },
    ]);
  });

  it("keeps only the newest terminal rows once the draft exceeds the height cap", () => {
    const content = `${"plain ".repeat(100)}[[漢字|かな]]`;
    const { plan } = draftPlan(content, 600);
    const snapshots = plan.snapshots;
    const scrolled = snapshots.find(
      (snapshot) =>
        snapshot.lines.length === COMPOSER_MAX_EXTRA_LINES + 1 &&
        (snapshot.lines[0]?.sourceLine ?? 0) > 0,
    );

    expect(plan.maxExtraLines).toBe(COMPOSER_MAX_EXTRA_LINES);
    expect(scrolled).toBeDefined();
    for (const snapshot of snapshots) {
      expect(snapshot.lines.length).toBeLessThanOrEqual(COMPOSER_MAX_EXTRA_LINES + 1);
      for (const line of snapshot.lines) {
        expect(line.slot).toBeGreaterThanOrEqual(0);
        expect(line.slot).toBeLessThanOrEqual(COMPOSER_MAX_EXTRA_LINES);
      }
    }
    expect(scrolled?.lines.map((line) => line.slot)).toEqual([0, 1, 2, 3]);
  });

  it("moves an IME underline onto the wrapped row at the exact line boundary", () => {
    const { plan } = draftPlan("a[[漢字|かなかな]]", 60);
    const beforeWrap = plan.snapshots.find(
      (snapshot) => snapshot.lines.length === 1 && snapshot.underlines.length > 0,
    );
    const wrapped = plan.snapshots.find(
      (snapshot) =>
        snapshot.lines.length === 2 &&
        new Set(snapshot.underlines.map((underline) => underline.slot)).size === 2,
    );
    const firstLine = wrapped?.lines[0];
    const secondLine = wrapped?.lines[1];
    if (!wrapped || !firstLine || !secondLine) {
      throw new Error("test draft did not wrap its IME composition across two rows");
    }

    expect(beforeWrap?.lines.map((line) => line.slot)).toEqual([1]);
    expect(beforeWrap?.underlines.every((underline) => underline.slot === 1)).toBe(true);
    expect(beforeWrap?.hideMs).toBe(wrapped.showMs);
    const firstOnSecondLine = wrapped.underlines.find(
      (underline) => underline.cluster === secondLine.sourceStart,
    );
    const lastOnFirstLine = wrapped.underlines.find(
      (underline) => underline.cluster === secondLine.sourceStart - 1,
    );
    expect(firstOnSecondLine).toMatchObject({ slot: secondLine.slot, leftPx: 0 });
    expect(lastOnFirstLine?.slot).toBe(firstLine.slot);
    expect((lastOnFirstLine?.leftPx ?? 0) + (lastOnFirstLine?.widthPx ?? 0)).toBeLessThanOrEqual(
      60,
    );
  });
});

/**
 * A freeform answer is typed on a synthetic user timing whose send moment is
 * not the choice's own. Taking the stand-off's release from the choice left
 * the rows shoved after the grown box had already gone.
 */
describe("freeform stand-off", () => {
  const answer =
    "{{標準|標}} でいいけど、{{--dry-run|--dry}} を先に。あと [[確認|かくにん]]したいことがあるので、" +
    "[[結果|けっか]]を[[画面|がめん]]に[[出して|だして]]ください。".repeat(4);
  const messages: SessionMessage[] = [
    { id: "u0", role: "user", content: "0 番目の依頼です" },
    { id: "a0", role: "assistant", content: "0 番目、やっておきました" },
    {
      id: "choice",
      role: "choice",
      content: "どこまでやりますか",
      options: ["安全", "標準", "積極的"],
      chosenIndex: 1,
      freeform: answer,
    },
  ];
  const project: SvgentProject = {
    ...DEFAULT_PROJECT,
    surface: "tui",
    messages,
    appearance: { ...DEFAULT_PROJECT.appearance, canvasHeight: 420, windowPaddingY: 0 },
  };

  it("gives the rows back when the grown box goes, not when the choice ends", () => {
    const timeline = buildTimeline(project, messages);
    const choice = timeline.messages.find((timing) => timing.message.id === "choice");
    const draft = composerDraftTimings(timeline, project).find(
      (timing) => timing.message.id === "choice",
    );
    if (choice === undefined || draft === undefined) {
      throw new Error("the script did not produce a freeform draft");
    }
    // The two send moments really are different, or the test proves nothing.
    expect(sendMomentMs(choice)).toBeGreaterThan(sendMomentMs(draft) + 1);

    const releases = standoffReleases(buildSvgentScene(project, 0).vnode);
    expect(releases, "no stand-off in this script").not.toEqual([]);
    expect(releases).toContain(Math.round(sendMomentMs(draft)));
    expect(releases).not.toContain(Math.round(sendMomentMs(choice)));
  });
});

describe("shared draft layout", () => {
  const wrap = (measuringEngine: Engine, widthPx = 120) => ({
    widthPx,
    fontPx: PROMPT_FONT_PX,
    lineHeightPx: PROMPT_LINE_PX,
    font: MONO_FONT,
    fallback: MONO_FALLBACK,
    fallbackRatio: 0.6,
    engine: measuringEngine,
  });

  const expectExactPrefixTransitions = (content: string, options: DraftWrapOptions): void => {
    const draft = resolveDraftTyping({
      content,
      startMs: 200,
      authoredCps: CHARS_PER_SECOND,
    });
    const sequence = planDraftLayoutSequence({ draft, wrap: options });
    const clusters = draftGraphemes(draft.phases[0]?.text ?? "");
    const expected: Array<{ atMs: number; lineCount: number }> = [];
    let previous = -1;
    for (let length = 1; length <= clusters.length; length += 1) {
      const lineCount = planDraftText(clusters.slice(0, length).join(""), options).lines.length;
      if (lineCount === previous) {
        continue;
      }
      expected.push({
        atMs: draft.startMs + ((length - 1) / draft.charsPerSecond) * 1_000,
        lineCount,
      });
      previous = lineCount;
    }
    expect(sequence.lineStates).toEqual(expected);
  };

  it("matches an exhaustive engine oracle at every prefix transition", () => {
    expectExactPrefixTransitions("Fix TOPIC. check DETAIL.\n\n終わりまで確認", wrap(engine));
  });

  it.each([
    ["Japanese kinsoku", "これは、折り返し（確認）を末尾まで試す。"],
    ["hard newlines", "first line\n\nsecond line\n"],
    ["graphemes", "ab👩‍💻 é café xyz"],
  ])("matches the engine for %s", (_label, content) => {
    expectExactPrefixTransitions(content, wrap(engine, 96));
  });

  it("matches proportional App-font reflow", () => {
    expectExactPrefixTransitions("Fix TOPIC. While there, check DETAIL too.", {
      widthPx: 130,
      fontPx: PROMPT_FONT_PX,
      lineHeightPx: PROMPT_LINE_PX,
      font: SANS_FONT,
      fallback: SANS_FALLBACK,
      fallbackRatio: 0.62,
      engine,
    });
  });

  it("measures a 2,389-cluster phase in logarithmic batched rounds", () => {
    let layoutCalls = 0;
    const countedEngine = new Proxy(engine, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        const method = value as (...args: unknown[]) => unknown;
        if (property === "renderToLayoutTree") {
          return (...args: unknown[]) => {
            layoutCalls += 1;
            return method.apply(target, args);
          };
        }
        return method.bind(target);
      },
    });
    const draft = resolveDraftTyping({
      content: "x".repeat(2_389),
      startMs: 0,
      authoredCps: CHARS_PER_SECOND,
    });
    const sequence = planDraftLayoutSequence({ draft, wrap: wrap(countedEngine, 600) });

    expect(sequence.maxLineCount).toBeGreaterThan(10);
    expect(layoutCalls).toBeLessThanOrEqual(3);
  });

  it("uses the same shaping features for measurement and painted rows", () => {
    expect(DRAFT_FONT_FEATURES).toContain('"kern" 0');
  });

  it("keeps engine-free CJK underline advances aligned with fallback wrapping", () => {
    expect(
      measureLineWidthPx(undefined, {
        text: "aか👩‍💻é",
        font: MONO_FONT,
        fallback: MONO_FALLBACK,
        fontSizePx: 20,
        fallbackRatio: 0.6,
      }),
    ).toBe(64);
  });
});
