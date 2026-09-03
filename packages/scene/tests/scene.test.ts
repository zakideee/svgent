import { type AnyVNode, validate } from "@boundsvg/core";
import {
  buildSvgentScene,
  contentAlignOffset,
  DEFAULT_PROJECT,
  metricsFor,
  productMarkPlacements,
  REENACTMENT_BADGE,
  SIMULATION_BADGE,
  type SvgentProject,
  spaceScaleFor,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

const TEST_GENERATOR = { name: "scene-test", version: "1.2.3" } as const;

function walk(node: AnyVNode, visit: (node: AnyVNode) => void): void {
  visit(node);
  for (const child of node.children as readonly unknown[]) {
    if (typeof child === "object" && child !== null && "type" in child) {
      walk(child as AnyVNode, visit);
    }
  }
}

function authoringProps(node: AnyVNode): {
  meta?: Readonly<Record<string, string>>;
  color?: string;
  animate?: unknown;
  animateUnits?: unknown;
  background?: string;
  borderWidth?: number;
  height?: number;
  margin?: readonly number[];
  minHeight?: number;
  width?: number;
} {
  return node.props as {
    meta?: Readonly<Record<string, string>>;
    color?: string;
    animate?: unknown;
    animateUnits?: unknown;
    background?: string;
    borderWidth?: number;
    height?: number;
    margin?: readonly number[];
    minHeight?: number;
    width?: number;
  };
}

function nodesWithAction(root: AnyVNode, action: string): AnyVNode[] {
  const matches: AnyVNode[] = [];
  walk(root, (node) => {
    if (authoringProps(node).meta?.action === action) {
      matches.push(node);
    }
  });
  return matches;
}

function directText(node: AnyVNode): string {
  return (node.children as readonly unknown[])
    .filter((child): child is string => typeof child === "string")
    .join("");
}

function animationDelay(node: AnyVNode | undefined): number {
  if (!node) {
    return 0;
  }
  return (authoringProps(node).animate as { delayMs?: number } | undefined)?.delayMs ?? 0;
}

function messageDescendants(root: AnyVNode, messageId: string): AnyVNode[] {
  let messageRoot: AnyVNode | undefined;
  walk(root, (node) => {
    if (authoringProps(node).meta?.edit === messageId) {
      messageRoot = node;
    }
  });
  const descendants: AnyVNode[] = [];
  if (messageRoot) {
    walk(messageRoot, (node) => descendants.push(node));
  }
  return descendants;
}

function textNode(nodes: AnyVNode[], text: string): AnyVNode | undefined {
  return nodes.find((node) => node.type === "Text" && directText(node) === text);
}

function quoteDecoration(nodes: AnyVNode[], surface: "app" | "tui"): AnyVNode | undefined {
  if (surface === "tui") {
    return textNode(nodes, "│");
  }
  return nodes.find((node) => {
    const props = authoringProps(node);
    return node.type === "Box" && props.width === 3 && props.minHeight !== undefined;
  });
}

function ruleDecoration(nodes: AnyVNode[]): AnyVNode | undefined {
  return nodes.find((node) => {
    const props = authoringProps(node);
    return node.type === "Box" && props.height === 1 && props.margin?.[0] === 6;
  });
}

describe("scene contract", () => {
  it.each(["app", "tui"] as const)("builds a valid %s scene", (surface) => {
    const project: SvgentProject = { ...DEFAULT_PROJECT, surface };
    const scene = buildSvgentScene(project, 0);
    expect(() => validate(scene.vnode)).not.toThrow();
    expect(scene.durationMs).toBeGreaterThan(0);
    expect(scene.vnode.type).toBe("Canvas");
    if (scene.vnode.type !== "Canvas") {
      throw new TypeError("Expected a Canvas scene");
    }
    expect(scene.vnode.props.meta?.simulated).toBe("true");
    expect(scene.vnode.props.meta?.disclosure).toBe(SIMULATION_BADGE);
    expect(scene.vnode.props.meta?.["model-kind"]).toBe("fictional");
  });

  it("stamps a reenactment as simulated with its own model-kind", () => {
    const project: SvgentProject = { ...DEFAULT_PROJECT, basis: "reenactment" };
    const scene = buildSvgentScene(project, 0);
    if (scene.vnode.type !== "Canvas") {
      throw new TypeError("Expected a Canvas scene");
    }
    // simulated stays true for every basis: the artifact is an authored
    // rendering, never a screen capture.
    expect(scene.vnode.props.meta?.simulated).toBe("true");
    expect(scene.vnode.props.meta?.disclosure).toBe(REENACTMENT_BADGE);
    expect(scene.vnode.props.meta?.["model-kind"]).toBe("reenactment");
  });

  it("stages a voice-input user message as level bars in the app composer", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      messages: [
        { id: "voice-1", role: "user", content: "Capture this by voice", inputMode: "voice" },
      ],
    };
    const scene = buildSvgentScene(project, 0);
    let waveformCount = 0;
    walk(scene.vnode, (node) => {
      const meta = (node as { props?: { meta?: Record<string, string> } }).props?.meta;
      if (meta?.part === "voice-waveform") {
        waveformCount += 1;
      }
    });
    expect(waveformCount).toBe(1);
    expect(() => validate(scene.vnode)).not.toThrow();
  });

  it("emits one selectable scene per slide page", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      pagination: { ...DEFAULT_PROJECT.pagination, flow: "slides", messagesPerPage: 2 },
    };
    const first = buildSvgentScene(project, 0);
    const last = buildSvgentScene(project, 99);
    expect(first.pageCount).toBeGreaterThan(1);
    expect(last.pageIndex).toBe(last.pageCount - 1);
  });

  it.each(["app", "tui"] as const)("carries scrub actions in %s SVG metadata", (surface) => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      messages: [
        { id: "choice", role: "choice", content: "Choose", options: ["A", "B"] },
        { id: "permission", role: "permission", content: "Edit files" },
        { id: "image", role: "image", content: "Draw" },
      ],
    };
    const scene = buildSvgentScene(project, 0);
    expect(scene.messageTimings.map((timing) => timing.message.id)).toEqual([
      "choice",
      "permission",
      "image",
    ]);
    expect(nodesWithAction(scene.vnode, "compose-user")).not.toHaveLength(0);
    expect(nodesWithAction(scene.vnode, "select-choice")).not.toHaveLength(0);
    expect(nodesWithAction(scene.vnode, "write-choice")).not.toHaveLength(0);
    expect(nodesWithAction(scene.vnode, "approve")).not.toHaveLength(0);
    expect(nodesWithAction(scene.vnode, "deny")).not.toHaveLength(0);
    expect(nodesWithAction(scene.vnode, "replace-image")).not.toHaveLength(0);
    if (surface === "tui") {
      expect(nodesWithAction(scene.vnode, "approve-always")).not.toHaveLength(0);
    }
  });

  it.each(["app", "tui"] as const)("keeps %s messages in the transcript band", (surface) => {
    // Both windows have four bands and the transcript is the only one that
    // grows with the session, so the other three are subtracted from its
    // height once. A picker (or any future block) anchored to the window
    // instead of the flow would sit outside that budget and draw on top of
    // the rows above it — which on the terminal surface no terminal can do.
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      // Big type is what turns a layering mistake into a visible collision.
      appearance: { ...DEFAULT_PROJECT.appearance, fontScale: 1.6 },
      messages: [
        { id: "tool", role: "tool", content: "npm test", language: "bash" },
        {
          id: "choice",
          role: "choice",
          content: "Choose",
          options: ["A", "B", "C"],
          // The in-flow contract belongs to the standing card. A collapsing
          // choice moves its live picker into the composer's frame (app) or
          // the band's foot (tui) by design.
          afterSelection: "keep",
        },
        {
          id: "permission",
          role: "permission",
          content: "Edit files",
          afterSelection: "keep",
        },
      ],
    };
    const scene = buildSvgentScene(project, 0);
    const transcript: AnyVNode[] = [];
    walk(scene.vnode, (node) => {
      if (authoringProps(node).meta?.band === "transcript") {
        transcript.push(node);
      }
    });
    expect(transcript).toHaveLength(1);
    const inTranscript = new Set<AnyVNode>();
    for (const band of transcript) {
      walk(band, (node) => inTranscript.add(node));
    }
    const actions = ["select-choice", "write-choice", "approve", "deny"];
    for (const action of actions) {
      const nodes = nodesWithAction(scene.vnode, action);
      expect(nodes).not.toHaveLength(0);
      for (const node of nodes) {
        expect(inTranscript.has(node)).toBe(true);
      }
    }
    // The prompt is the counter-example: it is chrome, and it stays outside.
    for (const node of nodesWithAction(scene.vnode, "compose-user")) {
      expect(inTranscript.has(node)).toBe(false);
    }
  });

  it("keeps the chosen app label muted until the decision animation", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface: "app",
      messages: [
        {
          id: "choice",
          role: "choice",
          content: "Choose",
          options: ["Alpha", "Beta"],
          chosenIndex: 0,
        },
      ],
    };
    const scene = buildSvgentScene(project, 0);
    const [chosenRow] = nodesWithAction(scene.vnode, "select-choice").filter(
      (node) => authoringProps(node).meta?.["option-index"] === "0",
    );
    expect(chosenRow).toBeDefined();
    const labels: AnyVNode[] = [];
    if (chosenRow) {
      walk(chosenRow, (node) => {
        if (node.type === "Text" && directText(node) === "Alpha") {
          labels.push(node);
        }
      });
    }
    expect(labels).toHaveLength(2);
    expect(labels[0] && authoringProps(labels[0]).color).not.toBe(
      labels[1] && authoringProps(labels[1]).color,
    );
    expect(labels.every((node) => authoringProps(node).animate !== undefined)).toBe(true);
  });

  it.each([
    "app",
    "tui",
  ] as const)("reveals Markdown structure with its streamed text on %s", (surface) => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface,
      messages: [
        {
          id: "markdown",
          role: "assistant",
          content: ["- first", "", "1. second", "", "> quote", "", "---"].join("\n"),
        },
      ],
    };
    const scene = buildSvgentScene(project, 0);
    const descendants = messageDescendants(scene.vnode, "markdown");
    const markerDelays = [surface === "tui" ? "-" : "•", "1."].map((marker) => {
      const node = textNode(descendants, marker);
      expect(node, `${marker} should exist`).toBeDefined();
      expect(node && authoringProps(node).animate).toBeDefined();
      return animationDelay(node);
    });
    expect(markerDelays[1]).toBeGreaterThan(markerDelays[0] ?? 0);
    const quote = quoteDecoration(descendants, surface);
    expect(quote).toBeDefined();
    expect(quote && authoringProps(quote).animate).toBeDefined();
    const quoteDelay = animationDelay(quote);
    expect(quoteDelay).toBeGreaterThan(markerDelays[1] ?? 0);
    const rule = ruleDecoration(descendants);
    expect(rule).toBeDefined();
    expect(rule && authoringProps(rule).animate).toBeDefined();
    expect(animationDelay(rule)).toBeGreaterThan(quoteDelay);
  });

  it("uses mutually exclusive complete surfaces for a multi-line app composer", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface: "app",
      messages: [
        {
          id: "multi-line",
          role: "user",
          content: "first line\nsecond line\nthird line",
        },
      ],
    };
    const scene = buildSvgentScene(project, 0);
    const [composer] = nodesWithAction(scene.vnode, "compose-user");
    expect(composer).toBeDefined();
    expect(composer && authoringProps(composer).background).toBeUndefined();
    const surfaces = composer
      ? (composer.children as readonly unknown[]).filter((child): child is AnyVNode => {
          if (typeof child !== "object" || child === null || !("type" in child)) {
            return false;
          }
          const props = authoringProps(child as AnyVNode);
          return (
            child.type === "Box" &&
            props.background?.startsWith("rgba(") === true &&
            props.borderWidth === 1
          );
        })
      : [];
    expect(surfaces).toHaveLength(3);
    const heights = surfaces
      .map((surface) => authoringProps(surface).height ?? 0)
      .sort((left, right) => left - right);
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[0]).toBeLessThan(heights[1] ?? 0);
    expect(heights[1]).toBeLessThan(heights[2] ?? 0);
    expect(surfaces.every((surface) => authoringProps(surface).animate !== undefined)).toBe(true);
  });

  it("raises translucent TUI purple inks toward the readable text color", () => {
    const project: SvgentProject = {
      ...DEFAULT_PROJECT,
      surface: "tui",
      appearance: {
        ...DEFAULT_PROJECT.appearance,
        theme: "synth",
        terminalOpacity: 0.55,
      },
      messages: [{ id: "user", role: "user", content: "hello" }],
    };
    const scene = buildSvgentScene(project, 0, { generator: TEST_GENERATOR });
    const colors = new Map<string, string | undefined>();
    walk(scene.vnode, (node) => {
      if (node.type === "Text") {
        colors.set(directText(node), authoringProps(node).color);
      }
    });
    expect(colors.get("scene-test v1.2.3 · feat/〇〇 · /help for commands")).toMatch(/^rgb\(/u);
    expect(colors.get("❯")).toMatch(/^rgb\(/u);
    expect(colors.get("❯")).not.toBe(DEFAULT_PROJECT.appearance.accent);
  });
});

describe("spacing and placement", () => {
  // The whole point of anchoring the curve at the shipped default: adding
  // size-aware spacing must not restyle anything already authored.
  it("leaves the default font scale untouched and only ever adds room", () => {
    expect(spaceScaleFor(1.5, 1)).toBe(1);
    expect(spaceScaleFor(1, 1)).toBe(1);
    expect(spaceScaleFor(0.8, 1)).toBe(1);
    expect(spaceScaleFor(4, 1)).toBeGreaterThan(1.5);
    expect(spaceScaleFor(5, 1)).toBeGreaterThan(spaceScaleFor(4, 1));
  });

  it("applies the author's spacing on top of the curve", () => {
    expect(spaceScaleFor(1.5, 1.6)).toBeCloseTo(1.6, 5);
    // Below the anchor the curve contributes nothing, so the knob is the
    // only way to tighten — which is the point.
    expect(spaceScaleFor(1, 0.6)).toBeCloseTo(0.6, 5);
  });

  it("tightens prose leading only above the default, and never the terminal grid", () => {
    const at = (fontScale: number) =>
      metricsFor({
        ...DEFAULT_PROJECT,
        appearance: { ...DEFAULT_PROJECT.appearance, fontScale },
      });
    const ratio = (fontScale: number) => at(fontScale).proseLinePx / at(fontScale).prosePx;
    expect(ratio(1.5)).toBeCloseTo(22 / 14, 1);
    expect(ratio(1)).toBeCloseTo(22 / 14, 1);
    expect(ratio(4)).toBeLessThan(ratio(1.5));
    expect(ratio(4)).toBeGreaterThan(1.25);
    // A terminal cell keeps its aspect at every size; that grid is the whole
    // basis of the TUI surface.
    expect(at(4).tuiLinePx / at(4).tuiFontPx).toBeCloseTo(at(1).tuiLinePx / at(1).tuiFontPx, 1);
  });

  it("spends slack only when centring is asked for and content fits", () => {
    const fits = { viewportHeight: 600, insetTop: 16, contentHeight: 200, fullHeight: false };
    expect(contentAlignOffset({ ...fits, align: "start" })).toBe(0);
    expect(contentAlignOffset({ ...fits, align: "center" })).toBe(192);
    // Overflowing content has no slack to spend, and a full-height transcript
    // is sized to its content by construction.
    expect(contentAlignOffset({ ...fits, align: "center", contentHeight: 900 })).toBe(0);
    expect(contentAlignOffset({ ...fits, align: "center", fullHeight: true })).toBe(0);
  });
});

/**
 * The mark is attribution, and attribution only reads as attribution if the
 * viewer can find it. The TUI used to print it in the window title AND on the
 * status line behind a single toggle, so neither copy could be the one that
 * stayed. Its startup banner is a placement of its own — that line is
 * transcript content, and the copy that survives a crop to the transcript.
 */
describe("product mark", () => {
  function markStrings(root: AnyVNode): string[] {
    const found: string[] = [];
    walk(root, (node) => {
      for (const child of node.children as readonly unknown[]) {
        if (typeof child === "string" && child.includes(TEST_GENERATOR.name)) {
          found.push(child);
        }
      }
    });
    return found;
  }

  /** What the scene actually draws, read back in the panel's vocabulary. */
  function drawnPlacements(root: AnyVNode): { places: string[]; count: number } {
    const bands: AnyVNode[] = [];
    walk(root, (node) => {
      if (authoringProps(node).meta?.band === "transcript") {
        bands.push(node);
      }
    });
    const inBanner = bands.flatMap(markStrings).length;
    const count = markStrings(root).length;
    const places: string[] = [];
    if (inBanner > 0) {
      places.push("banner");
    }
    if (count - inBanner > 0) {
      places.push("footer");
    }
    return { places, count };
  }

  it.each(["app", "tui"] as const)("names the product once per %s placement", (surface) => {
    const project: SvgentProject = { ...DEFAULT_PROJECT, surface };
    const scene = buildSvgentScene(project, 0, { generator: TEST_GENERATOR });
    const marks = markStrings(scene.vnode);
    expect(marks).toHaveLength(productMarkPlacements(project, 0).length);
    for (const mark of marks) {
      expect(mark).toContain(`v${TEST_GENERATOR.version}`);
    }
  });

  /*
   * The panel lists the placements from this, so a placement the list forgets
   * is a placement the viewer cannot know about. Bind it to what is drawn.
   */
  const gates = [
    { productMark: true, footer: true, composer: true },
    { productMark: true, footer: false, composer: true },
    { productMark: true, footer: true, composer: false },
    { productMark: true, footer: false, composer: false },
    { productMark: false, footer: true, composer: true },
    { productMark: false, footer: false, composer: true },
  ] as const;

  /*
   * Pages matter: the banner greets once, so page two of a footerless deck
   * carries no mark at all. A predicate blind to the page would tell the
   * panel to print a placement that is not there and swallow the warning.
   */
  const PAGED = Array.from({ length: 9 }, (_, index) => ({
    id: `m${index}`,
    role: "assistant" as const,
    content: `Block ${index}`,
  }));

  it.each(["app", "tui"] as const)("lists every place the %s scene draws it", (surface) => {
    for (const gate of gates) {
      for (const pageIndex of [0, 1]) {
        const project: SvgentProject = {
          ...DEFAULT_PROJECT,
          surface,
          messages: PAGED,
          pagination: { ...DEFAULT_PROJECT.pagination, flow: "slides", messagesPerPage: 3 },
          display: { ...DEFAULT_PROJECT.display, ...gate },
        };
        const scene = buildSvgentScene(project, pageIndex, { generator: TEST_GENERATOR });
        const drawn = drawnPlacements(scene.vnode);
        expect({ ...gate, pageIndex, places: productMarkPlacements(project, pageIndex) }).toEqual({
          ...gate,
          pageIndex,
          places: drawn.places,
        });
        // Presence is not enough: a second copy in one region has to show up.
        expect({ pageIndex, count: drawn.count }).toEqual({
          pageIndex,
          count: drawn.places.length,
        });
      }
    }
  });
});
