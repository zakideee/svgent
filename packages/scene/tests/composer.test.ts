import {
  buildTimeline,
  CHOICE_SEND_BEAT_MS,
  COMPOSER_PANEL_SHRINK_MS,
  choiceDraftTiming,
  choiceKeyingStartMs,
  composerBasePanelAnimation,
  composerDraftTimings,
  composerPanelAnimation,
  DEFAULT_PROJECT,
  IME_CONVERSION_MS,
  pickerCloseMs,
  planComposerDraft,
  planComposerShove,
  type SessionMessage,
  stripDraftMarkup,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

type OpacityFrame = { at: number; opacity?: number };
type ShoveFrame = { at: number; transform?: { translateY?: number } };

describe("multi-line composer surfaces", () => {
  it("uses the caller's fallback width instead of inferring it from the font name", () => {
    const messages: SessionMessage[] = [{ id: "u", role: "user", content: "abcdefghij" }];
    const project = { ...DEFAULT_PROJECT, messages };
    const timing = buildTimeline(project, messages).messages[0];
    if (!timing) {
      throw new Error("missing draft timing");
    }

    const plan = planComposerDraft(timing, {
      widthPx: 56,
      fontPx: 10,
      lineHeightPx: 16,
      font: "custom-mono",
      fallback: [],
      fallbackRatio: 0.6,
    });

    expect(plan.lines).toEqual(["abcdefghi", "j"]);
  });

  it("switches intermediate translucent surfaces without a cross-fade", () => {
    const animation = composerPanelAnimation({
      showMs: 1_000,
      hideMs: 2_000,
      settleMs: 0,
      durationMs: 4_000,
    });
    const frames = animation.keyframes as OpacityFrame[];
    expect(frames.map((frame) => frame.opacity)).toEqual([0, 0, 1, 1, 0, 0]);
    expect(frames.every((frame) => frame.opacity === 0 || frame.opacity === 1)).toBe(true);
    expect(animation.easing).toBe("step-end");
  });

  it("keeps the one-line surface hidden through the final shrink", () => {
    const animation = composerBasePanelAnimation([{ startMs: 1_000, endMs: 2_500 }], 4_000);
    expect(animation).toBeDefined();
    const frames = animation?.keyframes as OpacityFrame[];
    expect(frames.map((frame) => frame.opacity)).toEqual([1, 1, 0, 0, 1, 1]);
    expect(animation?.easing).toBe("step-end");
  });

  it("stands the transcript off the grown panel and settles it back", () => {
    const animation = planComposerShove({
      durationMs: 4_000,
      settleMs: COMPOSER_PANEL_SHRINK_MS,
      drafts: [
        {
          releaseMs: 2_000,
          stages: [
            { atMs: 1_000, shovePx: 24 },
            { atMs: 1_400, shovePx: 48 },
          ],
        },
      ],
    });
    const frames = (animation?.keyframes ?? []) as ShoveFrame[];
    expect(frames.map((frame) => frame.transform?.translateY)).toEqual([
      0, 0, -24, -24, -48, -48, 0, 0,
    ]);
  });

  it("hands the rows back in the repaint that removes a terminal's grown box", () => {
    // A terminal has no size transition. The panel and the stand-off read one
    // settle, so no instant exists where the box has gone but the rows are
    // still standing off — or the reverse.
    const settleMs = 0;
    const durationMs = 4_000;
    const panel = composerPanelAnimation({ showMs: 1_000, hideMs: 2_000, settleMs, durationMs });
    const shove = planComposerShove({
      durationMs,
      settleMs,
      drafts: [{ releaseMs: 2_000, stages: [{ atMs: 1_000, shovePx: 24 }] }],
    });
    const panelClears = (panel.keyframes as OpacityFrame[]).find(
      (frame) => frame.at > 0.3 && frame.opacity === 0,
    );
    const rowsReturn = ((shove?.keyframes ?? []) as ShoveFrame[]).find(
      (frame) => frame.at > 0.3 && (frame.transform?.translateY ?? 0) === 0,
    );
    expect(panelClears).toBeDefined();
    expect(rowsReturn).toBeDefined();
    expect(rowsReturn?.at).toBe(panelClears?.at);
  });

  it("does not return an instant surface early on a mixed smooth track", () => {
    const durationMs = 4_000;
    const releaseMs = 2_000;
    const shove = planComposerShove({
      durationMs,
      settleMs: COMPOSER_PANEL_SHRINK_MS,
      drafts: [
        { releaseMs: 900, stages: [{ atMs: 400, shovePx: 12 }] },
        {
          releaseMs,
          settleMs: 0,
          stages: [{ atMs: 1_000, shovePx: 24 }],
        },
      ],
    });
    const frames = (shove?.keyframes ?? []) as ShoveFrame[];
    const frameAt = (atMs: number) =>
      frames.find((frame) => Math.round(frame.at * durationMs) === atMs)?.transform?.translateY;

    // The smooth picker makes the shared track linear. The instant surface
    // must therefore hold through its release and spend the unavoidable 1ms
    // interpolation after the chrome is gone, never before it.
    expect(shove?.easing).toBe("linear");
    expect(frameAt(releaseMs)).toBe(-24);
    expect(frameAt(releaseMs + 1)).toBe(0);
  });

  it("orders a track built from drafts handed over out of order", () => {
    // The pickers and the grown boxes are collected separately and appended,
    // so the drafts do not arrive in time order. One element carries one
    // track, and a track whose frames run backwards is a schedule the
    // renderer has to guess at.
    const durationMs = 10_000;
    const shove = planComposerShove({
      durationMs,
      settleMs: 0,
      drafts: [
        { releaseMs: 8_000, stages: [{ atMs: 6_000, shovePx: 48 }] },
        { releaseMs: 4_000, stages: [{ atMs: 2_000, shovePx: 24 }] },
      ],
    });
    const frames = (shove?.keyframes ?? []) as ShoveFrame[];
    expect(frames.length).toBeGreaterThan(1);

    let previous = Number.NEGATIVE_INFINITY;
    for (const frame of frames) {
      expect(frame.at).toBeGreaterThan(previous);
      previous = frame.at;
    }
    // Each stand-off still stands off, and each is handed back on its own
    // release rather than the last one seen.
    const shoveAt = (atMs: number) =>
      frames.filter((frame) => frame.at * durationMs <= atMs).at(-1)?.transform?.translateY ?? 0;
    expect(shoveAt(3_000)).toBe(-24);
    expect(shoveAt(5_000)).toBe(0);
    expect(shoveAt(7_000)).toBe(-48);
    expect(shoveAt(9_000)).toBe(0);
  });

  it("lets an app fold its grown surface away over its own beat", () => {
    const panel = composerPanelAnimation({
      showMs: 1_000,
      hideMs: 2_000,
      settleMs: COMPOSER_PANEL_SHRINK_MS,
      durationMs: 4_000,
    });
    const frames = panel.keyframes as OpacityFrame[];
    expect(panel.easing).toBe("linear");
    expect(frames.some((frame) => frame.at * 4_000 > 2_000 && (frame.opacity ?? 0) === 0)).toBe(
      true,
    );
  });
  it("leaves a conversation that nothing would cover exactly where it is", () => {
    // A draft that grows over empty space below the last message must not
    // move the transcript at all — the stand-off is a remedy, not a style.
    expect(
      planComposerShove({
        durationMs: 4_000,
        settleMs: COMPOSER_PANEL_SHRINK_MS,
        drafts: [{ releaseMs: 2_000, stages: [{ atMs: 1_000, shovePx: 0 }] }],
      }),
    ).toBeNull();
  });
});

describe("a freeform choice answer", () => {
  const answer = "まず再現手順から書きます";
  const messages: SessionMessage[] = [
    { id: "u1", role: "user", content: "落ちた原因を調べて。" },
    {
      id: "c1",
      role: "choice",
      content: "どう進めますか?",
      options: ["原因から直す — 最短", "テストを増やす — 安全"],
      freeform: answer,
    },
  ];

  it("is typed at the composer between the pick and the send", () => {
    const project = { ...DEFAULT_PROJECT, messages };
    const timeline = buildTimeline(project, messages);
    const choice = timeline.messages[1];
    if (!choice) {
      throw new Error("missing choice timing");
    }
    const draft = choiceDraftTiming(choice, project);
    if (!draft) {
      throw new Error("a freeform answer must produce a draft");
    }

    // The draft is what the composer draws: a user turn holding the answer.
    expect(draft.message.role).toBe("user");
    expect(draft.message.content).toBe(answer);
    // Typing starts once the picker has cleared the frame, not on the pick
    // itself — the card and the composer share the same strip of window.
    const decideMs = choice.startMs + project.timing.permissionMs;
    expect(draft.startMs).toBeGreaterThan(decideMs);
    expect(draft.startMs).toBe(choiceKeyingStartMs(choice, project));
    // …and the send waits a beat shorter than a composed message's.
    expect(draft.settledMs - draft.revealEndMs).toBe(CHOICE_SEND_BEAT_MS);
    expect(CHOICE_SEND_BEAT_MS).toBeLessThan(420);
    // The choice's own window covers the whole of it, so the next message
    // starts after the answer was sent rather than over it.
    expect(choice.revealEndMs).toBe(draft.settledMs);
  });

  it("is not produced at all when an option is picked", () => {
    const picked: SessionMessage[] = [
      messages[0] as SessionMessage,
      { ...(messages[1] as SessionMessage), freeform: undefined, chosenIndex: 1 },
    ];
    const project = { ...DEFAULT_PROJECT, messages: picked };
    const timeline = buildTimeline(project, picked);
    const drafts = composerDraftTimings(timeline, project);

    // Picking answers on the spot: nothing is typed at the prompt.
    expect(drafts.map((timing) => timing.message.id)).toEqual(["u1"]);
  });

  it("pays for the conversions its staging marks up", () => {
    const staged: SessionMessage[] = [
      messages[0] as SessionMessage,
      {
        ...(messages[1] as SessionMessage),
        freeform: "まず[[再現|さいげん]][[手順|てじゅん]]から[[書|か]]きます",
      },
    ];
    const project = { ...DEFAULT_PROJECT, messages: staged };
    const plain = buildTimeline({ ...DEFAULT_PROJECT, messages }, messages);
    const timeline = buildTimeline(project, staged);
    const stagedChoice = timeline.messages[1];
    const plainChoice = plain.messages[1];
    if (!stagedChoice || !plainChoice) {
      throw new Error("missing choice timing");
    }

    // The same sentence reads out, but the fingers key the readings and
    // wait on three conversions — so the answer costs at least those beats
    // more than the unstaged one, exactly as it would in the composer.
    const stagedDraft = choiceDraftTiming(stagedChoice, project);
    const plainDraft = choiceDraftTiming(plainChoice, { ...DEFAULT_PROJECT, messages });
    expect(stripDraftMarkup(stagedDraft?.message.content ?? "")).toBe(answer);
    const runCount = stagedDraft?.draft?.program.imeRunCount ?? 0;
    expect(runCount).toBe(1);
    expect((stagedDraft?.revealEndMs ?? 0) - (stagedDraft?.startMs ?? 0)).toBeGreaterThanOrEqual(
      (plainDraft?.revealEndMs ?? 0) - (plainDraft?.startMs ?? 0) + runCount * IME_CONVERSION_MS,
    );
  });

  it("hands the frame back on the pick, not at the end of the message", () => {
    const project = { ...DEFAULT_PROJECT, messages };
    const timeline = buildTimeline(project, messages);
    const choice = timeline.messages[1];
    if (!choice) {
      throw new Error("missing choice timing");
    }
    const draft = choiceDraftTiming(choice, project);

    // The card starts closing on the pick, and the draft waits it out.
    expect(pickerCloseMs(choice, project)).toBe(choice.startMs + project.timing.permissionMs);
    expect(pickerCloseMs(choice, project)).toBeLessThan(draft?.startMs ?? 0);
    expect(pickerCloseMs(choice, project)).toBeLessThan(choice.revealEndMs);
  });
});
