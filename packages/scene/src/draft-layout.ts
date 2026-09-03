import type { DraftPhase, ResolvedDraftTyping } from "./draft-typing.js";
import {
  breakablePrefixes,
  type ComposerDraftPlan,
  type DraftWrapOptions,
  estimatedClusterWidth,
  measuredClusterWidths,
  planDraftStreamingPrefix,
  planDraftText,
  planDraftTexts,
  type StreamingWrapState,
  sameVisualLines,
  streamingWrapStates,
} from "./draft-wrap.js";
import { draftGraphemeCount, draftGraphemes } from "./graphemes.js";
import type { MessageTiming } from "./timeline.js";

export type { ComposerDraftPlan, DraftWrapOptions } from "./draft-wrap.js";
export { DRAFT_FONT_FEATURES, planDraftText } from "./draft-wrap.js";

export type DraftLayoutSnapshot = {
  showMs: number;
  hideMs: number | null;
  phase: DraftPhase;
  text: string;
  plan: ComposerDraftPlan;
};

export type DraftLayoutSequence = {
  snapshots: DraftLayoutSnapshot[];
  lineStates: Array<{ atMs: number; lineCount: number }>;
  maxLineCount: number;
};

export function draftClusterVisibleMs(
  phase: DraftPhase,
  cluster: number,
  charsPerSecond: number,
): number {
  const typed = phase.typed;
  if (typed === undefined || cluster < typed.from || cluster >= typed.to) {
    return phase.showMs;
  }
  return typed.startMs + ((cluster - typed.from) / charsPerSecond) * 1_000;
}

export function visibleDraftPrefixLength(
  phase: DraftPhase,
  charsPerSecond: number,
  atMs: number,
): number {
  const length = draftGraphemeCount(phase.text);
  const typed = phase.typed;
  if (typed === undefined) {
    return length;
  }
  if (atMs < typed.startMs) {
    return typed.from;
  }
  const revealed = Math.floor(((atMs - typed.startMs) / 1_000) * charsPerSecond + 1e-7) + 1;
  return Math.min(length, typed.to, typed.from + Math.max(0, revealed));
}

function transitionTimeMs(phase: DraftPhase, prefixLength: number, charsPerSecond: number): number {
  const typed = phase.typed;
  if (typed === undefined || prefixLength <= typed.from) {
    return phase.showMs;
  }
  return typed.startMs + ((prefixLength - typed.from - 1) / charsPerSecond) * 1_000;
}

type PlanMany = (texts: readonly string[]) => Map<string, ComposerDraftPlan>;

/** Exact fallback, searched in batched engine rounds when streaming differs. */
function exactPhaseLineStates(options: {
  phase: DraftPhase;
  charsPerSecond: number;
  planMany: PlanMany;
}): Array<{ atMs: number; lineCount: number; prefixLength: number }> {
  const { phase, charsPerSecond, planMany } = options;
  const clusters = draftGraphemes(phase.text);
  const textAt = (length: number): string => clusters.slice(0, length).join("");
  const firstLength = visibleDraftPrefixLength(phase, charsPerSecond, phase.showMs);
  const firstText = textAt(firstLength);
  const initialPlans = planMany([firstText, phase.text]);
  const firstCount = initialPlans.get(firstText)?.lines.length ?? 1;
  const finalCount = initialPlans.get(phase.text)?.lines.length ?? firstCount;
  const states = [{ atMs: phase.showMs, lineCount: firstCount, prefixLength: firstLength }];
  if (phase.typed === undefined || finalCount <= firstCount) {
    return states;
  }

  const searches = Array.from({ length: finalCount - firstCount }, (_unused, index) => ({
    targetCount: firstCount + index + 1,
    low: firstLength,
    high: clusters.length,
  }));
  while (searches.some((search) => search.high - search.low > 1)) {
    const active = searches.filter((search) => search.high - search.low > 1);
    const middleByTarget = new Map<number, number>();
    for (const search of active) {
      middleByTarget.set(search.targetCount, Math.floor((search.low + search.high) / 2));
    }
    const roundPlans = planMany(
      [...new Set(middleByTarget.values())].map((length) => textAt(length)),
    );
    for (const search of active) {
      const middle = middleByTarget.get(search.targetCount);
      if (middle === undefined) {
        continue;
      }
      const lineCount = roundPlans.get(textAt(middle))?.lines.length ?? 1;
      if (lineCount >= search.targetCount) {
        search.high = middle;
      } else {
        search.low = middle;
      }
    }
  }
  for (const search of searches) {
    states.push({
      atMs: transitionTimeMs(phase, search.high, charsPerSecond),
      lineCount: search.targetCount,
      prefixLength: search.high,
    });
  }
  return states;
}

type TimedStreamingState = StreamingWrapState & { atMs: number; lineCount: number };

function streamingPhaseStates(options: {
  phase: DraftPhase;
  charsPerSecond: number;
  wrap: DraftWrapOptions;
  fullPlan: ComposerDraftPlan;
}): TimedStreamingState[] | null {
  const { phase, charsPerSecond, wrap, fullPlan } = options;
  const clusters = draftGraphemes(phase.text);
  const widths = wrap.engine
    ? measuredClusterWidths(wrap.engine, phase.text, wrap)
    : clusters.map((cluster) => (cluster === "\n" ? 0 : estimatedClusterWidth(cluster, wrap)));
  const allStates = streamingWrapStates({
    clusters,
    widths,
    breakAfter: breakablePrefixes(clusters),
    widthPx: wrap.widthPx,
  });
  const finalState = allStates.at(-1) ?? { prefixLength: 0, lineStarts: [0] };
  const streamingFinal = planDraftStreamingPrefix({
    clusters,
    prefixLength: clusters.length,
    lineStarts: finalState.lineStarts,
  });
  if (!sameVisualLines(streamingFinal, fullPlan)) {
    return null;
  }
  const firstLength = visibleDraftPrefixLength(phase, charsPerSecond, phase.showMs);
  const initial =
    [...allStates].reverse().find((state) => state.prefixLength <= firstLength) ?? allStates[0];
  if (initial === undefined) {
    return null;
  }
  const states: TimedStreamingState[] = [
    {
      ...initial,
      prefixLength: firstLength,
      atMs: phase.showMs,
      lineCount: initial.lineStarts.length,
    },
  ];
  if (phase.typed === undefined) {
    return states;
  }
  for (const state of allStates) {
    if (state.prefixLength <= firstLength) {
      continue;
    }
    states.push({
      ...state,
      atMs: transitionTimeMs(phase, state.prefixLength, charsPerSecond),
      lineCount: state.lineStarts.length,
    });
  }
  return states;
}

function planPhaseSnapshots(options: {
  phase: DraftPhase;
  charsPerSecond: number;
  wrap: DraftWrapOptions;
  planMany: PlanMany;
}): {
  snapshots: DraftLayoutSnapshot[];
  lineStates: Array<{ atMs: number; lineCount: number }>;
} {
  const { phase, charsPerSecond, wrap, planMany } = options;
  const clusters = draftGraphemes(phase.text);
  const fullPlan = planMany([phase.text]).get(phase.text);
  const streaming =
    fullPlan === undefined ? null : streamingPhaseStates({ phase, charsPerSecond, wrap, fullPlan });
  if (streaming !== null) {
    const snapshots = streaming.map((state, index): DraftLayoutSnapshot => {
      const next = streaming[index + 1];
      const prefixLength = next
        ? Math.max(state.prefixLength, next.prefixLength - 1)
        : clusters.length;
      return {
        showMs: state.atMs,
        hideMs: next?.atMs ?? phase.hideMs,
        phase,
        text: clusters.slice(0, prefixLength).join(""),
        plan: planDraftStreamingPrefix({
          clusters,
          prefixLength,
          lineStarts: state.lineStarts,
        }),
      };
    });
    return {
      snapshots,
      lineStates: streaming.map(({ atMs, lineCount }) => ({ atMs, lineCount })),
    };
  }

  const states = exactPhaseLineStates({ phase, charsPerSecond, planMany });
  const snapshotStates = states.map((state, index) => {
    const next = states[index + 1];
    const prefixLength = next
      ? Math.max(state.prefixLength, next.prefixLength - 1)
      : clusters.length;
    return { state, next, text: clusters.slice(0, prefixLength).join("") };
  });
  const snapshotPlans = planMany(snapshotStates.map(({ text }) => text));
  return {
    snapshots: snapshotStates.flatMap(({ state, next, text }): DraftLayoutSnapshot[] => {
      const plan = snapshotPlans.get(text);
      return plan === undefined
        ? []
        : [{ showMs: state.atMs, hideMs: next?.atMs ?? phase.hideMs, phase, text, plan }];
    }),
    lineStates: states.map(({ atMs, lineCount }) => ({ atMs, lineCount })),
  };
}

/**
 * Every reflow state visible while the draft is keyed or replaced. App and
 * TUI share these states; only their row motion and underline paint differ.
 */
export function planDraftLayoutSequence(options: {
  draft: ResolvedDraftTyping;
  wrap: DraftWrapOptions;
}): DraftLayoutSequence {
  const { draft, wrap } = options;
  const planCache = new Map<string, ComposerDraftPlan>();
  const planMany: PlanMany = (texts) => {
    const missing = [...new Set(texts)].filter((text) => !planCache.has(text));
    if (missing.length > 0) {
      for (const [text, plan] of planDraftTexts(missing, wrap)) {
        planCache.set(text, plan);
      }
    }
    return new Map(
      texts.flatMap((text) => {
        const plan = planCache.get(text);
        return plan === undefined ? [] : [[text, plan] as const];
      }),
    );
  };
  const snapshots: DraftLayoutSnapshot[] = [];
  const lineStates: Array<{ atMs: number; lineCount: number }> = [];
  for (const phase of draft.phases) {
    const planned = planPhaseSnapshots({
      phase,
      charsPerSecond: draft.charsPerSecond,
      wrap,
      planMany,
    });
    snapshots.push(...planned.snapshots);
    lineStates.push(...planned.lineStates);
  }
  const maxLineCount = lineStates.reduce((maximum, state) => Math.max(maximum, state.lineCount), 1);
  return { snapshots, lineStates, maxLineCount };
}

/** Finished layout plus exact prefix transition times for legacy consumers. */
export function planComposerDraft(
  timing: MessageTiming,
  wrap: DraftWrapOptions,
): ComposerDraftPlan {
  const draft = timing.draft;
  const text = draft?.program.finalText ?? timing.message.content;
  const plan = planDraftText(text, wrap);
  if (draft === undefined) {
    return plan;
  }
  const sequence = planDraftLayoutSequence({ draft, wrap });
  return {
    ...plan,
    newlineTimesMs: sequence.lineStates
      .filter((state, index, states) => state.lineCount > (states[index - 1]?.lineCount ?? 1))
      .map((state) => state.atMs),
  };
}
