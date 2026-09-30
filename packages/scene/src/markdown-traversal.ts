/**
 * What a Markdown tree displays, and how many reveal ticks it spends.
 *
 * The renderer, the timeline, and plain-text extraction all read these
 * functions, so a message's default duration always covers exactly the text
 * the renderer streams, and the link arrow or image label is decided once for
 * every consumer instead of by each parser adapter.
 *
 * A tick is one code point of displayed text (`Array.from(text).length`), plus
 * one at every line boundary the renderer paces: a hard break, a code line, a
 * list item, a table cell.
 */

import type {
  MarkdownBlock,
  MarkdownInline,
  MarkdownListItem,
  MarkdownTableCell,
} from "./markdown-model.js";

/** How a displayed run is drawn. Marks combine; `kind` decides the typeface. */
export type DisplayRun = {
  text: string;
  kind: "text" | "code" | "image" | "literal";
  strong: boolean;
  emphasis: boolean;
  strikethrough: boolean;
  link: boolean;
};

/** One visual line of an inline sequence; hard breaks separate lines. */
export type DisplayLine = DisplayRun[];

/** Appended once after every link label. */
const LINK_ARROW = " ↗";
/** Stands in for a Markdown image, followed by its alt text. */
const IMAGE_LABEL = "[image]";

type Marks = Pick<DisplayRun, "strong" | "emphasis" | "strikethrough" | "link">;

const NO_MARKS: Marks = { strong: false, emphasis: false, strikethrough: false, link: false };

export function codePointLength(text: string): number {
  let count = 0;
  for (const _codePoint of text) {
    count += 1;
  }
  return count;
}

/**
 * Inline text is drawn with whitespace collapsed: a run of spaces or tabs
 * shows as one space, including across two runs, and a line's own ends drop
 * theirs (`trimLine`). Doing it here keeps the displayed text, and the ticks
 * counted from it, identical to what the engine reveals, one cluster at a time.
 */
function collapseWhitespace(text: string, line: DisplayLine | undefined): string {
  const collapsed = text.replace(/[ \t\n]+/gu, " ");
  return collapsed.startsWith(" ") && line?.at(-1)?.text.endsWith(" ")
    ? collapsed.slice(1)
    : collapsed;
}

function pushRun(lines: DisplayLine[], raw: DisplayRun): void {
  const line = lines.at(-1);
  const run = { ...raw, text: collapseWhitespace(raw.text, line) };
  if (run.text.length === 0) {
    return;
  }
  const previous = line?.at(-1);
  if (
    previous !== undefined &&
    previous.kind === run.kind &&
    previous.strong === run.strong &&
    previous.emphasis === run.emphasis &&
    previous.strikethrough === run.strikethrough &&
    previous.link === run.link
  ) {
    previous.text += run.text;
    return;
  }
  line?.push(run);
}

function walkInlines(inlines: MarkdownInline[], marks: Marks, lines: DisplayLine[]): void {
  for (const inline of inlines) {
    switch (inline.type) {
      case "text":
        pushRun(lines, { text: inline.text, kind: "text", ...marks });
        break;
      case "code":
        pushRun(lines, { text: inline.text, kind: "code", ...marks });
        break;
      case "literal":
        // Written line breaks stay line breaks.
        inline.text.split("\n").forEach((part, index) => {
          if (index > 0) {
            lines.push([]);
          }
          pushRun(lines, { text: part, kind: "literal", ...marks });
        });
        break;
      case "image":
        pushRun(lines, {
          text: inline.alt.length > 0 ? `${IMAGE_LABEL} ${inline.alt}` : IMAGE_LABEL,
          kind: "image",
          ...marks,
        });
        break;
      case "softBreak":
        pushRun(lines, { text: " ", kind: "text", ...marks });
        break;
      case "hardBreak":
        lines.push([]);
        break;
      case "strong":
        walkInlines(inline.children, { ...marks, strong: true }, lines);
        break;
      case "emphasis":
        walkInlines(inline.children, { ...marks, emphasis: true }, lines);
        break;
      case "strikethrough":
        walkInlines(inline.children, { ...marks, strikethrough: true }, lines);
        break;
      case "link":
        walkInlines(inline.children, { ...marks, link: true }, lines);
        pushRun(lines, { text: LINK_ARROW, kind: "text", ...marks, link: true });
        break;
    }
  }
}

/** A line's blanks at either end are not drawn; the engine drops them too. */
function trimLine(line: DisplayLine): DisplayLine {
  const trimmed = line.map((run) => ({ ...run }));
  const first = trimmed[0];
  if (first !== undefined) {
    first.text = first.text.replace(/^ +/u, "");
  }
  const last = trimmed.at(-1);
  if (last !== undefined) {
    last.text = last.text.replace(/ +$/u, "");
  }
  return trimmed.filter((run) => run.text.length > 0);
}

function buildDisplayLines(inlines: MarkdownInline[]): DisplayLine[] {
  const lines: DisplayLine[] = [[]];
  walkInlines(inlines, NO_MARKS, lines);
  return lines.map(trimLine);
}

/**
 * Cached per node for the renderer, which reads the same tree many times while
 * building one scene and never changes it. Plain-text extraction takes trees
 * from callers and does not use these caches.
 */
const displayLineCache = new WeakMap<MarkdownInline[], DisplayLine[]>();

/** The runs an inline sequence draws, split at its hard breaks. */
export function markdownDisplayLines(inlines: MarkdownInline[]): DisplayLine[] {
  const cached = displayLineCache.get(inlines);
  if (cached !== undefined) {
    return cached;
  }
  const lines = buildDisplayLines(inlines);
  displayLineCache.set(inlines, lines);
  return lines;
}

/** Ticks one display line spends. */
export function displayLineLength(line: DisplayLine): number {
  return line.reduce((sum, run) => sum + codePointLength(run.text), 0);
}

/** Ticks an inline sequence spends: its code points, one per hard break. */
function inlineRevealLength(inlines: MarkdownInline[]): number {
  const lines = markdownDisplayLines(inlines);
  return lines.reduce((sum, line) => sum + displayLineLength(line), 0) + lines.length - 1;
}

function inlinePlainText(inlines: MarkdownInline[]): string {
  return buildDisplayLines(inlines)
    .map((line) => line.map((run) => run.text).join(""))
    .join("\n");
}

/** The lines of a code block. An empty block still has one. */
function codeLines(text: string): string[] {
  return text.split("\n");
}

/** Every table row, header first, each padded to the header's columns. */
export function tableRows(block: Extract<MarkdownBlock, { type: "table" }>): MarkdownTableCell[][] {
  return [block.header, ...block.rows];
}

const blockLengthCache = new WeakMap<MarkdownBlock | MarkdownListItem, number>();

function listItemRevealLength(item: MarkdownListItem): number {
  const cached = blockLengthCache.get(item);
  if (cached !== undefined) {
    return cached;
  }
  const length = blocksRevealLength(item.children) + 1;
  blockLengthCache.set(item, length);
  return length;
}

/** Ticks one list item spends: its content and one for the item itself. */
export function markdownListItemRevealLength(item: MarkdownListItem): number {
  return listItemRevealLength(item);
}

/** Ticks one table cell spends: its content and one for the cell itself. */
export function tableCellRevealLength(cell: MarkdownTableCell): number {
  return inlineRevealLength(cell) + 1;
}

/** Ticks one block spends. Cached per node, so nested sums stay linear. */
export function markdownBlockRevealLength(block: MarkdownBlock): number {
  const cached = blockLengthCache.get(block);
  if (cached !== undefined) {
    return cached;
  }
  let length: number;
  switch (block.type) {
    case "heading":
    case "paragraph":
      length = inlineRevealLength(block.children);
      break;
    case "code":
      length = codeLines(block.text).reduce((sum, line) => sum + codePointLength(line) + 1, 0);
      break;
    case "list":
      length = block.items.reduce((sum, item) => sum + listItemRevealLength(item), 0);
      break;
    case "quote":
      length = blocksRevealLength(block.children);
      break;
    case "rule":
      length = 1;
      break;
    case "table":
      length = tableRows(block).reduce(
        (sum, row) => sum + row.reduce((rowSum, cell) => rowSum + tableCellRevealLength(cell), 0),
        0,
      );
      break;
    case "literal":
      length = codePointLength(block.text);
      break;
  }
  blockLengthCache.set(block, length);
  return length;
}

export function blocksRevealLength(blocks: MarkdownBlock[]): number {
  return blocks.reduce((sum, block) => sum + markdownBlockRevealLength(block), 0);
}

function blockPlainText(block: MarkdownBlock): string {
  switch (block.type) {
    case "heading":
    case "paragraph":
      return inlinePlainText(block.children);
    case "code":
    case "literal":
      return block.text;
    case "list":
      return block.items.map((item) => blocksPlainText(item.children)).join("\n");
    case "quote":
      return blocksPlainText(block.children);
    case "rule":
      return "";
    case "table":
      return tableRows(block)
        .map((row) => row.map(inlinePlainText).join("\t"))
        .join("\n");
  }
}

/**
 * The text a tree displays, without its markers. Blocks, list items and table
 * rows end at a line break; table cells are separated by a tab.
 */
export function blocksPlainText(blocks: MarkdownBlock[]): string {
  return blocks.map(blockPlainText).join("\n");
}
