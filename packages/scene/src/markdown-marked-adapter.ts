/**
 * Marked, behind svgent's Markdown tree.
 *
 * Everything Marked-specific lives in this file: the import, the instance and
 * its options, the lexer calls, and the corrections that turn Marked's tokens
 * into the tree `markdown-model.ts` defines. The rest of the scene reads that
 * tree and never a token, so a later parser only has to replace this file.
 */

import { characterEntities } from "character-entities";
import { Lexer, Marked, type Token, type TokenizerExtension, type Tokens } from "marked";
import type {
  MarkdownBlock,
  MarkdownInline,
  MarkdownListItem,
  MarkdownTableAlignment,
} from "./markdown-model.js";
import type { MarkdownParser } from "./markdown-parser.js";

// ————————————————————————————————————————————————————————————————————————————
// Footnotes stay text
//
// Footnote layout is not supported, so a footnote reference and its definition
// are shown as written. Without these tokenizers Marked reads `[^1]: Note` as
// an ordinary link definition, hides it, and turns every `[^1]` into a link.
// Both run where Marked would otherwise read the text, so code spans, fences
// and escapes keep their usual meaning.
// ————————————————————————————————————————————————————————————————————————————

const FOOTNOTE_LABEL = String.raw`\[\^[^\]\s]+\]`;
/** A footnote reference at the start of the remaining inline source. */
const FOOTNOTE_REFERENCE = new RegExp(`^${FOOTNOTE_LABEL}`, "u");
/** A footnote definition line, indented at most three spaces as block syntax allows. */
const FOOTNOTE_DEFINITION = new RegExp(`^ {0,3}${FOOTNOTE_LABEL}:[^\\n]*(?:\\n|$)`, "u");
/** A line that starts a block of its own and so ends a lazy continuation. */
const BLOCK_START = /^ {0,3}(?:[#>*+|-]|\d{1,9}[.)]|`{3}|~{3}|\[\^)/u;
/** A line indented enough to continue a footnote after a blank line. */
const INDENTED = /^(?: {4}|\t)/u;
/** A line with nothing but spaces or tabs. */
const BLANK = /^[ \t]*$/u;

type LiteralToken = { type: string; raw: string; text: string };

/** The line at the start of `source`, with its newline if it has one. */
function firstLine(source: string): string {
  const end = source.indexOf("\n");
  return end === -1 ? source : source.slice(0, end + 1);
}

/** Blank lines at the start of `source`, and what follows them. */
function splitBlankLines(source: string): { blanks: string; rest: string } {
  let blanks = "";
  let rest = source;
  while (rest.length > 0) {
    const line = firstLine(rest);
    if (!BLANK.test(line.replace(/\n$/u, ""))) {
      break;
    }
    blanks += line;
    rest = rest.slice(line.length);
  }
  return { blanks, rest };
}

/**
 * The definition line, the lines that lazily continue it, and after blank
 * lines any indented lines that still belong to it.
 */
function readFootnoteDefinition(source: string): LiteralToken | undefined {
  const first = FOOTNOTE_DEFINITION.exec(source);
  if (!first) {
    return undefined;
  }
  let raw = first[0];
  let rest = source.slice(raw.length);
  let afterBlank = false;
  while (rest.length > 0 && raw.endsWith("\n")) {
    const line = firstLine(rest);
    const content = line.replace(/\n$/u, "");
    if (BLANK.test(content)) {
      // Blank lines belong to the definition only if indented content follows.
      const { blanks, rest: after } = splitBlankLines(rest);
      if (!INDENTED.test(after)) {
        break;
      }
      raw += blanks;
      rest = after;
      afterBlank = true;
      continue;
    }
    if (!(INDENTED.test(content) || (!afterBlank && !BLOCK_START.test(content)))) {
      break;
    }
    raw += line;
    rest = rest.slice(line.length);
  }
  return { type: "footnoteLiteral", raw, text: raw.replace(/\n+$/u, "") };
}

const FOOTNOTE_DEFINITION_TOKENIZER: TokenizerExtension = {
  name: "footnoteLiteral",
  level: "block",
  tokenizer: (source) => readFootnoteDefinition(source),
};

const FOOTNOTE_REFERENCE_TOKENIZER: TokenizerExtension = {
  name: "footnoteLiteral",
  level: "inline",
  start: (source) => {
    const index = source.indexOf("[^");
    return index === -1 ? undefined : index;
  },
  tokenizer: (source) => {
    const reference = FOOTNOTE_REFERENCE.exec(source);
    return reference
      ? { type: "footnoteLiteral", raw: reference[0], text: reference[0] }
      : undefined;
  },
};

/** A dedicated instance: the shared `marked` defaults are never touched. */
const MARKED = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  pedantic: false,
  silent: false,
  extensions: [FOOTNOTE_DEFINITION_TOKENIZER, FOOTNOTE_REFERENCE_TOKENIZER],
});

// ————————————————————————————————————————————————————————————————————————————
// Character references
//
// Marked 18 decodes numeric references in a text token's `text` and leaves
// named ones alone, so decoding that field again would decode `&#38;copy;`
// twice. The token's `raw` is still the source, so it is decoded here, once,
// by the CommonMark rules. Code, raw HTML and escapes never pass through.
// ————————————————————————————————————————————————————————————————————————————

const CHARACTER_REFERENCE =
  /&(?:#([0-9]{1,7})|#[Xx]([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{0,31}));/gu;
/** What CommonMark decodes an invalid numeric reference to. */
const REPLACEMENT_CHARACTER = "�";
/** The last code point Unicode defines. */
const MAX_CODE_POINT = 0x10ffff;
/** The first surrogate code point. Surrogates are not characters and never decode. */
const SURROGATE_FIRST = 0xd800;
/** The last surrogate code point. */
const SURROGATE_LAST = 0xdfff;

function decodeCodePoint(codePoint: number): string {
  const invalid =
    codePoint === 0 ||
    codePoint > MAX_CODE_POINT ||
    (codePoint >= SURROGATE_FIRST && codePoint <= SURROGATE_LAST);
  return invalid ? REPLACEMENT_CHARACTER : String.fromCodePoint(codePoint);
}

function decodeCharacterReferences(source: string): string {
  return source.replace(CHARACTER_REFERENCE, (reference, ...captures: unknown[]) => {
    const [decimal, hexadecimal, name] = captures as Array<string | undefined>;
    if (decimal !== undefined) {
      return decodeCodePoint(Number.parseInt(decimal, 10));
    }
    if (hexadecimal !== undefined) {
      return decodeCodePoint(Number.parseInt(hexadecimal, 16));
    }
    return name !== undefined && Object.hasOwn(characterEntities, name)
      ? (characterEntities[name] ?? reference)
      : reference;
  });
}

// ————————————————————————————————————————————————————————————————————————————
// Inline tokens
// ————————————————————————————————————————————————————————————————————————————

/** Line ends inside a paragraph, with the spaces CommonMark strips around them. */
const SOFT_BREAK = /[ \t]*\n[ \t]*/u;

function pushText(out: MarkdownInline[], text: string): void {
  if (text.length === 0) {
    return;
  }
  const previous = out.at(-1);
  if (previous?.type === "text") {
    previous.text += text;
    return;
  }
  out.push({ type: "text", text });
}

/**
 * Source text as inlines: split at its soft breaks first, then each piece
 * decoded, so a blank written as `&#32;` beside a line end is kept.
 */
function pushSourceText(out: MarkdownInline[], raw: string): void {
  raw.split(SOFT_BREAK).forEach((line, index) => {
    if (index > 0) {
      out.push({ type: "softBreak" });
    }
    pushText(out, decodeCharacterReferences(line));
  });
}

function unexpectedToken(token: { type: string }, where: string): Error {
  return new Error(`Markdown parser returned an unexpected ${where} token "${token.type}".`);
}

function plainAlt(inlines: MarkdownInline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.type) {
        case "text":
        case "code":
        case "literal":
          return inline.text;
        case "image":
          return inline.alt;
        case "softBreak":
        case "hardBreak":
          return " ";
        default:
          return plainAlt(inline.children);
      }
    })
    .join("");
}

function convertInline(tokens: Token[] | undefined, out: MarkdownInline[] = []): MarkdownInline[] {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const text = token as Tokens.Text;
        // Text inside inline raw HTML is still Markdown text: its references
        // decode like any other, whatever Marked's raw-block state says.
        pushSourceText(out, text.raw);
        break;
      }
      case "escape":
        pushText(out, (token as Tokens.Escape).text);
        break;
      case "strong":
        out.push({ type: "strong", children: inlineChildren((token as Tokens.Strong).tokens) });
        break;
      case "em":
        out.push({ type: "emphasis", children: inlineChildren((token as Tokens.Em).tokens) });
        break;
      case "del":
        out.push({ type: "strikethrough", children: inlineChildren((token as Tokens.Del).tokens) });
        break;
      case "codespan":
        out.push({ type: "code", text: (token as Tokens.Codespan).text });
        break;
      case "br":
        out.push({ type: "hardBreak" });
        break;
      case "link": {
        const link = token as Tokens.Link & { autolink?: boolean };
        // An autolink's label is its address, shown as written.
        out.push({
          type: "link",
          children: link.autolink
            ? [{ type: "text", text: link.text }]
            : inlineChildren(link.tokens),
        });
        break;
      }
      case "image":
        out.push({ type: "image", alt: plainAlt(convertInline((token as Tokens.Image).tokens)) });
        break;
      case "html":
        out.push({ type: "literal", text: (token as Tokens.HTML).raw });
        break;
      case "footnoteLiteral":
        out.push({ type: "literal", text: (token as LiteralToken).text });
        break;
      case "checkbox":
        // The item carries the task state; the box is drawn from that.
        break;
      default:
        if (typeof token.raw === "string" && token.raw.length > 0) {
          out.push({ type: "literal", text: token.raw });
          break;
        }
        throw unexpectedToken(token, "inline");
    }
  }
  return out;
}

/** Inline content that always holds at least one node. */
function inlineChildren(tokens: Token[] | undefined): MarkdownInline[] {
  const inlines = convertInline(tokens);
  return inlines.length > 0 ? inlines : [{ type: "text", text: "" }];
}

/**
 * A paragraph's leading and trailing blanks are not part of its content. They
 * are cut from the source text before references are decoded, so a blank
 * written as `&#32;` stays.
 */
function trimParagraphTokens(tokens: Token[] | undefined): Token[] {
  const trimmed = [...(tokens ?? [])];
  const trimRaw = (index: number, pattern: RegExp): void => {
    const token = trimmed[index];
    if (token?.type === "text" && !("tokens" in token && token.tokens)) {
      trimmed[index] = { ...token, raw: token.raw.replace(pattern, "") } as Token;
    }
  };
  trimRaw(0, /^[ \t]+/u);
  trimRaw(trimmed.length - 1, /[ \t]+$/u);
  return trimmed;
}

// ————————————————————————————————————————————————————————————————————————————
// Block tokens
// ————————————————————————————————————————————————————————————————————————————

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

function headingLevel(depth: number): (typeof HEADING_LEVELS)[number] {
  return HEADING_LEVELS[Math.min(Math.max(depth, 1), 6) - 1] ?? 1;
}

function codeLanguage(info: string | undefined): string {
  const language = (info ?? "").trim().split(/\s+/u)[0] ?? "";
  return language.length > 0 ? language : "text";
}

function tableAlignment(align: Tokens.Table["align"][number]): MarkdownTableAlignment {
  return align === "left" || align === "center" || align === "right" ? align : null;
}

function listItem(item: Tokens.ListItem): MarkdownListItem {
  return {
    task: item.task ? (item.checked ? "checked" : "unchecked") : null,
    children: convertBlocks(item.tokens),
  };
}

function convertBlocks(tokens: Token[] | undefined): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "space":
      case "def":
      case "checkbox":
        // Link definitions are resolved into their links and never drawn.
        break;
      case "paragraph":
        blocks.push({
          type: "paragraph",
          children: inlineChildren(trimParagraphTokens((token as Tokens.Paragraph).tokens)),
        });
        break;
      case "text": {
        // A tight list item's content: a paragraph without the spacing.
        const text = token as Tokens.Text;
        blocks.push({
          type: "paragraph",
          children: inlineChildren(trimParagraphTokens(text.tokens ?? [text])),
        });
        break;
      }
      case "heading": {
        const heading = token as Tokens.Heading;
        blocks.push({
          type: "heading",
          level: headingLevel(heading.depth),
          children: inlineChildren(trimParagraphTokens(heading.tokens)),
        });
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        blocks.push({ type: "code", language: codeLanguage(code.lang), text: code.text });
        break;
      }
      case "hr":
        blocks.push({ type: "rule" });
        break;
      case "blockquote":
        blocks.push({
          type: "quote",
          children: convertBlocks((token as Tokens.Blockquote).tokens),
        });
        break;
      case "list": {
        const list = token as Tokens.List;
        const start = list.ordered ? Number(list.start) : 1;
        blocks.push({
          type: "list",
          ordered: list.ordered,
          start: Number.isFinite(start) ? start : 1,
          loose: list.loose,
          items: list.items.map(listItem),
        });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        const columns = table.header.length;
        blocks.push({
          type: "table",
          align: table.align.map(tableAlignment),
          header: table.header.map((cell) => inlineChildren(cell.tokens)),
          rows: table.rows.map((row) =>
            Array.from({ length: columns }, (_unused, column) =>
              inlineChildren(row[column]?.tokens),
            ),
          ),
        });
        break;
      }
      case "html":
        blocks.push({ type: "literal", text: (token as Tokens.HTML).raw.replace(/\n+$/u, "") });
        break;
      case "footnoteLiteral":
        blocks.push({ type: "literal", text: (token as LiteralToken).text });
        break;
      default:
        if (typeof token.raw === "string" && token.raw.trim().length > 0) {
          blocks.push({ type: "literal", text: token.raw.replace(/\n+$/u, "") });
          break;
        }
        throw unexpectedToken(token, "block");
    }
  }
  return blocks;
}

export const markedParser: MarkdownParser = {
  parse: (source) => convertBlocks(MARKED.lexer(source)),
  parseInline: (source) => inlineChildren(Lexer.lexInline(source, MARKED.defaults)),
};
