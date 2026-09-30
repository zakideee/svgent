/**
 * The public Markdown entry points. The parser adapter is chosen here, once;
 * everything returned is svgent's own tree from `markdown-model.ts`.
 */

import { markedParser } from "./markdown-marked-adapter.js";
import type { MarkdownBlock, MarkdownInline } from "./markdown-model.js";
import type { MarkdownParser } from "./markdown-parser.js";
import { blocksPlainText, blocksRevealLength } from "./markdown-traversal.js";

export { type HighlightRun, highlightCode } from "./markdown-highlight.js";
export type {
  InlineRun,
  MarkdownBlock,
  MarkdownInline,
  MarkdownListItem,
  MarkdownTableAlignment,
  MarkdownTableCell,
  MarkdownTaskState,
} from "./markdown-model.js";

const PARSER: MarkdownParser = markedParser;

function normalizeLineEndings(source: string): string {
  return source.replace(/\r\n?/gu, "\n");
}

/**
 * Parse a message body. Empty or blank input, and input that only defines
 * links, becomes one paragraph holding empty text.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks = PARSER.parse(normalizeLineEndings(source));
  return blocks.length > 0
    ? blocks
    : [{ type: "paragraph", children: [{ type: "text", text: "" }] }];
}

/** Parse one line of inline Markdown. Link references are not resolved here. */
export function parseInlineMarkdown(source: string): MarkdownInline[] {
  return PARSER.parseInline(normalizeLineEndings(source));
}

/** The text a tree displays: blocks and list items per line, table cells tab-separated. */
export function markdownPlainText(blocks: MarkdownBlock[]): string {
  return blocksPlainText(blocks);
}

/**
 * Reveal ticks a Markdown body spends when the renderer streams it. The
 * timeline budgets a message's default duration from this, so a message is
 * never declared finished while part of it is still being revealed.
 */
export function markdownRevealCharacters(content: string): number {
  return blocksRevealLength(parseMarkdown(content));
}
