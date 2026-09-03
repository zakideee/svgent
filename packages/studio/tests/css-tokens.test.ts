/**
 * Custom properties the stylesheet reads but never defines.
 *
 * A misspelled token is not a syntax error and not a visual one either: the
 * declaration is simply dropped, so the element keeps whatever it inherited
 * and the page looks almost right. `color: var(--text)` — where the token is
 * `--ink` — shipped once exactly that way, silently leaving emphasized text
 * the muted colour it was meant to be lifted out of.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const STYLESHEETS = ["app.css"];

/** Tokens that legitimately come from outside the stylesheet. */
const EXTERNAL_TOKENS = new Set<string>();

describe("studio stylesheet tokens", () => {
  it.each(STYLESHEETS)("defines every custom property %s reads", async (path) => {
    const source = await readFile(
      fileURLToPath(new URL(`../src/${path}`, import.meta.url)),
      "utf8",
    );
    const defined = new Set(
      [...source.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/gu)].map((match) => match[1] as string),
    );
    // A fallback (`var(--a, var(--b))`) covers a missing token by design.
    const read = [...source.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/gu)]
      .filter((match) => match[2] === ")")
      .map((match) => match[1] as string);

    const missing = [...new Set(read)]
      .filter((token) => !defined.has(token) && !EXTERNAL_TOKENS.has(token))
      .sort();
    expect(missing).toEqual([]);
  });
});

/**
 * What the stylesheet is allowed to reach.
 *
 * An embedded studio that repaints the page around it is a widget rewriting
 * its host: the box model of every element, the colour of every button, the
 * background of the document. All of that used to be here. The rule reads the
 * selector at the start of each rule and asks that it stay inside the shell —
 * and its default is "offender", so a shape it cannot parse is a finding
 * rather than a pass.
 */
/** Top-level commas only: `:is(button, input)` is one selector, not two. */
function splitSelectors(selectors: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of selectors) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((each) => each.trim());
}

describe("the stylesheet paints the studio and nothing else", () => {
  /*
   * The page's own scroll is genuinely the page's: an overlay holds it while
   * it is up, and no element inside the shell can freeze the root scroller in
   * its place. The list does not shrink further — what several studios share
   * is now the stack in `overlays.ts`, not this rule.
   */
  const PAGE_RULES = new Set(["html.svgent-scroll-locked", "html.svgent-scroll-locked body"]);

  it("starts every rule at a name only the studio carries", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/app.css", import.meta.url)),
      "utf8",
    );
    const stripped = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
    const offenders: string[] = [];
    let seen = 0;
    for (const match of stripped.matchAll(/(?:^|[{}])\s*([^{}@][^{}]*?)\{/gmu)) {
      const selectors = (match[1] ?? "").trim();
      if (selectors.startsWith("@")) {
        continue;
      }
      for (const selector of splitSelectors(selectors)) {
        // Keyframe stops are selectors to this regex and to nothing else.
        if (selector === "" || /^(?:\d+(?:\.\d+)?%|from|to)$/u.test(selector)) {
          continue;
        }
        seen += 1;
        // A class is a name this package invents, so it exists only where the
        // studio put it. Anything else — an element, `*`, `:root`, `html`,
        // `body`, an id — is a name the host page already has, and reaching it
        // means reaching outside. A reset may start at the shell instead, but
        // only through `:where()`: written with weight it would outrank the
        // rules that dress each control.
        if (/^\./u.test(selector) || /^:where\(\.studio-shell\)/u.test(selector)) {
          continue;
        }
        if (PAGE_RULES.has(selector)) {
          continue;
        }
        offenders.push(selector);
      }
    }
    expect(seen, "no selectors read at all").toBeGreaterThan(50);
    expect([...new Set(offenders)].sort(), "a rule that reaches outside the studio").toEqual([]);
  });

  /*
   * A rule whose subject is an element rather than a class is a reset, and a
   * reset has to weigh nothing. Scoped as `.studio-shell button` it outranks
   * the single-class rule that dresses each control, and `font: inherit` —
   * a shorthand, so size, weight and family together — wins over it: the guide
   * button came out at the body's 16px and the language toggle lost its
   * monospace, both from a selector that reads as if it only narrowed reach.
   */
  it("gives its resets no weight", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/app.css", import.meta.url)),
      "utf8",
    );
    const stripped = source.replaceAll(/\/\*[\s\S]*?\*\//gu, "");
    const offenders: string[] = [];
    let seen = 0;
    for (const match of stripped.matchAll(/(?:^|[{}])\s*([^{}@][^{}]*?)\{/gmu)) {
      const selectors = (match[1] ?? "").trim();
      if (selectors.startsWith("@")) {
        continue;
      }
      for (const selector of splitSelectors(selectors)) {
        if (selector === "" || /^(?:\d+(?:\.\d+)?%|from|to)$/u.test(selector)) {
          continue;
        }
        // A reset is a rule anchored on the shell and on nothing narrower:
        // everything after the scope is elements. `.panel-tab-body p` is not
        // one — it is anchored on its own class and outranks nothing it did
        // not already outrank.
        const scope = /^(:where\(\.studio-shell\)|\.studio-shell)(?![\w-])/u.exec(selector);
        if (scope === null || PAGE_RULES.has(selector)) {
          continue;
        }
        const beyond = selector.slice(scope[0].length);
        // The shell's own block, and the attribute that themes it, are not
        // resets: they declare what the studio inherits and have to keep the
        // weight that lets the theme beat the base. Attached to the shell with
        // no space — a space makes it a descendant, which is a reset again.
        if (beyond === "" || /^[[:]/u.test(beyond)) {
          continue;
        }
        if (/[.#]/u.test(beyond)) {
          continue;
        }
        seen += 1;
        if (!selector.startsWith(":where(")) {
          offenders.push(selector);
        }
      }
    }
    expect(seen, "no element-subject rules found at all").toBeGreaterThan(3);
    expect([...new Set(offenders)].sort(), "a reset that outranks the rules it resets").toEqual([]);
  });

  it("names its keyframes after the product", async () => {
    const source = await readFile(
      fileURLToPath(new URL("../src/app.css", import.meta.url)),
      "utf8",
    );
    const names = [...source.matchAll(/@keyframes\s+([\w-]+)/gu)].map((match) => match[1] ?? "");
    expect(names.length, "no keyframes found").toBeGreaterThan(0);
    // A keyframe name belongs to the whole document, so a generic one is a
    // name the host page may already have spent.
    expect(names.filter((name) => !name.startsWith("svgent-"))).toEqual([]);
  });
});
