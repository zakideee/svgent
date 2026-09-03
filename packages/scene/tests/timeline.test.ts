import { MAX_ANIMATION_FRAMES } from "@boundsvg/core";
import {
  animatedRasterFps,
  buildTimeline,
  countVisibleCharacters,
  DEFAULT_PROJECT,
  messageAtTime,
  paginateMessages,
  type SvgentProject,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

describe("session timeline", () => {
  it("keeps scrub gaps and the final hold on the most recently started step", () => {
    const timeline = buildTimeline(DEFAULT_PROJECT, DEFAULT_PROJECT.messages);
    const [first, second] = timeline.messages;
    expect(messageAtTime(timeline.messages, 0)).toBeNull();
    expect(messageAtTime(timeline.messages, first?.startMs ?? 0)?.message.id).toBe(
      first?.message.id,
    );
    expect(messageAtTime(timeline.messages, (second?.startMs ?? 1) - 1)?.message.id).toBe(
      first?.message.id,
    );
    expect(messageAtTime(timeline.messages, timeline.durationMs)?.message.id).toBe(
      timeline.messages.at(-1)?.message.id,
    );
  });

  it("places each event after the prior event and preserves a final hold", () => {
    const timeline = buildTimeline(DEFAULT_PROJECT, DEFAULT_PROJECT.messages);
    for (const [index, timing] of timeline.messages.entries()) {
      expect(timing.startMs).toBeLessThan(timing.revealEndMs);
      expect(timing.revealEndMs).toBeLessThan(timing.settledMs);
      // Handoff beats may push the next event later, never earlier; which
      // handoffs earn one is covered on its own below.
      const next = timeline.messages[index + 1];
      if (next) {
        expect(next.startMs).toBeGreaterThanOrEqual(timing.settledMs);
      }
    }
    expect(timeline.durationMs).toBeGreaterThan(timeline.messages.at(-1)?.settledMs ?? 0);
  });

  it("gives the agent a beat after an approval or an answered question", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      messages: [
        { id: "m0", role: "user", content: "直して" },
        { id: "m1", role: "permission", content: "app.ts を編集します" },
        { id: "m2", role: "tool", content: "sed -i s/a/b/ app.ts", language: "bash" },
        { id: "m3", role: "permission", content: "テストを流します", decision: "deny" },
        { id: "m4", role: "assistant", content: "わかりました、手元で確認してください。" },
        { id: "m5", role: "choice", content: "どう直しますか?", options: ["A", "B"] },
        { id: "m6", role: "assistant", content: "A で進めます。" },
        { id: "m7", role: "tool", content: "pnpm test", language: "bash" },
      ],
    };
    const [, permission, tool, denied, afterDeny, choice, afterChoice, agentTool] = buildTimeline(
      project,
      project.messages,
    ).messages;

    // An approved call was already queued behind the prompt: it runs on the press.
    expect(tool?.startMs).toBe(permission?.settledMs);
    // Two agent steps in a row are one continuous turn, so no beat either.
    expect(agentTool?.startMs).toBe(afterChoice?.settledMs);
    // A denial, and an answered question, hand the floor back to the model.
    expect(afterDeny?.startMs ?? 0).toBeGreaterThan(denied?.settledMs ?? 0);
    expect(afterChoice?.startMs ?? 0).toBeGreaterThan(choice?.settledMs ?? 0);
  });

  it("budgets a fenced code panel for as long as it takes to type out", () => {
    const content = [
      "## SVGだけで実装しました",
      "",
      "```svg",
      '<circle cx="24" cy="24" r="24" fill="currentColor" />',
      '  <animate attributeName="r" from="0" to="24" dur="0.4s" />',
      "</circle>",
      "```",
    ].join("\n");
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      messages: [{ id: "m0", role: "assistant", content }],
    };
    const [only] = buildTimeline(project, project.messages).messages;

    // Angle brackets, quotes and parens are Markdown punctuation in prose but
    // the code panel types every one of them, so a duration counted off the
    // raw source runs out while the panel is still going.
    const naiveMs = (countVisibleCharacters(content) / project.timing.agentTypingCps) * 1_000;
    expect((only?.revealEndMs ?? 0) - (only?.startMs ?? 0)).toBeGreaterThan(naiveMs);
  });

  it("splits slides on both a hard limit and authored page breaks", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      pagination: { ...DEFAULT_PROJECT.pagination, flow: "slides", messagesPerPage: 3 },
      messages: DEFAULT_PROJECT.messages.map((message, index) => ({
        ...message,
        ...(index === 2 ? { pageBreakBefore: true } : {}),
      })),
    };
    const pages = paginateMessages(project);
    expect(pages[0]).toHaveLength(2);
    expect(pages.every((page) => page.length <= 3)).toBe(true);
  });

  it("joins an automatic boundary when the break is explicitly false", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      pagination: { ...DEFAULT_PROJECT.pagination, flow: "slides", messagesPerPage: 3 },
      messages: DEFAULT_PROJECT.messages.map((message, index) => ({
        ...message,
        ...(index === 3 ? { pageBreakBefore: false } : {}),
      })),
    };
    // The count would break before the fourth message; the explicit false
    // suppresses exactly that boundary, and the count resumes afterwards.
    const pages = paginateMessages(project);
    expect(pages[0]).toHaveLength(4);
    expect(pages[1]?.length).toBeLessThanOrEqual(3);
  });

  it("keeps animated raster exports within boundsvg's exported frame budget", () => {
    for (const durationMs of [1_000, 15_000, 30_000, 120_000]) {
      const fps = animatedRasterFps(durationMs);
      expect(Math.ceil((durationMs * fps) / 1_000)).toBeLessThanOrEqual(MAX_ANIMATION_FRAMES);
      expect(fps).toBeGreaterThanOrEqual(1);
      expect(fps).toBeLessThanOrEqual(20);
    }
    expect(Math.ceil((15_000 * animatedRasterFps(15_000)) / 1_000)).toBe(MAX_ANIMATION_FRAMES);
  });
});
