import {
  applyScenePatch,
  checkProjectForPublication,
  DraftStore,
  fitSceneDuration,
  locateTimelineSegments,
  parseScenePatchOperations,
  reviewSceneAnimation,
} from "@svgent/authoring";
import {
  buildTimeline,
  DEFAULT_PROJECT,
  deserializeProject,
  type SvgentProject,
  serializeProject,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

function compactProject(): SvgentProject {
  return {
    ...DEFAULT_PROJECT,
    messages: DEFAULT_PROJECT.messages.slice(0, 3).map((message) => ({ ...message })),
  };
}

describe("appearance patches", () => {
  it("reseeds the theme's colors, and lets an explicit color in the same op win", () => {
    const project = compactProject();
    const [operation] = parseScenePatchOperations([
      { op: "set-appearance", changes: { theme: "paper", accent: "#ff0000" } },
    ]);
    const applied = applyScenePatch(project, [operation!]);

    expect(applied.project.appearance.theme).toBe("paper");
    expect(applied.project.appearance.accent).toBe("#ff0000");
    // background and userBubbleColor were not named, so the preset seeds them.
    expect(applied.project.appearance.background).not.toBe(project.appearance.background);
    const paths = applied.changes.map((change) => change.path);
    expect(paths).toContain("appearance.theme");
    expect(paths).toContain("appearance.background");
    expect(paths).toContain("appearance.userBubbleColor");
    // Appearance is global, so every message is in the affected window.
    expect(applied.affectedMessageIds).toHaveLength(project.messages.length);
  });

  it("reports no change when the requested appearance already matches", () => {
    const project = compactProject();
    const [operation] = parseScenePatchOperations([
      { op: "set-appearance", changes: { fontScale: project.appearance.fontScale } },
    ]);
    const applied = applyScenePatch(project, [operation!]);
    expect(applied.changes).toEqual([]);
    expect(applied.affectedMessageIds).toEqual([]);
  });

  it("rejects out-of-range, unknown, and malformed appearance fields", () => {
    expect(() =>
      parseScenePatchOperations([{ op: "set-appearance", changes: { fontScale: 12 } }]),
    ).toThrow(/fontScale/u);
    expect(() =>
      parseScenePatchOperations([{ op: "set-appearance", changes: { canvasDepth: 3 } }]),
    ).toThrow(/unsupported field/u);
    expect(() =>
      parseScenePatchOperations([{ op: "set-appearance", changes: { accent: "red" } }]),
    ).toThrow(/color/u);
    expect(() =>
      parseScenePatchOperations([{ op: "set-appearance", changes: { theme: "neon" } }]),
    ).toThrow(/theme must be one of/u);
    // Images stay tab-local; the patch vocabulary must not carry one.
    expect(() =>
      parseScenePatchOperations([
        { op: "set-appearance", changes: { backdropImage: { src: "data:image/png;base64,AA" } } },
      ]),
    ).toThrow(/unsupported field/u);
    expect(() => parseScenePatchOperations([{ op: "set-appearance", changes: {} }])).toThrow(
      /must not be empty/u,
    );
  });
});

describe("targeted authoring", () => {
  it("round-trips and applies per-message pacing without changing its neighbors", () => {
    const source = compactProject();
    const targetId = source.messages[1]?.id ?? "";
    const patched = applyScenePatch(source, [
      {
        op: "set-message-timing",
        messageId: targetId,
        changes: { durationMs: 2_400, pauseBeforeMs: 700, transitionMs: 320 },
      },
    ]).project;
    const imported = deserializeProject(serializeProject(patched));
    expect(imported.warnings).toEqual([]);
    expect(imported.project.messages[1]?.timing).toEqual({
      durationMs: 2_400,
      pauseBeforeMs: 700,
      transitionMs: 320,
    });

    const before = buildTimeline(source, source.messages).messages;
    const after = buildTimeline(imported.project, imported.project.messages).messages;
    expect((after[1]?.revealEndMs ?? 0) - (after[1]?.startMs ?? 0)).toBe(2_400);
    expect((after[1]?.settledMs ?? 0) - (after[1]?.revealEndMs ?? 0)).toBe(320);
    expect((after[1]?.startMs ?? 0) - (after[0]?.settledMs ?? 0)).toBe(700);
    expect(after[0]).toEqual(before[0]);
  });

  it("parses only the bounded patch vocabulary and hides changed content in its summary", () => {
    const project = compactProject();
    const messageId = project.messages[0]?.id ?? "";
    const operations = parseScenePatchOperations([
      { op: "set-message-content", messageId, content: "公開用に短くした文" },
    ]);
    const result = applyScenePatch(project, operations);
    expect(result.project.messages[0]?.content).toBe("公開用に短くした文");
    expect(JSON.stringify(result.changes)).not.toContain("公開用に短くした文");
    expect(() =>
      parseScenePatchOperations([
        { op: "set-message-timing", messageId, changes: { durationMs: 99 } },
      ]),
    ).toThrow(/200/u);
  });

  it("keeps proposals inert until revision-checked apply and supports undo", () => {
    const store = new DraftStore();
    const created = store.create(serializeProject(compactProject()));
    const messageId = created.messages[1]?.id ?? "";
    const proposal = store.propose(created.draftHandle, created.revision, [
      {
        op: "set-message-timing",
        messageId,
        changes: { durationMs: 2_900 },
      },
    ]);
    expect(store.project(created.draftHandle).messages[1]?.timing).toBeUndefined();
    expect(() => store.apply(proposal.proposalHandle, 99)).toThrow(/Revision conflict/u);
    const applied = store.apply(proposal.proposalHandle, created.revision);
    expect(applied.revision).toBe(2);
    expect(store.project(created.draftHandle).messages[1]?.timing?.durationMs).toBe(2_900);
    const undone = store.undo(created.draftHandle, applied.revision);
    expect(undone.revision).toBe(3);
    expect(store.project(created.draftHandle).messages[1]?.timing).toBeUndefined();
  });

  it("fits one page by proposing local timing changes and locates only affected segments", () => {
    const project = compactProject();
    const before = buildTimeline(project, project.messages).durationMs;
    const fit = fitSceneDuration(project, { pageIndex: 0, targetMs: Math.round(before * 0.8) });
    expect(fit.afterMs).toBeLessThan(fit.beforeMs);
    expect(Math.abs(fit.afterMs - fit.targetMs)).toBeLessThanOrEqual(80);
    expect(fit.operations.every((operation) => operation.op === "set-message-timing")).toBe(true);

    const targetId = project.messages[1]?.id ?? "";
    const [segment] = locateTimelineSegments(project, [targetId], 100);
    expect(segment?.messageIds).toEqual([targetId]);
    expect(segment?.durationMs).toBeGreaterThan(0);
    expect(segment?.keyframeTimesMs).toHaveLength(3);
  });

  it("does not propose or accept slide-only page breaks in scroll flow", () => {
    const messages = Array.from({ length: 6 }, (_unused, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      content: `message ${index}`,
      timing: { durationMs: 800 },
    }));
    const scrollProject: SvgentProject = { ...DEFAULT_PROJECT, messages };
    expect(
      reviewSceneAnimation(scrollProject).issues.some((issue) => issue.code === "page-dense"),
    ).toBe(false);
    expect(() =>
      applyScenePatch(scrollProject, [
        { op: "set-message-page-break", messageId: "message-3", value: true },
      ]),
    ).toThrow(/pagination\.flow.*slides/u);

    const slidesProject: SvgentProject = {
      ...scrollProject,
      pagination: { ...scrollProject.pagination, flow: "slides", messagesPerPage: 6 },
    };
    expect(
      reviewSceneAnimation(slidesProject).issues.some((issue) => issue.code === "page-dense"),
    ).toBe(true);
    expect(
      applyScenePatch(slidesProject, [
        { op: "set-message-page-break", messageId: "message-3", value: true },
      ]).project.messages[3]?.pageBreakBefore,
    ).toBe(true);
  });

  it("reports animation and publication risks without echoing detected secrets", () => {
    // A synthetic key shape: the assertion below is that it is detected, not echoed.
    const secret = "sk-1234567890abcdefghijklmnop"; // gitleaks:allow
    const project: SvgentProject = {
      ...compactProject(),
      messages: [
        {
          id: "thinking",
          role: "thinking",
          content: "内部の詳しい思考を長く書き連ねる内容です。".repeat(5),
          timing: { durationMs: 250 },
        },
        {
          id: "tool",
          role: "tool",
          content: `curl https://localhost/private -H ${secret}`,
        },
      ],
    };
    const animation = reviewSceneAnimation(project);
    const briefIssue = animation.issues.find((issue) => issue.code === "step-too-brief");
    expect(briefIssue?.suggestedOperations).toEqual([
      {
        op: "set-message-timing",
        messageId: "thinking",
        changes: { durationMs: 800 },
      },
    ]);

    const publication = checkProjectForPublication(project);
    expect(publication.safeToExport).toBe(false);
    expect(publication.issues.some((issue) => issue.code === "credential-like-value")).toBe(true);
    expect(publication.issues.some((issue) => issue.code === "raw-tool-detail")).toBe(true);
    expect(JSON.stringify(publication)).not.toContain(secret);
  });

  it("warns about images attached to roles that never render them", () => {
    const pixel = {
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      mediaType: "image/png" as const,
      width: 1,
      height: 1,
      alt: "image",
    };
    const project: SvgentProject = {
      ...compactProject(),
      messages: [
        { id: "hidden", role: "thinking", content: "確認中", images: [pixel] },
        { id: "shown", role: "user", content: "添付します", images: [pixel] },
      ],
    };
    const publication = checkProjectForPublication(project);
    const hidden = publication.issues.filter((issue) => issue.code === "hidden-images");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.path).toBe("messages.hidden.images");
    // A warning, never a blocker.
    expect(publication.safeToExport).toBe(true);
  });
});
