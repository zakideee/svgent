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

export type HighlightRun = {
  text: string;
  token: string;
};

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
