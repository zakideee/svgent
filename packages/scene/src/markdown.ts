import Prism from "prismjs";
import "prismjs/components/prism-bash.js";
// prism-css also teaches the markup grammar to highlight <style> contents,
// which the SVG source inspector relies on for animation keyframes.
import "prismjs/components/prism-css.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-tsx.js";

export type InlineStyle = "plain" | "strong" | "emphasis" | "code" | "link";

export type InlineRun = {
  text: string;
  style: InlineStyle;
};

export type HighlightRun = {
  text: string;
  token: string;
};

export type MarkdownBlock =
  | { type: "heading"; level: number; runs: InlineRun[] }
  | { type: "paragraph"; runs: InlineRun[] }
  | { type: "list"; ordered: boolean; items: InlineRun[][] }
  | { type: "quote"; runs: InlineRun[] }
  | { type: "code"; language: string; lines: HighlightRun[][] }
  | { type: "rule" };

function appendRun(runs: InlineRun[], run: InlineRun): void {
  const previous = runs.at(-1);
  if (previous?.style === run.style) {
    previous.text += run.text;
    return;
  }
  runs.push(run);
}

export function parseInlineMarkdown(source: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/gu;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) {
      appendRun(runs, { text: source.slice(cursor, index), style: "plain" });
    }
    const token = match[0];
    if (token.startsWith("**")) {
      appendRun(runs, { text: token.slice(2, -2), style: "strong" });
    } else if (token.startsWith("*")) {
      appendRun(runs, { text: token.slice(1, -1), style: "emphasis" });
    } else if (token.startsWith("`")) {
      appendRun(runs, { text: token.slice(1, -1), style: "code" });
    } else {
      const labelEnd = token.indexOf("](");
      appendRun(runs, { text: `${token.slice(1, labelEnd)} ↗`, style: "link" });
    }
    cursor = index + token.length;
  }
  if (cursor < source.length) {
    appendRun(runs, { text: source.slice(cursor), style: "plain" });
  }
  return runs.length > 0 ? runs : [{ text: "", style: "plain" }];
}

function prismLanguage(language: string): Prism.Grammar | null {
  const normalized = language.toLowerCase();
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    sh: "bash",
    shell: "bash",
  };
  return Prism.languages[aliases[normalized] ?? normalized] ?? null;
}

function flattenPrismToken(token: string | Prism.Token, inheritedType = "plain"): HighlightRun[] {
  if (typeof token === "string") {
    return [{ text: token, token: inheritedType }];
  }
  const tokenType = Array.isArray(token.alias)
    ? (token.alias[0] ?? token.type)
    : (token.alias ?? token.type);
  if (typeof token.content === "string") {
    return [{ text: token.content, token: tokenType }];
  }
  if (Array.isArray(token.content)) {
    return token.content.flatMap((child) => flattenPrismToken(child, tokenType));
  }
  return flattenPrismToken(token.content, tokenType);
}

export function highlightCode(code: string, language: string): HighlightRun[][] {
  const grammar = prismLanguage(language);
  const runs = grammar
    ? Prism.tokenize(code, grammar).flatMap((token) => flattenPrismToken(token))
    : [{ text: code, token: "plain" }];
  const lines: HighlightRun[][] = [[]];
  for (const run of runs) {
    const fragments = run.text.split("\n");
    fragments.forEach((fragment, index) => {
      const line = lines.at(-1);
      if (line && fragment.length > 0) {
        line.push({ text: fragment, token: run.token });
      }
      if (index < fragments.length - 1) {
        lines.push([]);
      }
    });
  }
  return lines;
}

const LIST_ITEM = /^\s*(?:(\d+)\.|([-*]))\s+(.+)$/u;
const RULE_LINE = /^\s*(?:---+|___+)\s*$/u;
/** A line that ends the paragraph it follows, because it opens a block itself. */
const BLOCK_OPENER = /^(?:```|(?:#{1,4})\s+|>\s?|\s*(?:\d+\.|[-*])\s+|\s*(?:---+|___+)\s*$)/u;

/** One block plus the line the scanner should resume from. */
type BlockReading = { block: MarkdownBlock; nextIndex: number };

function readFencedCode(lines: string[], index: number): BlockReading | null {
  const fence = /^```([\w-]*)\s*$/u.exec(lines[index] ?? "");
  if (!fence) {
    return null;
  }
  const language = fence[1] || "text";
  const codeLines: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length && !/^```\s*$/u.test(lines[cursor] ?? "")) {
    codeLines.push(lines[cursor] ?? "");
    cursor += 1;
  }
  // An unterminated fence runs to the end of the source rather than failing.
  return {
    block: { type: "code", language, lines: highlightCode(codeLines.join("\n"), language) },
    nextIndex: cursor + (cursor < lines.length ? 1 : 0),
  };
}

function readHeading(lines: string[], index: number): BlockReading | null {
  const heading = /^(#{1,4})\s+(.+)$/u.exec(lines[index] ?? "");
  return heading
    ? {
        block: {
          type: "heading",
          level: heading[1]?.length ?? 1,
          runs: parseInlineMarkdown(heading[2] ?? ""),
        },
        nextIndex: index + 1,
      }
    : null;
}

function readRule(lines: string[], index: number): BlockReading | null {
  return RULE_LINE.test(lines[index] ?? "")
    ? { block: { type: "rule" }, nextIndex: index + 1 }
    : null;
}

function readQuote(lines: string[], index: number): BlockReading | null {
  const quote = /^>\s?(.*)$/u.exec(lines[index] ?? "");
  return quote
    ? {
        block: { type: "quote", runs: parseInlineMarkdown(quote[1] ?? "") },
        nextIndex: index + 1,
      }
    : null;
}

/** Consecutive markers of the same kind form one list; switching kind starts another. */
function readList(lines: string[], index: number): BlockReading | null {
  const first = LIST_ITEM.exec(lines[index] ?? "");
  if (!first) {
    return null;
  }
  const ordered = first[1] !== undefined;
  const items: InlineRun[][] = [];
  let cursor = index;
  while (cursor < lines.length) {
    const itemLine = LIST_ITEM.exec(lines[cursor] ?? "");
    if (!itemLine || (itemLine[1] !== undefined) !== ordered) {
      break;
    }
    items.push(parseInlineMarkdown(itemLine[3] ?? ""));
    cursor += 1;
  }
  return { block: { type: "list", ordered, items }, nextIndex: cursor };
}

/** The fallback: everything up to a blank line or the next block opener. */
function readParagraph(lines: string[], index: number): BlockReading {
  const paragraphLines = [(lines[index] ?? "").trim()];
  let cursor = index + 1;
  while (cursor < lines.length) {
    const nextLine = lines[cursor] ?? "";
    if (nextLine.trim().length === 0 || BLOCK_OPENER.test(nextLine)) {
      break;
    }
    paragraphLines.push(nextLine.trim());
    cursor += 1;
  }
  return {
    block: { type: "paragraph", runs: parseInlineMarkdown(paragraphLines.join(" ")) },
    nextIndex: cursor,
  };
}

const BLOCK_READERS = [readFencedCode, readHeading, readRule, readQuote, readList] as const;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let lineIndex = 0;
  while (lineIndex < lines.length) {
    if ((lines[lineIndex] ?? "").trim().length === 0) {
      lineIndex += 1;
      continue;
    }
    let reading: BlockReading | null = null;
    for (const reader of BLOCK_READERS) {
      reading = reader(lines, lineIndex);
      if (reading) {
        break;
      }
    }
    const { block, nextIndex } = reading ?? readParagraph(lines, lineIndex);
    blocks.push(block);
    lineIndex = nextIndex;
  }
  return blocks.length > 0 ? blocks : [{ type: "paragraph", runs: [{ text: "", style: "plain" }] }];
}

export function markdownPlainText(blocks: MarkdownBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "rule") {
        return "";
      }
      if (block.type === "code") {
        return block.lines
          .flat()
          .map((run) => run.text)
          .join("");
      }
      if (block.type === "list") {
        return block.items
          .flat()
          .map((run) => run.text)
          .join(" ");
      }
      return block.runs.map((run) => run.text).join("");
    })
    .join("\n");
}

/**
 * Characters the renderer actually reveals for a Markdown body, counted the
 * way markdown-render walks it: run text plus one tick per line break inside
 * a block. The timeline budgets a message's duration from this, so a message
 * cannot be declared finished while its own code panel is still typing.
 */
export function markdownRevealCharacters(content: string): number {
  let total = 0;
  for (const block of parseMarkdown(content)) {
    if (block.type === "rule") {
      total += 1;
      continue;
    }
    if (block.type === "code") {
      total += block.lines.reduce(
        (sum, line) => sum + line.reduce((run, part) => run + Array.from(part.text).length, 0) + 1,
        0,
      );
      continue;
    }
    if (block.type === "list") {
      total += block.items.reduce(
        (sum, item) => sum + item.reduce((run, part) => run + Array.from(part.text).length, 0) + 1,
        0,
      );
      continue;
    }
    total += block.runs.reduce((sum, run) => sum + Array.from(run.text).length, 0);
  }
  return total;
}
