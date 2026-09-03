import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AnyVNode } from "@boundsvg/core";
import type { SvgentProject } from "@svgent/scene";
import { buildSvgentScene, DEFAULT_PROJECT, deserializeProject } from "@svgent/scene";
import { describe, expect, it } from "vitest";
import { planDraftTyping } from "../src/composer.js";
import { draftClusterVisibleMs } from "../src/draft-layout.js";
import { draftGraphemeCount } from "../src/graphemes.js";

/**
 * The draft's staging is a timeline and a geometry, and both fail in ways a
 * rendered frame does not show unless it is sampled at exactly the wrong
 * moment: a window that no phase covers blanks the draft, a mark that opens
 * before its key runs ahead of the text, marks drawn side by side leave a
 * hole. Sampling frames found each of these only after they shipped, so the
 * properties are asserted over every script instead.
 */

const EXAMPLES = path.join(__dirname, "../../../examples");

function scripts(): Array<{ name: string; project: SvgentProject }> {
  return readdirSync(EXAMPLES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const parsed = deserializeProject(readFileSync(path.join(EXAMPLES, name), "utf8"));
      return { name, project: (parsed as { project?: SvgentProject }).project ?? DEFAULT_PROJECT };
    })
    .filter((entry) => entry.project.messages.length > 0);
}

/** Sibling marks: anything thin enough to be a rule, drawn under one parent. */
type Mark = { left: number; width: number; top: number; openMs: number; closeMs: number };

function markGroups(root: AnyVNode): Mark[][] {
  const groups: Mark[][] = [];
  const walk = (node: AnyVNode): void => {
    const children = ((node as { children?: unknown[] }).children ?? []).filter(
      (child): child is AnyVNode => typeof child === "object" && child !== null,
    );
    const marks = children
      .map((child) => (child as { props?: Record<string, unknown> }).props ?? {})
      .filter(
        (props) =>
          typeof props.left === "number" &&
          typeof props.width === "number" &&
          typeof props.top === "number" &&
          ((props.height as number | undefined) ?? 99) <= 6,
      )
      .map((props) => {
        const track = props.animate as { delayMs?: number; durationMs?: number } | undefined;
        const openMs = track?.delayMs ?? 0;
        return {
          left: props.left as number,
          width: props.width as number,
          top: Math.round(props.top as number),
          openMs,
          closeMs: openMs + (track?.durationMs ?? Number.POSITIVE_INFINITY),
        };
      });
    if (marks.length > 1) {
      groups.push(marks);
    }
    for (const child of children) {
      walk(child);
    }
  };
  walk(root);
  return groups;
}

/** Every mark drawn at one instant, row by row, left to right. */
function rowsAt(marks: Mark[], atMs: number): Mark[][] {
  const rows = new Map<number, Mark[]>();
  for (const mark of marks) {
    if (mark.openMs > atMs || mark.closeMs < atMs) {
      continue;
    }
    rows.set(mark.top, [...(rows.get(mark.top) ?? []), mark]);
  }
  return [...rows.values()].map((row) => [...row].sort((left, right) => left.left - right.left));
}

function expectContiguousAt(marks: Mark[], atMs: number): void {
  for (const row of rowsAt(marks, atMs)) {
    for (let index = 0; index < row.length - 1; index += 1) {
      const previous = row[index];
      const next = row[index + 1];
      if (previous === undefined || next === undefined) {
        continue;
      }
      // Adjacent marks belong to adjacent cells: a hole between them is a rule
      // that looks broken, not a dash pattern.
      expect(
        next.left - (previous.left + previous.width),
        `a hole at ${atMs}ms between ${previous.left} and ${next.left}`,
      ).toBeLessThanOrEqual(1.5);
    }
  }
}

describe("draft staging invariants", () => {
  const cases = scripts();

  it.each(cases)("$name tiles its draft phases without a gap", ({ project }) => {
    for (const message of project.messages) {
      if (message.role !== "user") {
        continue;
      }
      const phases = planDraftTyping({
        content: message.content,
        startMs: 0,
        charsPerSecond: project.timing.userTypingCps,
      });
      for (let index = 0; index < phases.length - 1; index += 1) {
        const ends = phases[index]?.hideMs;
        const opens = phases[index + 1]?.showMs ?? 0;
        expect(ends, `${message.id} phase ${index} has no end`).not.toBeNull();
        // A hole here is a draft that blanks out while the author is typing.
        expect(Math.abs((ends ?? 0) - opens)).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it.each(cases)("$name never marks a character before it is keyed", ({ project }) => {
    for (const message of project.messages) {
      if (message.role !== "user") {
        continue;
      }
      const phases = planDraftTyping({
        content: message.content,
        startMs: 0,
        charsPerSecond: project.timing.userTypingCps,
      });
      for (const phase of phases ?? []) {
        if (phase.composing === undefined) {
          continue;
        }
        expect(phase.composing.to).toBeLessThanOrEqual(draftGraphemeCount(phase.text));
        // The kana is keyed inside its own window; the written form arrives whole.
        const keyedAt = draftClusterVisibleMs(
          phase,
          Math.max(phase.composing.from, phase.composing.to - 1),
          project.timing.userTypingCps,
        );
        if (!phase.composing.settled) {
          expect(keyedAt).toBeLessThanOrEqual((phase.hideMs ?? Number.POSITIVE_INFINITY) + 1);
        }
      }
    }
  });

  it.each(cases)("$name draws each rule as one unbroken run", ({ project }) => {
    for (const marks of markGroups(buildSvgentScene(project, 0).vnode)) {
      // A rule is what is on screen together. Marks from two phases share a
      // parent and a row while standing for different states of the draft, so
      // contiguity is a claim about an instant, not about the whole group.
      for (const mark of marks) {
        expectContiguousAt(marks, mark.openMs + 2);
      }
    }
  });
});
