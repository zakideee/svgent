/**
 * The Markdown tree svgent renders, times, and extracts text from.
 *
 * svgent owns this shape. A parser adapter translates its library's tokens
 * into it, and nothing downstream sees those tokens, so replacing the parser
 * changes the adapter and leaves the renderer, the timeline, and measurement
 * alone.
 *
 * The tree keeps what the scene draws and nothing it does not: no link
 * destinations or titles, no image sources, no source positions.
 */

/** Inline content. Marks nest, so combined styles stay intact. */
export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "emphasis"; children: MarkdownInline[] }
  | { type: "strikethrough"; children: MarkdownInline[] }
  | { type: "code"; text: string }
  /** A resolved link: its label only. The arrow is added at display time. */
  | { type: "link"; children: MarkdownInline[] }
  /** A Markdown image, shown as a label; the image itself is never fetched. */
  | { type: "image"; alt: string }
  | { type: "softBreak" }
  | { type: "hardBreak" }
  /** Text shown exactly as written: raw HTML and unsupported syntax. */
  | { type: "literal"; text: string };

/** Same union under its earlier name. */
export type InlineRun = MarkdownInline;

/** `null` is an unspecified column, drawn left-aligned. */
export type MarkdownTableAlignment = "left" | "center" | "right" | null;

export type MarkdownTaskState = "checked" | "unchecked" | null;

export type MarkdownListItem = {
  /** `null` for an ordinary item, otherwise the checkbox it opens with. */
  task: MarkdownTaskState;
  /** Empty for an empty item, which still keeps its place in the list. */
  children: MarkdownBlock[];
};

export type MarkdownTableCell = MarkdownInline[];

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInline[] }
  | { type: "paragraph"; children: MarkdownInline[] }
  | {
      type: "list";
      ordered: boolean;
      /** First item's number; 1 for unordered lists. */
      start: number;
      /** A loose list separates its items with space. */
      loose: boolean;
      items: MarkdownListItem[];
    }
  | { type: "quote"; children: MarkdownBlock[] }
  /** `language` is the first word of the info string, `text` if none. */
  | { type: "code"; language: string; text: string }
  | { type: "rule" }
  | {
      type: "table";
      align: MarkdownTableAlignment[];
      /** One cell per column. */
      header: MarkdownTableCell[];
      /** Every row has exactly as many cells as the header. */
      rows: MarkdownTableCell[][];
    }
  /** Text shown exactly as written, line breaks included. */
  | { type: "literal"; text: string };
