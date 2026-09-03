import {
  buildTimeline,
  type MessageRole,
  paginateMessages,
  type SvgentProject,
  stripDraftMarkup,
} from "@svgent/scene";
import type { ScenePatchOperation } from "./patches.js";

type ReviewSeverity = "info" | "warning" | "error";

type AnimationReviewIssue = {
  code: string;
  severity: ReviewSeverity;
  message: string;
  pageIndex: number;
  messageId?: string;
  startMs?: number;
  endMs?: number;
  suggestion: string;
  suggestedOperations?: ScenePatchOperation[];
};

type AnimationReview = {
  score: number;
  pageDurationsMs: number[];
  issues: AnimationReviewIssue[];
};

const MIN_READABLE_MS: Record<MessageRole, number> = {
  user: 450,
  thinking: 800,
  tool: 650,
  permission: 1_100,
  assistant: 700,
  image: 1_600,
  choice: 1_300,
};

const MAX_COMFORTABLE_MS: Record<MessageRole, number> = {
  user: 12_000,
  thinking: 6_000,
  tool: 5_000,
  permission: 5_000,
  assistant: 18_000,
  image: 14_000,
  choice: 10_000,
};

function codeLineCapacity(project: SvgentProject): number {
  const innerWidth = project.appearance.canvasWidth - project.appearance.windowMargin * 2 - 120;
  const cellWidth = (project.surface === "tui" ? 7.8 : 8.4) * project.appearance.fontScale;
  return Math.max(20, Math.floor(innerWidth / cellWidth));
}

function longestLineLength(content: string): number {
  return Math.max(
    0,
    ...stripDraftMarkup(content)
      .split("\n")
      .map((line) => Array.from(line).length),
  );
}

type DurationReviewInput = {
  pageIndex: number;
  messageId: string;
  role: MessageRole;
  startMs: number;
  endMs: number;
};

function readableDurationIssues(input: DurationReviewInput): AnimationReviewIssue[] {
  const durationMs = input.endMs - input.startMs;
  if (durationMs < MIN_READABLE_MS[input.role]) {
    return [
      {
        code: "step-too-brief",
        severity: "warning",
        message: `The ${input.role} step is displayed too briefly to take in.`,
        pageIndex: input.pageIndex,
        messageId: input.messageId,
        startMs: input.startMs,
        endMs: input.endMs,
        suggestion: `Raise durationMs to at least ${MIN_READABLE_MS[input.role]}ms for this message only.`,
        suggestedOperations: [
          {
            op: "set-message-timing",
            messageId: input.messageId,
            changes: { durationMs: MIN_READABLE_MS[input.role] },
          },
        ],
      },
    ];
  }
  if (durationMs > MAX_COMFORTABLE_MS[input.role]) {
    return [
      {
        code: "step-too-long",
        severity: "info",
        message: `The ${input.role} step is displayed long enough to break the pacing.`,
        pageIndex: input.pageIndex,
        messageId: input.messageId,
        startMs: input.startMs,
        endMs: input.endMs,
        suggestion: `Lower durationMs to at most ${MAX_COMFORTABLE_MS[input.role]}ms for this message only.`,
        suggestedOperations: [
          {
            op: "set-message-timing",
            messageId: input.messageId,
            changes: { durationMs: MAX_COMFORTABLE_MS[input.role] },
          },
        ],
      },
    ];
  }
  return [];
}

type LineReviewInput = {
  pageIndex: number;
  messageId: string;
  content: string;
};

function lineLengthIssues(project: SvgentProject, input: LineReviewInput): AnimationReviewIssue[] {
  const capacity = codeLineCapacity(project);
  const longest = longestLineLength(input.content);
  if (longest <= capacity * 1.35) {
    return [];
  }
  return [
    {
      code: "long-unbroken-line",
      severity: "warning",
      message: `A long unbroken line exceeds the estimated display width (${longest} chars vs. about ${capacity}).`,
      pageIndex: input.pageIndex,
      messageId: input.messageId,
      suggestion: "Wrap that line, or split the message onto the next slide.",
    },
  ];
}

function pageIssues(input: {
  pageIndex: number;
  messageCount: number;
  durationMs: number;
  flow: SvgentProject["pagination"]["flow"];
}): AnimationReviewIssue[] {
  const issues: AnimationReviewIssue[] = [];
  if (input.durationMs > 30_000) {
    issues.push({
      code: "page-too-long",
      severity: "info",
      message: `Page ${input.pageIndex + 1} runs for ${(input.durationMs / 1_000).toFixed(1)}s.`,
      pageIndex: input.pageIndex,
      suggestion:
        input.flow === "slides"
          ? "Tighten the duration with animation-fit, or split the slide."
          : "Tighten the duration with animation-fit, or shorten the script at a natural break.",
    });
  }
  if (input.flow === "slides" && input.messageCount > 5) {
    issues.push({
      code: "page-dense",
      severity: "warning",
      message: `Page ${input.pageIndex + 1} holds ${input.messageCount} messages, which demands a lot of eye movement.`,
      pageIndex: input.pageIndex,
      suggestion: "Set pageBreakBefore at a natural break.",
    });
  }
  return issues;
}

export function reviewSceneAnimation(project: SvgentProject): AnimationReview {
  const issues: AnimationReviewIssue[] = [];
  const pageDurationsMs: number[] = [];
  for (const [pageIndex, messages] of paginateMessages(project).entries()) {
    const timeline = buildTimeline(project, messages);
    pageDurationsMs.push(timeline.durationMs);
    issues.push(
      ...pageIssues({
        pageIndex,
        messageCount: messages.length,
        durationMs: timeline.durationMs,
        flow: project.pagination.flow,
      }),
    );
    for (const timing of timeline.messages) {
      issues.push(
        // A user turn with no composer has no window of its own to read: the
        // keystrokes are not drawn, so the bubble lands and the beats around
        // it carry the pause. Measuring that against a reading pace would flag
        // every turn, and the fix it suggests would buy back the dead air.
        // `fitSceneDuration` clears any hold left on such a turn, so there is
        // no authored case left here to measure either.
        ...(timing.message.role === "user" && !project.display.composer
          ? []
          : readableDurationIssues({
              pageIndex,
              messageId: timing.message.id,
              role: timing.message.role,
              startMs: timing.startMs,
              endMs: timing.revealEndMs,
            })),
        ...lineLengthIssues(project, {
          pageIndex,
          messageId: timing.message.id,
          content: timing.message.content,
        }),
      );
      const transitionMs = timing.settledMs - timing.revealEndMs;
      if (transitionMs < 90 && timing !== timeline.messages.at(-1)) {
        issues.push({
          code: "transition-too-brief",
          severity: "info",
          message:
            "The gap before the next element is short enough to make the change look abrupt.",
          pageIndex,
          messageId: timing.message.id,
          startMs: timing.revealEndMs,
          endMs: timing.settledMs,
          suggestion: "Raise transitionMs to at least 90ms for this message only.",
          suggestedOperations: [
            {
              op: "set-message-timing",
              messageId: timing.message.id,
              changes: { transitionMs: 90 },
            },
          ],
        });
      }
    }
  }
  const penalty = issues.reduce((sum, issue) => {
    if (issue.severity === "error") {
      return sum + 20;
    }
    return sum + (issue.severity === "warning" ? 8 : 2);
  }, 0);
  return { score: Math.max(0, 100 - penalty), pageDurationsMs, issues };
}
