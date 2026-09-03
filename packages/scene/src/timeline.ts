import { MAX_ANIMATION_FRAMES } from "@boundsvg/core";
import { CLUSTER_REVEAL_MS } from "./animations.js";
import {
  MIN_DRAFT_REVEAL_MS,
  type ResolvedDraftTyping,
  resolveDraftTyping,
} from "./draft-typing.js";
import { draftGraphemeCount } from "./graphemes.js";
import { markdownRevealCharacters } from "./markdown.js";
import { type SessionMessage, type SvgentProject, stripDraftMarkup } from "./model.js";

export { COMPLETION_ACCEPT_MS, IME_COMMIT_MS, IME_CONVERSION_MS } from "./draft-typing.js";

export type MessageTiming = {
  message: SessionMessage;
  startMs: number;
  revealEndMs: number;
  settledMs: number;
  /** One resolved composer clock; surfaces must not derive their own cps or phases. */
  draft?: ResolvedDraftTyping;
};

export type SessionTimeline = {
  messages: MessageTiming[];
  durationMs: number;
};

export type DraftTimelineIssue = {
  code: "ime-run-too-long" | "duration-too-short" | "project-too-long";
  messageId?: string;
  messageIndex?: number;
  detail: string;
};

const MIN_TEXT_REVEAL_MS = MIN_DRAFT_REVEAL_MS;
export const MAX_PROJECT_DURATION_MS = 120_000;

/**
 * The gap a freeform answer leaves between its last keystroke and its
 * settle, out of which `sendMomentMs` takes the pause before the send.
 * Deliberately shorter than a composed message's (which is allowed up to
 * 420ms): the answer replies to a question already on screen rather than
 * being composed from nothing, and the picker above it is waiting.
 */
export const CHOICE_SEND_BEAT_MS = 170;

export function countVisibleCharacters(value: string): number {
  return draftGraphemeCount(value.replace(/[`*_#[\](){}<>]/gu, ""));
}

/**
 * How long the picker takes to clear the frame after the pick commits. The
 * prompt only takes the keyboard once it has: on the App the card and the
 * composer share the same strip of the window, so a draft that starts with
 * the pick types straight through the fading card.
 */
const PICKER_HANDOFF_MS = { app: 160, tui: 80 } as const;

/** When the prompt takes over from a picker that hands the keyboard back. */
export function choiceKeyingStartMs(timing: MessageTiming, project: SvgentProject): number {
  if (timing.draft !== undefined) {
    return timing.draft.startMs;
  }
  return Math.min(
    timing.startMs + project.timing.permissionMs + PICKER_HANDOFF_MS[project.surface],
    timing.revealEndMs,
  );
}

/**
 * Whether a freeform answer is keyed in rather than simply landing on the
 * card. It is typed at the prompt, so a scene drawn without a composer has
 * nowhere to type it and settles the answer on the choice card instead.
 */
function freeformIsTyped(message: SessionMessage, project: SvgentProject): boolean {
  return message.role === "choice" && project.display.composer;
}

function nonDraftMessageDurationMs(project: SvgentProject, message: SessionMessage): number {
  if (message.timing?.durationMs !== undefined) {
    return message.timing.durationMs;
  }
  const { timing } = project;
  switch (message.role) {
    case "user":
      // Unreachable: buildTimeline routes user turns through `userTurn`, which
      // owns whether their keystrokes cost time. Kept so the switch stays
      // exhaustive over the role union, and deliberately not a second copy of
      // that rule.
      return 0;
    case "assistant":
      // Counted off the parsed blocks, not the raw source: stripping
      // Markdown punctuation guesses low on a fenced code panel, and the
      // next step then starts while the panel is still typing itself out.
      return (
        Math.max(
          MIN_TEXT_REVEAL_MS,
          (markdownRevealCharacters(stripDraftMarkup(message.content)) / timing.agentTypingCps) *
            1_000,
        ) + CLUSTER_REVEAL_MS
      );
    case "thinking":
      return timing.thinkingMs;
    case "tool":
      return timing.toolRunMs;
    case "permission":
      return timing.permissionMs;
    case "image":
      return timing.imageGenMs;
    case "choice":
      // The offer is read like a permission prompt, then answered: picking
      // is quick, while typing a reply runs at the user's own speed and
      // carries its own short beat before the send.
      return (
        timing.permissionMs + (message.freeform && freeformIsTyped(message, project) ? 0 : 420)
      );
  }
}

/**
 * Beat between a user message landing and the agent's first visible
 * reaction. Without it the agent starts thinking the same frame the bubble
 * lands, which reads as if the response was prepared before the question.
 */
/** Ceiling on the pause a user takes to read the agent before replying. */
const MAX_READING_MS = 800;

/**
 * Whether the block ends on the user doing something: typing a message,
 * answering a question, or pressing allow/deny. The approval and choice
 * cards open as agent requests but their duration runs until the click,
 * so the agent picks up after them exactly as it does after a user turn.
 */
function endsWithUserAction(message: SessionMessage): boolean {
  return message.role === "user" || message.role === "permission" || message.role === "choice";
}

/**
 * Handoff pause before `message`, given what came before it. Both beats
 * scale with the scene's transition setting, so the tight pacing preset
 * compresses them along with everything else.
 */
function handoffPauseMs(
  project: SvgentProject,
  previous: SessionMessage | undefined,
  message: SessionMessage,
): number {
  if (previous === undefined) {
    return 0;
  }
  const scale = project.timing.transitionMs / 260;
  if (endsWithUserAction(previous) && message.role !== "user") {
    // An approved call was already composed and queued behind the prompt,
    // so it runs on the press — only the model retaking the floor costs a
    // beat. A denial gives the floor straight back to the model.
    const approvedCall =
      previous.role === "permission" && previous.decision !== "deny" && message.role === "tool";
    return approvedCall ? 0 : project.timing.reactionMs * scale;
  }
  if (message.role === "user" && !endsWithUserAction(previous)) {
    // Reading the answer takes longer than reading a one-line tool echo.
    const characters = countVisibleCharacters(previous.content);
    return Math.min(MAX_READING_MS, 150 + characters * 6) * scale;
  }
  return 0;
}

// ————————————————————————————————————————————————————————————————————————————
// Highlight beats. A highlighted thinking row opens its full note after it
// settles, holds long enough to read, and folds back. The beat owns real
// timeline time — everything after it starts later — so the shove, the
// camera, and the scroll all see one consistent clock instead of a motion
// squeezed between two reveals.
// ————————————————————————————————————————————————————————————————————————————

const HIGHLIGHT_OPEN_MS = 260;
const HIGHLIGHT_CLOSE_MS = 240;
const HIGHLIGHT_HOLD_MIN_MS = 900;
const HIGHLIGHT_HOLD_MAX_MS = 2_600;
/** Reading pace for the held note; unhurried, roughly spoken speed. */
const HIGHLIGHT_HOLD_PER_CHARACTER_MS = 34;

function isHighlighted(project: SvgentProject, message: SessionMessage): boolean {
  // The beat is an App-surface presentation; a TUI timeline charging its
  // time would replay as dead air.
  return project.surface === "app" && message.role === "thinking" && message.highlight === true;
}

/**
 * The beat scales with the scene's pacing the same way the handoff beats do,
 * so a tight preset — or the gallery's fast-forwarded preview — compresses
 * the hold along with everything else instead of playing it at full length.
 */
function paceScale(project: SvgentProject): number {
  return project.timing.transitionMs / 260;
}

function highlightHoldMs(project: SvgentProject, message: SessionMessage): number {
  return (
    Math.min(
      HIGHLIGHT_HOLD_MAX_MS,
      Math.max(
        HIGHLIGHT_HOLD_MIN_MS,
        countVisibleCharacters(message.content) * HIGHLIGHT_HOLD_PER_CHARACTER_MS,
      ),
    ) * paceScale(project)
  );
}

function highlightBeatMs(project: SvgentProject, message: SessionMessage): number {
  if (!isHighlighted(project, message)) {
    return 0;
  }
  const scale = paceScale(project);
  return HIGHLIGHT_OPEN_MS * scale + highlightHoldMs(project, message) + HIGHLIGHT_CLOSE_MS * scale;
}

export type HighlightWindow = {
  startMs: number;
  arriveMs: number;
  holdEndMs: number;
  returnMs: number;
};

/**
 * Where a highlighted row's beat sits on the master clock. The beat starts
 * once the row has settled into its checked-off label, and its return is the
 * settledMs the timeline already charged for it.
 */
export function highlightWindow(
  timing: MessageTiming,
  project: SvgentProject,
): HighlightWindow | null {
  if (!isHighlighted(project, timing.message)) {
    return null;
  }
  const startMs =
    timing.revealEndMs + (timing.message.timing?.transitionMs ?? project.timing.transitionMs);
  const scale = paceScale(project);
  const arriveMs = startMs + HIGHLIGHT_OPEN_MS * scale;
  const holdEndMs = arriveMs + highlightHoldMs(project, timing.message);
  return { startMs, arriveMs, holdEndMs, returnMs: holdEndMs + HIGHLIGHT_CLOSE_MS * scale };
}

/**
 * A freeform answer, as the composer sees it: a draft typed at the prompt
 * once the picker closes, then sent. Selecting an option answers on the
 * spot, so only the freeform case produces one.
 *
 * The synthetic timing carries the user role because that is what the
 * composer draws — the answer really is typed at the prompt, the way a real
 * selector hands the keyboard back rather than taking prose into its rows.
 */
export function choiceDraftTiming(
  timing: MessageTiming,
  project: SvgentProject,
): MessageTiming | null {
  const { message } = timing;
  const answer = message.freeform ?? "";
  if (!freeformIsTyped(message, project) || answer.length === 0) {
    return null;
  }
  const draft =
    timing.draft ??
    resolveDraftTyping({
      content: answer,
      startMs: choiceKeyingStartMs(timing, project),
      authoredCps: project.timing.userTypingCps,
    });
  const settledMs = draft.revealEndMs + CHOICE_SEND_BEAT_MS;
  return {
    message: { ...message, role: "user", content: answer },
    startMs: draft.startMs,
    revealEndMs: draft.revealEndMs,
    settledMs,
    draft,
  };
}

/** Every draft the composer types: real user turns plus freeform answers. */
export function composerDraftTimings(
  timeline: SessionTimeline,
  project: SvgentProject,
): MessageTiming[] {
  return timeline.messages.flatMap((timing) => {
    if (timing.message.role === "user") {
      return [timing];
    }
    const draft = choiceDraftTiming(timing, project);
    return draft ? [draft] : [];
  });
}

/**
 * A user turn's own time. With a prompt on screen the keystrokes are the
 * content and the turn lasts as long as they take. Without one there is
 * nowhere to draw them, and charging their time would hold a still frame for
 * as long as the sentence takes to type — so the bubble lands the way a sent
 * message does, and the handoff and transition beats that every other message
 * already pays carry the rhythm on their own.
 */
function userTurn(
  project: SvgentProject,
  message: SessionMessage,
  startMs: number,
): { activeDurationMs: number; draft?: ResolvedDraftTyping } {
  if (!project.display.composer) {
    return { activeDurationMs: message.timing?.durationMs ?? 0 };
  }
  const draft = resolveDraftTyping({
    content: message.content,
    startMs,
    authoredCps: project.timing.userTypingCps,
    ...(message.timing?.durationMs === undefined ? {} : { durationMs: message.timing.durationMs }),
  });
  return { activeDurationMs: draft.activeDurationMs, draft };
}

export function buildTimeline(project: SvgentProject, messages: SessionMessage[]): SessionTimeline {
  let cursorMs = 180;
  const timings = messages.map((message, index) => {
    const startMs =
      cursorMs +
      (message.timing?.pauseBeforeMs ?? handoffPauseMs(project, messages[index - 1], message));
    let draft: ResolvedDraftTyping | undefined;
    let activeDurationMs: number;
    if (message.role === "user") {
      const typed = userTurn(project, message, startMs);
      draft = typed.draft;
      activeDurationMs = typed.activeDurationMs;
    } else if (
      message.role === "choice" &&
      message.freeform !== undefined &&
      message.freeform.length > 0 &&
      freeformIsTyped(message, project)
    ) {
      const draftStartMs =
        startMs + project.timing.permissionMs + PICKER_HANDOFF_MS[project.surface];
      const fixedBeforeDraftMs = draftStartMs - startMs;
      const authoredDurationMs = message.timing?.durationMs;
      const draftBudgetMs =
        authoredDurationMs === undefined
          ? undefined
          : authoredDurationMs - fixedBeforeDraftMs - CHOICE_SEND_BEAT_MS;
      draft = resolveDraftTyping({
        content: message.freeform,
        startMs: draftStartMs,
        authoredCps: project.timing.userTypingCps,
        ...(draftBudgetMs === undefined ? {} : { durationMs: draftBudgetMs }),
      });
      activeDurationMs = Math.max(
        authoredDurationMs ?? 0,
        fixedBeforeDraftMs + draft.activeDurationMs + CHOICE_SEND_BEAT_MS,
      );
    } else {
      activeDurationMs = nonDraftMessageDurationMs(project, message);
    }
    const revealEndMs = startMs + activeDurationMs;
    const settledMs =
      revealEndMs +
      (message.timing?.transitionMs ?? project.timing.transitionMs) +
      highlightBeatMs(project, message);
    cursorMs = settledMs;
    return { message, startMs, revealEndMs, settledMs, ...(draft ? { draft } : {}) };
  });
  // Never hand renderers a shorter clock than the events they contain. Export
  // validation owns the 120s policy; clipping the clock here made later phases
  // unreachable while leaving their tracks in the scene.
  const durationMs = Math.max(1_000, cursorMs + project.timing.finalHoldMs);
  return { messages: timings, durationMs };
}

/** Publication blockers that the lenient preview can still render deterministically. */
export function draftTimelineIssues(project: SvgentProject): DraftTimelineIssue[] {
  const timeline = buildTimeline(project, project.messages);
  const issues: DraftTimelineIssue[] = [];
  const seen = new Set<string>();
  timeline.messages.forEach((timing, messageIndex) => {
    for (const issue of timing.draft?.issues ?? []) {
      const key = `${timing.message.id}\u0000${issue.code}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      issues.push({
        code: issue.code,
        messageId: timing.message.id,
        messageIndex,
        detail: issue.message,
      });
    }
  });
  if (timeline.durationMs > MAX_PROJECT_DURATION_MS) {
    issues.push({
      code: "project-too-long",
      detail: `Timeline is ${Math.ceil(timeline.durationMs)}ms; animated scenes are limited to ${MAX_PROJECT_DURATION_MS}ms.`,
    });
  }
  return issues;
}

/**
 * The script step the playhead belongs to. Handoff gaps and the final hold
 * stay attached to the most recently started step, so a scrub accent does
 * not flicker away between messages.
 */
export function messageAtTime(
  messages: readonly MessageTiming[],
  timeMs: number,
): MessageTiming | null {
  let current: MessageTiming | null = null;
  for (const timing of messages) {
    if (timeMs < timing.startMs) {
      break;
    }
    current = timing;
  }
  return current;
}

export function paginateMessages(project: SvgentProject): SessionMessage[][] {
  if (project.pagination.flow === "scroll") {
    return [project.messages];
  }

  const pages: SessionMessage[][] = [];
  let currentPage: SessionMessage[] = [];
  for (const message of project.messages) {
    const startsNewPage = message.pageBreakBefore === true && currentPage.length > 0;
    // An explicit false joins: the author removed the automatic boundary
    // that the per-page count would have placed before this message.
    const pageIsFull =
      currentPage.length >= project.pagination.messagesPerPage && message.pageBreakBefore !== false;
    if (startsNewPage || pageIsFull) {
      pages.push(currentPage);
      currentPage = [];
    }
    currentPage.push(message);
  }
  if (currentPage.length > 0) {
    pages.push(currentPage);
  }
  return pages.length > 0 ? pages : [[]];
}

export function animatedRasterFps(durationMs: number): number {
  const frameBudgetFps = Math.floor((MAX_ANIMATION_FRAMES * 1_000) / Math.max(durationMs, 1));
  return Math.max(1, Math.min(20, frameBudgetFps));
}
