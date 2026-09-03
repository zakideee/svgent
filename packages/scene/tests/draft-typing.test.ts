import {
  analyzeDraftTyping,
  buildTimeline,
  COMPLETION_ACCEPT_MS,
  createImeSpan,
  DEFAULT_PROJECT,
  DRAFT_FINAL_REVEAL_MS,
  draftGraphemeCount,
  draftTimelineIssues,
  IME_COMMIT_MS,
  IME_CONVERSION_MS,
  MAX_DRAFT_RUN_CLUSTERS,
  normalizeDraftSource,
  resolveDraftTyping,
  type SvgentProject,
  sendMomentMs,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

describe("the shared draft clock", () => {
  it("charges every run conversion and commit before the send", () => {
    const sentence = "〇〇を[[修正|しゅうせい]]して。△△も[[見て|みて]]おいて。";
    const message = { id: "long-ime", role: "user" as const, content: sentence.repeat(9) };
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      timing: { ...DEFAULT_PROJECT.timing, userTypingCps: 10 },
      messages: [message],
    };
    const timing = buildTimeline(project, project.messages).messages[0];
    const draft = timing?.draft;
    if (!timing || !draft) {
      throw new Error("missing draft timing");
    }

    expect(draft.program.imeRunCount).toBe(18);
    expect(draft.program.fixedPauseMs).toBe(
      draft.program.imeRunCount * (IME_CONVERSION_MS + IME_COMMIT_MS),
    );
    expect(draft.typingEndMs - draft.startMs).toBeCloseTo(
      (draft.program.typedClusterCount / draft.charsPerSecond) * 1_000 + draft.program.fixedPauseMs,
      6,
    );
    expect(draft.phases.at(-1)?.showMs).toBeLessThanOrEqual(sendMomentMs(timing));
    expect(draft.typingEndMs + DRAFT_FINAL_REVEAL_MS).toBeLessThanOrEqual(draft.revealEndMs);
  });

  it("groups adjacent spans but treats keyboard spaces as run boundaries", () => {
    expect(analyzeDraftTyping("[[今日|きょう]][[天気|てんき]]").imeRunCount).toBe(1);
    expect(analyzeDraftTyping("[[今日|きょう]] [[天気|てんき]]").imeRunCount).toBe(2);
    expect(analyzeDraftTyping("[[今日|きょう]]　[[天気|てんき]]").imeRunCount).toBe(2);
    expect(analyzeDraftTyping("[[今日|きょう]] ABC [[天気|てんき]]").imeRunCount).toBe(2);
  });

  it("charges completion acceptance from the same parsed program", () => {
    const program = analyzeDraftTyping("{{@src/config.ts|@src/co}} {{--dry-run|--dry}}");
    expect(program.completionCount).toBe(2);
    expect(program.fixedPauseMs).toBe(program.completionCount * COMPLETION_ACCEPT_MS);
  });

  it("derives a message-local cps for a feasible explicit duration", () => {
    const resolved = resolveDraftTyping({
      content: "x".repeat(50),
      startMs: 300,
      authoredCps: 10,
      durationMs: 1_000,
    });

    expect(resolved.mode).toBe("typed");
    expect(resolved.activeDurationMs).toBe(1_000);
    expect(resolved.charsPerSecond).toBeGreaterThan(resolved.authoredCps);
    expect(resolved.durationClamped).toBe(false);
    expect(resolved.issues).toEqual([]);
  });

  it("reports and clamps an explicit duration shorter than fixed IME beats", () => {
    const message = {
      id: "short",
      role: "user" as const,
      content: "[[漢字|かんじ]]",
      timing: { durationMs: 200 },
    };
    const project: SvgentProject = { ...DEFAULT_PROJECT, messages: [message] };
    const timing = buildTimeline(project, project.messages).messages[0];
    if (!timing?.draft) {
      throw new Error("missing draft timing");
    }

    expect(timing.draft.durationClamped).toBe(true);
    expect(timing.draft.activeDurationMs).toBeGreaterThan(200);
    expect(timing.draft.issues.map((issue) => issue.code)).toContain("duration-too-short");
    expect(draftTimelineIssues(project).map((issue) => issue.code)).toContain("duration-too-short");
  });

  it("never clips a long timeline while leaving later phases scheduled", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      timing: { ...DEFAULT_PROJECT.timing, userTypingCps: 1 },
      messages: [{ id: "long", role: "user", content: "x".repeat(2_389) }],
    };
    const timeline = buildTimeline(project, project.messages);

    expect(timeline.durationMs).toBeGreaterThan(120_000);
    expect(timeline.messages[0]?.draft?.revealEndMs).toBeLessThan(timeline.durationMs);
    expect(draftTimelineIssues(project).map((issue) => issue.code)).toContain("project-too-long");
  });
});

describe("draft text units and authoring bounds", () => {
  it("preserves leading, trailing, and consecutive hard newlines", () => {
    expect(normalizeDraftSource("\n  one  \n\n\t two \t\n")).toBe("\none\n\ntwo\n");
    expect(analyzeDraftTyping("\n[[漢字|かんじ]]\n").finalText).toBe("\n漢字\n");
  });

  it("preserves fullwidth spaces instead of treating them as ASCII cleanup", () => {
    expect(normalizeDraftSource("　[[今日|きょう]]　")).toBe("　[[今日|きょう]]　");
  });

  it("counts extended grapheme clusters independently of host ICU", () => {
    expect(draftGraphemeCount("👩‍💻é🇯🇵")).toBe(3);
    expect(draftGraphemeCount("が")).toBe(1);
  });

  it("rejects an overlong authored span and reports hand-written markup", () => {
    const overlong = "あ".repeat(MAX_DRAFT_RUN_CLUSTERS + 1);
    expect(createImeSpan("漢字", overlong)).toBeNull();
    expect(analyzeDraftTyping(`[[漢字|${overlong}]]`).issues.map((issue) => issue.code)).toEqual([
      "ime-run-too-long",
    ]);
  });

  it("splits a run before an adjacent span would cross the cap", () => {
    const first = "あ".repeat(14);
    const second = "い".repeat(15);
    const program = analyzeDraftTyping(`[[一|${first}]][[二|${second}]]`);

    expect(program.issues).toEqual([]);
    expect(program.imeRunCount).toBe(2);
  });
});
