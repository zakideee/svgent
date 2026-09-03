import { collectGraphemes, countGraphemes } from "unicode-segmenter/grapheme";

/**
 * One deterministic text unit, shared by timeline planning and boundsvg's
 * cluster-based reveal. The dependency carries its own Unicode tables, so the
 * result cannot change with a browser or Node ICU build.
 */
export function draftGraphemes(text: string): string[] {
  return collectGraphemes(text);
}

/** Count the same extended grapheme clusters that {@link draftGraphemes} returns. */
export function draftGraphemeCount(text: string): number {
  return countGraphemes(text);
}
