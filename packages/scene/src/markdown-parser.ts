import type { MarkdownBlock, MarkdownInline } from "./markdown-model.js";

/**
 * What a Markdown parser adapter provides. Both entries take the source text
 * and return svgent's own tree, synchronously and without touching the DOM,
 * the clock, or the locale. Library types stay behind this line.
 */
export type MarkdownParser = {
  parse: (source: string) => MarkdownBlock[];
  parseInline: (source: string) => MarkdownInline[];
};
