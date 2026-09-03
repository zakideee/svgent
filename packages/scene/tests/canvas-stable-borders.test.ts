/**
 * The terminal's hairlines do not scale with the camera.
 *
 * A 1px stroke inside the camera group is scaled with the geometry, so a zoom
 * sweeps it through fractional widths and every border pulses as the raster
 * coverage moves frame to frame. `strokeScaling: "canvas"` asks the engine to
 * keep those strokes in screen space instead.
 *
 * Four constructors opt in by hand rather than through a rule like "borders on
 * the terminal are canvas-stable", so a card or a spinner added later does not
 * inherit the treatment silently. The checks here are about which borders got
 * it and how the artifact carries it — not about the layout, which this change
 * must leave exactly as it was.
 */

import { readFile } from "node:fs/promises";
import { createEngineAsync, type Engine } from "@boundsvg/core";
import { initNodeWasm } from "@boundsvg/core/node";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath } from "@svgent/assets/node";
import {
  buildSvgentScene,
  bundledFallbackFonts,
  deserializeProject,
  FONT_ALIAS,
} from "@svgent/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type IrNode = {
  type?: string;
  meta?: Record<string, string>;
  strokeScaling?: string;
  strokeWidth?: number;
  children?: IrNode[];
};

/** The authored sample the camera actually zooms: TUI, follow, both pickers. */
const SCRIPT = "../../../examples/readme-tui-zoom.json";

let engine: Engine;
let scene: ReturnType<typeof buildSvgentScene>;

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
  const source = await readFile(new URL(SCRIPT, import.meta.url), "utf8");
  const { project } = deserializeProject(source, "ja");
  scene = buildSvgentScene(project, 0, { engine });
});

afterAll(() => {
  engine?.dispose();
});

/**
 * Canvas-stable strokes with the owner they belong to. The window frame owns no
 * message and carries no action, so it resolves as `null` — which is itself the
 * claim: exactly one such border sits outside everything else.
 */
function canvasStableOwners(timeMs: number): Array<string | null> {
  const ir = engine.renderToIR(scene.vnode, { skipValidation: true, timeMs }) as unknown as {
    root: IrNode;
  };
  const found: Array<string | null> = [];
  const walk = (node: IrNode, owner: string | null): void => {
    const meta = node.meta ?? {};
    const next =
      meta.action === "compose-user"
        ? "composer"
        : meta["picker-for"] !== undefined
          ? // A collapsing choice's live panel is not a transcript block, but
            // its frame still belongs to its message.
            meta["picker-for"]
          : meta.edit !== undefined && !meta.edit.startsWith("field:")
            ? meta.edit
            : owner;
    if (node.strokeScaling === "canvas") {
      found.push(next);
    }
    for (const child of node.children ?? []) {
      walk(child, next);
    }
  };
  walk(ir.root, null);
  return found;
}

function midMs(): number {
  return Math.round(scene.durationMs / 2);
}

describe("canvas-stable terminal borders", () => {
  it("gives every picker, the composer and the window one, and nothing else", () => {
    const owners = canvasStableOwners(midMs());
    const pickerIds = scene.messageTimings
      .filter((timing) => timing.message.role === "choice" || timing.message.role === "permission")
      .map((timing) => timing.message.id);
    expect(pickerIds.length).toBeGreaterThan(1);

    // One per picker: choice and permission share tuiPickerBlock, so a script
    // with two permissions carries three picker frames, not a fixed count.
    for (const id of pickerIds) {
      expect(
        owners.filter((owner) => owner === id),
        `picker ${id}`,
      ).toHaveLength(1);
    }
    expect(
      owners.filter((owner) => owner === "composer"),
      "composer",
    ).toHaveLength(1);
    // The window frame belongs to no message and no control.
    expect(
      owners.filter((owner) => owner === null),
      "window",
    ).toHaveLength(1);
    expect(owners).toHaveLength(pickerIds.length + 2);
  });

  it("leaves the app surface untouched", async () => {
    // The claim is that this was opted into by hand, four constructors on one
    // surface — not applied to everything that draws a border. The app is the
    // surface that would have come along with a blanket rule, and it has
    // borders of its own to prove it did not.
    const source = await readFile(new URL(SCRIPT, import.meta.url), "utf8");
    const { project } = deserializeProject(source, "ja");
    const app = buildSvgentScene({ ...project, surface: "app" }, 0, { engine });
    const ir = engine.renderToIR(app.vnode, {
      skipValidation: true,
      timeMs: Math.round(app.durationMs / 2),
    }) as unknown as { root: IrNode };
    let stroked = 0;
    let stable = 0;
    const walk = (node: IrNode): void => {
      if (node.strokeWidth !== undefined && node.strokeWidth > 0) {
        stroked += 1;
        if (node.strokeScaling === "canvas") {
          stable += 1;
        }
      }
      for (const child of node.children ?? []) {
        walk(child);
      }
    };
    walk(ir.root);
    expect(stroked, "the app surface draws borders").toBeGreaterThan(0);
    expect(stable, "none of them are canvas-stable").toBe(0);
  });

  it("carries the restoration rule in the animated SVG, not on the elements", () => {
    const svg = engine.renderToAnimatedSvg(scene.vnode, {
      playback: { mode: "independent" },
      skipValidation: true,
    });
    const supports = svg.match(/@supports \(vector-effect: non-scaling-stroke\)/g) ?? [];
    expect(supports, "one @supports block").toHaveLength(1);

    // The attribute must not be painted on statically: a viewer without the
    // feature has to fall back to the sampled width, not to a stroke it cannot
    // interpret.
    expect(svg).not.toMatch(/<rect[^>]*vector-effect=/);

    // Every class the rule names has to reach a real rect that already carries
    // a fallback width.
    const classes = [...svg.matchAll(/\.([A-Za-z0-9_\\:.-]*vstroke[A-Za-z0-9_\\:.-]*)\s*\{/g)].map(
      (match) => (match[1] ?? "").replace(/\\/g, ""),
    );
    expect(classes.length).toBeGreaterThan(0);
    for (const name of classes) {
      const element = svg.match(
        new RegExp(
          `<rect[^>]*class="[^"]*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"]*"[^>]*>`,
        ),
      );
      expect(element, `class ${name} reaches a rect`).not.toBeNull();
      expect(element?.[0], `class ${name} has a fallback width`).toMatch(/stroke-width="[\d.]+"/);
    }
  });

  it("still samples a pose-dependent fallback width for viewers without the feature", () => {
    // Sampled across the run rather than at three fixed beats: which
    // moments the camera spends zoomed shifts as the choreography evolves
    // (a collapsing choice moved the lean-in), and the claim is only that
    // some pose differs from some other.
    const sampleMs = [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1].map((at) => Math.round(scene.durationMs * at));
    const widths = sampleMs.map((timeMs) => {
      const svg = engine.renderToSvg(scene.vnode, {
        timeMs,
        skipValidation: true,
      });
      const rect = svg.match(/<rect[^>]*stroke-width="([\d.]+)"[^>]*>/);
      return Number(rect?.[1] ?? 0);
    });
    for (const width of widths) {
      expect(width).toBeGreaterThan(0);
    }
    // The fallback is the sampled geometry width, so it is not constant across
    // a zoom — that is exactly what the restoration rule replaces.
    expect(new Set(widths).size).toBeGreaterThan(1);
  });
});
