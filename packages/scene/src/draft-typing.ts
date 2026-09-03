import { draftGraphemeCount, draftGraphemes } from "./graphemes.js";
import { MAX_DRAFT_RUN_CLUSTERS, PASTE_TYPING_CPS, parseDraftSegments } from "./model.js";

/** Automatic floor for a normally paced composer reveal. */
export const MIN_DRAFT_REVEAL_MS = 420;
/** Pause between finishing a reading and replacing it with the converted form. */
export const IME_CONVERSION_MS = 380;
/** Hold on the converted form before the IME commits it. */
export const IME_COMMIT_MS = 260;
/**
 * Pause between the stub being keyed and the completion landing.
 *
 * This is how long the offer is on screen, so it has to be long enough to read
 * one. At 130ms the suggestion appeared and was gone inside a fifth of a
 * second, which reads as the completion fading in rather than as something
 * proposed and then taken. A real acceptance has the same beat: the suggestion
 * arrives, it is looked at, and only then is the key pressed.
 */
export const COMPLETION_ACCEPT_MS = 420;
/** App text needs this beat for its final cluster fade; TUI safely shares it. */
export const DRAFT_FINAL_REVEAL_MS = 180;

export type DraftCompositionRange = {
  from: number;
  to: number;
  settled: boolean;
};

export type DraftTypedRange = {
  /** Grapheme range that is keyed during this phase. */
  from: number;
  to: number;
  /** Moment the first grapheme in the range appears. */
  startMs: number;
};

export type DraftPhase = {
  /** Full draft text available during this phase. */
  text: string;
  showMs: number;
  hideMs: number | null;
  /** Settled prefix is static; only this suffix receives unit animation. */
  typed?: DraftTypedRange;
  composing?: DraftCompositionRange;
  /**
   * The rest of a completion, offered after the stub while the key that takes
   * it has not been pressed. It is not in `text`: it is what the composer is
   * proposing, drawn faintly, the way an editor shows what Tab would accept.
   */
  suggestion?: { atMs: number; text: string };
};

export type DraftTypingIssue = {
  code: "ime-run-too-long" | "duration-too-short";
  message: string;
};

type PlainOperation = { kind: "plain"; text: string };
type ImeOperation = { kind: "ime"; reading: string; written: string };
type CompletionOperation = { kind: "completion"; typed: string; written: string };
type DraftOperation = PlainOperation | ImeOperation | CompletionOperation;

export type DraftTypingProgram = {
  normalizedContent: string;
  finalText: string;
  operations: DraftOperation[];
  typedClusterCount: number;
  imeRunCount: number;
  completionCount: number;
  fixedPauseMs: number;
  issues: DraftTypingIssue[];
};

export type ResolvedDraftTyping = {
  program: DraftTypingProgram;
  mode: "typed" | "paste";
  startMs: number;
  /** Authored speed before a message-local duration override is resolved. */
  authoredCps: number;
  /** Speed actually used by every surface for this draft. */
  charsPerSecond: number;
  phases: DraftPhase[];
  typingEndMs: number;
  revealEndMs: number;
  activeDurationMs: number;
  naturalDurationMs: number;
  minimumDurationMs: number;
  durationClamped: boolean;
  issues: DraftTypingIssue[];
};

const RUN_CARRIES = /^[\u3040-\u30ff\uff66-\uff9f]+$/u;

/**
 * Normalize horizontal keyboard whitespace without erasing authored hard
 * newlines or fullwidth terminal cells.
 */
export function normalizeDraftSource(content: string): string {
  return content
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/gu, " ").replace(/^ +| +$/gu, ""))
    .join("\n");
}

function appendPlain(operations: DraftOperation[], text: string): void {
  if (text.length === 0) {
    return;
  }
  const last = operations.at(-1);
  if (last?.kind === "plain") {
    last.text += text;
    return;
  }
  operations.push({ kind: "plain", text });
}

/**
 * Parse once into the exact run structure used by duration and phase planning.
 * A space is a literal key after conversion, never part of the held run.
 */
export function analyzeDraftTyping(content: string): DraftTypingProgram {
  const normalizedContent = normalizeDraftSource(content);
  const operations: DraftOperation[] = [];
  const issues: DraftTypingIssue[] = [];
  let run: { reading: string; written: string; clusters: number } | null = null;

  const flushRun = (): void => {
    if (run === null) {
      return;
    }
    operations.push({ kind: "ime", reading: run.reading, written: run.written });
    run = null;
  };

  const keyPlain = (text: string): void => {
    for (const cluster of draftGraphemes(text)) {
      if (run !== null && RUN_CARRIES.test(cluster)) {
        if (run.clusters + 1 <= MAX_DRAFT_RUN_CLUSTERS) {
          run.reading += cluster;
          run.written += cluster;
          run.clusters += 1;
          if (run.clusters === MAX_DRAFT_RUN_CLUSTERS) {
            flushRun();
          }
          continue;
        }
        flushRun();
      } else if (run !== null) {
        flushRun();
      }
      appendPlain(operations, cluster);
    }
  };

  for (const segment of parseDraftSegments(normalizedContent)) {
    if (segment.typed === undefined) {
      keyPlain(segment.text);
      continue;
    }
    if (segment.kind === "ime") {
      const spanClusters = draftGraphemeCount(segment.typed);
      if (spanClusters > MAX_DRAFT_RUN_CLUSTERS) {
        issues.push({
          code: "ime-run-too-long",
          message: `IME reading has ${spanClusters} clusters; split it into spans of at most ${MAX_DRAFT_RUN_CLUSTERS}.`,
        });
      }
      if (run !== null && run.clusters + spanClusters > MAX_DRAFT_RUN_CLUSTERS) {
        flushRun();
      }
      run ??= { reading: "", written: "", clusters: 0 };
      run.reading += segment.typed;
      run.written += segment.text;
      run.clusters += spanClusters;
      if (run.clusters >= MAX_DRAFT_RUN_CLUSTERS) {
        flushRun();
      }
      continue;
    }
    flushRun();
    operations.push({ kind: "completion", typed: segment.typed, written: segment.text });
  }
  flushRun();

  const finalText = operations
    .map((operation) => (operation.kind === "plain" ? operation.text : operation.written))
    .join("");
  const typedClusterCount = operations.reduce((total, operation) => {
    if (operation.kind === "plain") {
      return total + draftGraphemeCount(operation.text);
    }
    return (
      total + draftGraphemeCount(operation.kind === "ime" ? operation.reading : operation.typed)
    );
  }, 0);
  const imeRunCount = operations.filter((operation) => operation.kind === "ime").length;
  const completionCount = operations.filter((operation) => operation.kind === "completion").length;
  const fixedPauseMs =
    imeRunCount * (IME_CONVERSION_MS + IME_COMMIT_MS) + completionCount * COMPLETION_ACCEPT_MS;
  return {
    normalizedContent,
    finalText,
    operations,
    typedClusterCount,
    imeRunCount,
    completionCount,
    fixedPauseMs,
    issues,
  };
}

function typedRange(from: number, to: number, startMs: number): DraftTypedRange | undefined {
  return to > from ? { from, to, startMs } : undefined;
}

function phasesFor(options: {
  program: DraftTypingProgram;
  startMs: number;
  charsPerSecond: number;
  mode: "typed" | "paste";
}): { phases: DraftPhase[]; typingEndMs: number } {
  const { program, startMs, charsPerSecond, mode } = options;
  if (mode === "paste") {
    return {
      phases: [{ text: program.finalText, showMs: startMs, hideMs: null }],
      typingEndMs: startMs,
    };
  }
  const perClusterMs = 1_000 / charsPerSecond;
  const phases: DraftPhase[] = [];
  let done = "";
  let cursorMs = startMs;
  let phaseStartMs = startMs;
  let phasePrefix = 0;

  const phaseTyping = (text: string): DraftTypedRange | undefined =>
    typedRange(phasePrefix, draftGraphemeCount(text), phaseStartMs);

  for (const operation of program.operations) {
    if (operation.kind === "plain") {
      done += operation.text;
      cursorMs += draftGraphemeCount(operation.text) * perClusterMs;
      continue;
    }
    if (operation.kind === "ime") {
      const from = draftGraphemeCount(done);
      const readingText = done + operation.reading;
      const typingEndMs = cursorMs + draftGraphemeCount(operation.reading) * perClusterMs;
      phases.push({
        text: readingText,
        showMs: phaseStartMs,
        hideMs: typingEndMs + IME_CONVERSION_MS,
        ...(phaseTyping(readingText) ? { typed: phaseTyping(readingText) } : {}),
        composing: {
          from,
          to: from + draftGraphemeCount(operation.reading),
          settled: false,
        },
      });
      const convertedAtMs = typingEndMs + IME_CONVERSION_MS;
      const writtenText = done + operation.written;
      phases.push({
        text: writtenText,
        showMs: convertedAtMs,
        hideMs: convertedAtMs + IME_COMMIT_MS,
        composing: {
          from,
          to: from + draftGraphemeCount(operation.written),
          settled: true,
        },
      });
      done = writtenText;
      cursorMs = convertedAtMs + IME_COMMIT_MS;
      phaseStartMs = cursorMs;
      phasePrefix = draftGraphemeCount(done);
      continue;
    }

    const stubText = done + operation.typed;
    const typingEndMs = cursorMs + draftGraphemeCount(operation.typed) * perClusterMs;
    phases.push({
      text: stubText,
      showMs: phaseStartMs,
      hideMs: typingEndMs + COMPLETION_ACCEPT_MS,
      ...(phaseTyping(stubText) ? { typed: phaseTyping(stubText) } : {}),
      // Offered once the stub is fully keyed, not before: there is nothing to
      // propose until the composer has seen what was typed.
      ...(operation.written.startsWith(operation.typed)
        ? {
            suggestion: {
              atMs: typingEndMs,
              text: operation.written.slice(operation.typed.length),
            },
          }
        : {}),
    });
    done += operation.written;
    cursorMs = typingEndMs + COMPLETION_ACCEPT_MS;
    phaseStartMs = cursorMs;
    phasePrefix = draftGraphemeCount(done);
  }

  const finalTyped = phaseTyping(done);
  phases.push({
    text: done,
    showMs: phaseStartMs,
    hideMs: null,
    ...(finalTyped ? { typed: finalTyped } : {}),
  });
  return { phases, typingEndMs: cursorMs };
}

/**
 * Resolve an authored draft into one clock shared by timeline, App, and TUI.
 * A short explicit duration speeds only this message up; it never changes a
 * typed draft into a paste. Impossible overrides are reported and clamped to
 * the shortest physically representable sequence.
 */
export function resolveDraftTyping(options: {
  content: string;
  startMs: number;
  authoredCps: number;
  durationMs?: number;
}): ResolvedDraftTyping {
  const { content, startMs, authoredCps, durationMs } = options;
  const program = analyzeDraftTyping(content);
  const mode = authoredCps >= PASTE_TYPING_CPS ? "paste" : "typed";
  const naturalTypingMs =
    mode === "paste" ? 0 : (program.typedClusterCount / authoredCps) * 1_000 + program.fixedPauseMs;
  const naturalDurationMs = Math.max(MIN_DRAFT_REVEAL_MS, naturalTypingMs) + DRAFT_FINAL_REVEAL_MS;
  const minimumDurationMs =
    mode === "paste"
      ? 1
      : program.fixedPauseMs + DRAFT_FINAL_REVEAL_MS + (program.typedClusterCount > 0 ? 1 : 0);
  let activeDurationMs = durationMs ?? naturalDurationMs;
  let charsPerSecond = authoredCps;
  let durationClamped = false;
  const issues = [...program.issues];

  if (durationMs !== undefined && mode === "typed" && durationMs < naturalDurationMs) {
    const typingBudgetMs = durationMs - program.fixedPauseMs - DRAFT_FINAL_REVEAL_MS;
    if (program.typedClusterCount > 0 && typingBudgetMs > 0) {
      charsPerSecond = (program.typedClusterCount * 1_000) / typingBudgetMs;
    } else if (program.typedClusterCount === 0 && durationMs >= program.fixedPauseMs) {
      charsPerSecond = authoredCps;
    } else {
      activeDurationMs = minimumDurationMs;
      durationClamped = true;
      charsPerSecond = Math.max(authoredCps, program.typedClusterCount * 1_000);
      issues.push({
        code: "duration-too-short",
        message: `Draft duration ${durationMs}ms is shorter than its ${minimumDurationMs}ms fixed typing sequence.`,
      });
    }
  }

  const planned = phasesFor({ program, startMs, charsPerSecond, mode });
  const requiredDurationMs = planned.typingEndMs - startMs + DRAFT_FINAL_REVEAL_MS;
  if (activeDurationMs < requiredDurationMs) {
    activeDurationMs = requiredDurationMs;
    durationClamped = true;
  }
  return {
    program,
    mode,
    startMs,
    authoredCps,
    charsPerSecond,
    phases: planned.phases,
    typingEndMs: planned.typingEndMs,
    revealEndMs: startMs + activeDurationMs,
    activeDurationMs,
    naturalDurationMs,
    minimumDurationMs,
    durationClamped,
    issues,
  };
}

/** Compatibility-sized phase accessor for consumers that do not need duration metadata. */
export function planDraftTyping(options: {
  content: string;
  startMs: number;
  charsPerSecond: number;
}): DraftPhase[] {
  return resolveDraftTyping({
    content: options.content,
    startMs: options.startMs,
    authoredCps: options.charsPerSecond,
  }).phases;
}
