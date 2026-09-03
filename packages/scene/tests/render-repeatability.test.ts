/**
 * The same project, built twice on one engine, must lay out identically.
 * Message heights are memoised across builds, so a key that misses an input
 * the height depends on lets the last message measured decide for an earlier
 * one — and the second build lays a standing choice card into the slot of the
 * two-row record it would have collapsed to, painting over the rows below.
 * The studio holds one engine for a session, so the first paint is right and
 * every keystroke after it is wrong.
 */
import { readFile } from "node:fs/promises";
import { type AnyVNode, createEngineAsync, type Engine } from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  bundledFallbackFonts,
  DEFAULT_PROJECT,
  FONT_ALIAS,
  type SvgentProject,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let engine: Engine;

beforeAll(async () => {
  await initNodeWasm();
  const loadFont = async (file: string) => new Uint8Array(await readFile(bundledFontPath(file)));
  engine = await createEngineAsync({
    fonts: [
      {
        alias: FONT_ALIAS.sans,
        weight: 400,
        style: "normal",
        data: await loadFont("NotoSansJP-Regular.subset.woff2"),
      },
      {
        alias: FONT_ALIAS.mono,
        weight: 400,
        style: "normal",
        data: await loadFont("JetBrainsMono-Regular.woff2"),
      },
      ...(await bundledFallbackFonts((slot) => loadFont(BUNDLED_FONT_FILES[slot]))),
    ],
  });
});

afterAll(() => {
  engine?.dispose();
});

/** Geometry only: ids and colors say nothing about where things land. */
function shape(node: AnyVNode): unknown {
  const props = node.props as Record<string, unknown>;
  return {
    type: node.type,
    box: [props.top, props.left, props.bottom, props.width, props.height],
    children: (node.children as readonly unknown[]).map((child) =>
      typeof child === "object" && child !== null && "type" in child
        ? shape(child as AnyVNode)
        : child,
    ),
  };
}

/**
 * Two cards with the same question and menu that differ only in whether they
 * keep it. One stands at full height; the other collapses to a record.
 */
const MIXED_AFTER_SELECTION: SvgentProject["messages"] = [
  {
    id: "c1",
    role: "choice",
    content: "How far should this go?",
    options: ["Safe", "Standard", "Aggressive"],
    chosenIndex: 1,
    afterSelection: "keep",
  },
  { id: "a1", role: "assistant", content: "Noted." },
  {
    id: "c2",
    role: "choice",
    content: "How far should this go?",
    options: ["Safe", "Standard", "Aggressive"],
    chosenIndex: 1,
  },
  { id: "a2", role: "assistant", content: "Done." },
];

describe("a second build of the same project", () => {
  it.each(["app", "tui"] as const)("lays %s out the same way", (surface) => {
    const project: SvgentProject = { ...DEFAULT_PROJECT, surface, messages: MIXED_AFTER_SELECTION };
    const first = shape(buildSvgentScene(project, 0, { engine }).vnode);
    const second = shape(buildSvgentScene(project, 0, { engine }).vnode);
    expect(second).toEqual(first);
  }, 20_000);
});
