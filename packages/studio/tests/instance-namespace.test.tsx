/**
 * Two studios in one document. An inline SVG's `<style>` belongs to the whole
 * page, so both previews' `@keyframes`, classes and `<defs>` share a
 * namespace; naming them after a fixed string would let the later definition
 * drive both drawings.
 */
import { readdir, readFile } from "node:fs/promises";
import { assertIdentifierNamespace, normalizeIdentifierNamespace } from "@svgent/render";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useInstanceIdentifier } from "../src/instance.js";

function Probe() {
  return <i data-instance={useInstanceIdentifier()} />;
}

/** Read the values back out of the markup rather than out of a render pass. */
function identifiers(markup: string): string[] {
  return [...markup.matchAll(/data-instance="([^"]*)"/gu)].map((match) => match[1] ?? "");
}

/** Every TypeScript source in the package, walked once. */
const sources = async (): Promise<Array<[string, string]>> => {
  const root = new URL("../src/", import.meta.url);
  const walk = async (dir: URL): Promise<Array<[string, string]>> => {
    const out: Array<[string, string]> = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) {
        out.push(...(await walk(child)));
      } else if (/\.tsx?$/u.test(entry.name)) {
        out.push([child.pathname.slice(root.pathname.length), await readFile(child, "utf8")]);
      }
    }
    return out;
  };
  return walk(root);
};

describe("useInstanceIdentifier", () => {
  it("separates two studios rendered in one tree", () => {
    const seen = identifiers(
      renderToStaticMarkup(
        <>
          <Probe />
          <Probe />
        </>,
      ),
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("keeps only what survives a class name and a url(#…)", () => {
    const seen = identifiers(renderToStaticMarkup(<Probe />));
    // `_` closes a prefix, so a derived namespace may not contain one.
    expect(seen[0]).toMatch(/^[a-zA-Z0-9-]+$/u);
  });

  /*
   * `useId` is unique within a React root, not across them: two `createRoot`
   * mounts hand out the same value unless they were created with
   * `identifierPrefix`. The hook alone therefore cannot separate the ordinary
   * way of dropping a widget into a page twice — `instanceId` is what does.
   */
  it("does not separate two roots on its own", () => {
    const first = identifiers(renderToStaticMarkup(<Probe />));
    const second = identifiers(renderToStaticMarkup(<Probe />));
    expect(first[0]).toBe(second[0]);
  });
});

describe("every preview names itself after the studio's instance", () => {
  /*
   * Reading the source the way `css-tokens.test.ts` reads the stylesheet. A
   * fifth preview added later without the instance is the regression this
   * catches, and it needs no engine to catch it.
   */
  it("names every one of them after the studio, wherever it is written", async () => {
    const found: string[] = [];
    for (const [file, source] of await sources()) {
      for (const match of source.matchAll(/resourceIdPrefix:\s*(.+)$/gmu)) {
        found.push(`${file}: ${(match[1] ?? "").trim()}`);
      }
    }
    expect(found.length, "no preview names itself at all").toBeGreaterThan(0);
    expect(found.filter((prefix) => !prefix.includes("instance"))).toEqual([]);
  });
});

/*
 * A DOM id belongs to the whole document, and a document-wide query returns
 * the first match. Two studios sharing a page therefore have to name their
 * ids apart and look only inside themselves — otherwise the second studio's
 * upload button opens the first one's file picker, and a jump-to-message
 * lands on the other studio's card.
 */
describe("nothing in the studio claims a document-wide name", () => {
  /*
   * The whole source tree, not a list of files that goes stale, and every
   * attribute that names or refers to something document-wide — a referrer
   * that loses its instance fails silently: the datalist just stops
   * suggesting, the dialog just loses its label.
   */
  const NAMED =
    /(?<![\w-])(id|htmlFor|list|name|aria-labelledby|aria-describedby|aria-controls)=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/gu;
  // The formatter is free to break the line after `document`, and a lookup
  // that hides behind a newline is exactly the one nobody reads twice.
  const LOOKUP =
    /document\s*\.\s*(?:querySelector(?:All)?|getElementById|getElementsBy\w+)\s*\(([^)]*)\)/gu;
  /** Names that are meant to be one per document. */
  const GLOBAL = new Set<string>();

  it("names every document-wide attribute after the instance", async () => {
    const offenders: string[] = [];
    for (const [file, source] of await sources()) {
      for (const match of source.matchAll(NAMED)) {
        const value = match[2] ?? match[3] ?? match[4] ?? "";
        if (!value.includes("${instance}") && !value.includes("(instance") && !GLOBAL.has(value)) {
          offenders.push(`${file}: ${match[1]}="${value}"`);
        }
      }
    }
    expect(offenders, "a name that two studios would both claim").toEqual([]);
  });

  it("looks for its own elements inside its own shell", async () => {
    const offenders: string[] = [];
    for (const [file, source] of await sources()) {
      for (const match of source.matchAll(LOOKUP)) {
        const argument = match[1] ?? "";
        if (!argument.includes("instance")) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders, "a document-wide lookup").toEqual([]);
  });

  /*
   * A listener on the document or the window hears every studio on the page.
   * The names these react to — `[data-tip]`, a range input, a focused field —
   * are names every studio's controls carry, so an unscoped listener answers
   * the studio next door: hovering one draws a tooltip on both, and holding
   * one slider freezes both previews.
   */
  // Every receiver, not the two spellings that happened to be here: the one
  // page-wide listener this package keeps is attached through a parameter, and
  // a pattern naming `document` and `window` cannot see it.
  const ANY_LISTENER = /(\w+)\s*\.\s*addEventListener\s*\(\s*["'`]([^"'`]+)["'`]/gu;
  /** Receivers that are an element the studio owns rather than the page. */
  const OWNED_RECEIVERS = new Set(["shell", "stage", "reader"]);
  /**
   * Events that are the page's to hear. Facts about the document, which every
   * studio reads for itself; the events that only fire on the document at all;
   * and the geometry of the window, which no studio owns.
   */
  const PAGE_WIDE = new Set([
    "visibilitychange",
    "selectionchange",
    "fullscreenchange",
    "resize",
    "scroll",
  ]);
  /**
   * One listener is the page's on purpose. Escape belongs to whichever overlay
   * is on top, which is a fact about the document and not about any studio —
   * so `overlays.ts` keeps a single stack, hears the key once, and hands it to
   * the last overlay raised. Every studio reaches it through that.
   */
  const NOT_YET_SCOPED = new Set(["overlays.ts: page keydown"]);
  /**
   * A gesture ends wherever the finger lifts, so the release stays on the
   * window — but it has to name the pointer it is ending, which the drag rule
   * below is what checks.
   */
  const GESTURE_END = new Set(["pointerup", "pointercancel"]);

  it("listens on its own shell, not on the page", async () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const [file, source] of await sources()) {
      for (const match of source.matchAll(ANY_LISTENER)) {
        const receiver = match[1] ?? "";
        const type = match[2] ?? "";
        if (OWNED_RECEIVERS.has(receiver)) {
          continue;
        }
        seen += 1;
        if (PAGE_WIDE.has(type) || GESTURE_END.has(type) || type === "pointermove") {
          continue;
        }
        if (NOT_YET_SCOPED.has(`${file}: ${receiver} ${type}`)) {
          continue;
        }
        offenders.push(`${file}: ${receiver}.addEventListener("${type}")`);
      }
    }
    expect(seen, "no page-wide listeners read at all").toBeGreaterThan(4);
    expect(offenders, "a listener that hears another studio").toEqual([]);
  });

  /*
   * A drag reads `pointermove` and its release off the window, so a second
   * finger anywhere on the page — a second studio, or two thumbs in this one —
   * would drive one drag and end another. Every one of them names the pointer
   * it belongs to.
   *
   * The default here is "offender". A handler this cannot resolve is not a
   * handler this has cleared: the shape it could not read is exactly the shape
   * the old code had, where the teardown took no argument at all and tore the
   * drag down on anyone's release.
   */
  it("drives a drag only from the pointer that began it", async () => {
    const INSTALLED =
      /(?:window|document)\s*\.\s*addEventListener\s*\(\s*["'`]pointer(?:move|up|cancel)["'`]\s*,\s*([^,)]+)/gu;
    const offenders: string[] = [];
    for (const [file, source] of await sources()) {
      for (const install of source.matchAll(INSTALLED)) {
        const handler = (install[1] ?? "").trim();
        if (!/^\w+$/u.test(handler)) {
          offenders.push(`${file}: a pointer handler written inline, where nothing can read it`);
          continue;
        }
        // The one declared closest above this install: `onMove` names a
        // different handler in every drag, and matching the first would let
        // one guarded session vouch for all the others.
        const declared = [
          ...source.matchAll(
            new RegExp(`(?:const|let|var|function)\\s+${handler}\\s*=?\\s*\\(([^)]*)\\)`, "gu"),
          ),
        ]
          .filter((match) => match.index < install.index)
          .at(-1);
        if (declared === undefined) {
          offenders.push(`${file}: ${handler} has no declaration this can read`);
          continue;
        }
        const parameter = /^(\w+)/u.exec((declared[1] ?? "").trim())?.[1];
        if (parameter === undefined) {
          offenders.push(`${file}: ${handler} takes no event, so it acts on every pointer`);
          continue;
        }
        // Forward from the parameter list only as far as this handler's own
        // opening: a wider window reaches into the next handler's guard, and
        // in one pair here both parameters are spelled the same.
        const body = source.slice(declared.index, declared.index + 160);
        if (!body.includes(`${parameter}.pointerId !==`)) {
          offenders.push(`${file}: ${handler} acts on any pointer`);
        }
      }
    }
    expect(offenders, "a drag another pointer can steer").toEqual([]);
  });

  /*
   * `document.activeElement` is the page's, not this studio's. Taking focus
   * away without asking where it is blurs the editor in the studio beside this
   * one, or a field on the host's own page. The check has to be the shell's
   * own `contains` — `classList.contains` is one refactor away from laundering
   * an unguarded blur.
   */
  it("takes focus away only from inside its own shell", async () => {
    const SHELL_CONTAINS = /shellRef\.current\?\.contains\(/u;
    const offenders: string[] = [];
    for (const [file, source] of await sources()) {
      for (const match of source.matchAll(/\bactiveElement\b/gu)) {
        const nearby = source.slice(match.index, match.index + 300);
        if (!SHELL_CONTAINS.test(nearby)) {
          offenders.push(`${file}: activeElement with nothing asking whose it is`);
        }
      }
    }
    expect(offenders, "focus taken from another studio").toEqual([]);
  });
});

/*
 * The prop a caller passes is checked, not repaired. Deleting the characters
 * the namespace rejects is not injective — `pane/left` and `pane.left` would
 * arrive as one namespace, which is the collision the prop exists to prevent.
 */
describe("a caller's instanceId", () => {
  it("is refused rather than mangled", () => {
    for (const bad of ["", "pane/left", "pane.left", "editor#1", "!!!", "pane_left"]) {
      expect(() => assertIdentifierNamespace(bad), bad).toThrow(/identifierNamespace/u);
    }
  });

  it("accepts what the studio itself would produce", () => {
    const seen = identifiers(renderToStaticMarkup(<Probe />));
    expect(() => assertIdentifierNamespace(seen[0] ?? "")).not.toThrow();
  });

  /** `useId` returns `_R_1_`; a value that starts with `_` is not accepted. */
  it.each([
    "",
    "!!!",
    "-x",
    "_x",
    "_R_1_",
    "編集1",
  ])("normalises %s into something the check accepts", (value) => {
    expect(() => assertIdentifierNamespace(normalizeIdentifierNamespace(value))).not.toThrow();
  });

  /*
   * Deleting characters is not injective, and what is normalised here is
   * React's, not this package's: `createRoot(…, { identifierPrefix })` is the
   * documented way to separate two roots, and two roots given `a_` and `a`
   * would be handed one namespace — the collision the namespace exists to
   * prevent, arriving through the door left open for it.
   */
  it("keeps two values apart that differ only where it stops looking", () => {
    const values = ["_x", "x", "x_", "_x_", "a_", "a", "編集1", "1", "_R_1_", "_R1_", "_R_1"];
    const normalised = values.map((value) => normalizeIdentifierNamespace(value));
    expect(new Set(normalised).size, "two values normalised to one namespace").toBe(values.length);
  });
});
