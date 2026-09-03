/**
 * Two things an overlay holds belong to the page, not to the overlay: the
 * scroll it freezes, and Escape. Both are wrong in the same way when each
 * overlay answers for itself — one closing unfreezes the page under another
 * still standing, and one press closes every overlay on the page at once.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { raisedOverlayCount, raiseOverlay } from "../src/overlays.js";

type FakePage = {
  page: Document;
  view: Window;
  /** Whether the layout that pins the body is the current one. */
  narrow: (value: boolean) => void;
  classes: Set<string>;
  properties: Map<string, string>;
  scrolledTo: number[];
  press: (key: string, event?: Partial<KeyboardEvent>) => void;
};

function fakePage(scrollY = 0): FakePage {
  const classes = new Set<string>();
  const properties = new Map<string, string>();
  const scrolledTo: number[] = [];
  const keyListeners = new Set<(event: KeyboardEvent) => void>();
  const root = {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
  };
  const page = {
    documentElement: root,
    addEventListener: (_type: string, listener: (event: KeyboardEvent) => void) => {
      keyListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: KeyboardEvent) => void) => {
      keyListeners.delete(listener);
    },
  } as unknown as Document;
  // Modelled because the offset the narrow layout reads is the thing a lock
  // may only ever write once, before anyone knows which layout will be current
  // when it is released.
  let narrow = false;
  const view = {
    scrollY,
    scrollTo: (options: { top: number }) => scrolledTo.push(options.top),
    matchMedia: (_query: string) => ({ matches: narrow }),
  } as unknown as Window;
  return {
    page,
    view,
    narrow: (value: boolean) => {
      narrow = value;
    },
    classes,
    properties,
    scrolledTo,
    press: (key: string, event: Partial<KeyboardEvent> = {}) => {
      for (const listener of [...keyListeners]) {
        listener({ key, ...event } as KeyboardEvent);
      }
    },
  };
}

describe("the overlay on top is the one Escape reaches", () => {
  it("dismisses only the last raised", () => {
    const dismissed: string[] = [];
    const world = fakePage();
    raiseOverlay(world.page, world.view, () => dismissed.push("first"));
    raiseOverlay(world.page, world.view, () => dismissed.push("second"));

    world.press("Escape");
    expect(dismissed).toEqual(["second"]);
  });

  it("hands Escape back down when the top comes off", () => {
    const dismissed: string[] = [];
    const world = fakePage();
    raiseOverlay(world.page, world.view, () => dismissed.push("first"));
    const releaseSecond = raiseOverlay(world.page, world.view, () => dismissed.push("second"));

    releaseSecond();
    world.press("Escape");
    expect(dismissed).toEqual(["first"]);
  });

  /*
   * Escape ends an IME composition, and the key still arrives here. Dropping a
   * candidate in a field inside an overlay must not take the overlay with it —
   * this UI ships in Japanese.
   */
  it("leaves a composition's Escape to the composition", () => {
    const dismissed: string[] = [];
    const world = fakePage();
    raiseOverlay(world.page, world.view, () => dismissed.push("only"));
    world.press("Escape", { isComposing: true });
    expect(dismissed).toEqual([]);
  });

  /*
   * A modal `<dialog>` is promoted to the top layer, above everything on this
   * stack, and the browser closes it on this very key. It is the overlay on
   * top; the stack does not get to answer over it.
   */
  it("leaves a modal dialog's Escape to the dialog", () => {
    const dismissed: string[] = [];
    const world = fakePage();
    raiseOverlay(world.page, world.view, () => dismissed.push("guide"));
    const insideDialog = {
      closest: (selector: string) => (selector === "dialog[open]" ? {} : null),
    };
    world.press("Escape", { target: insideDialog as unknown as EventTarget });
    expect(dismissed, "the guide closed under the picker").toEqual([]);

    // And the same key outside one still reaches the overlay.
    world.press("Escape", {
      target: { closest: () => null } as unknown as EventTarget,
    });
    expect(dismissed).toEqual(["guide"]);
  });

  it("leaves every other key alone", () => {
    const dismissed: string[] = [];
    const world = fakePage();
    raiseOverlay(world.page, world.view, () => dismissed.push("only"));
    world.press("Enter");
    expect(dismissed).toEqual([]);
  });

  it("stops listening once the last one is down", () => {
    const dismissed: string[] = [];
    const world = fakePage();
    const release = raiseOverlay(world.page, world.view, () => dismissed.push("only"));
    release();
    world.press("Escape");
    expect(dismissed).toEqual([]);
  });
});

describe("the page is held from the first overlay to the last", () => {
  it("locks once, at the scroll the first overlay found", () => {
    const world = fakePage(1_400);
    raiseOverlay(world.page, world.view, () => {});
    expect(world.classes.has("svgent-scroll-locked")).toBe(true);
    expect(world.properties.get("--svgent-locked-page-top")).toBe("-1400px");

    // A second overlay must not re-read a scroll the lock already froze.
    (world.view as { scrollY: number }).scrollY = 0;
    raiseOverlay(world.page, world.view, () => {});
    expect(world.properties.get("--svgent-locked-page-top")).toBe("-1400px");
  });

  /*
   * The offset is written on every layout, not only the narrow one that reads
   * it. The window can cross the breakpoint while an overlay is up, and the
   * rule that pins the body would otherwise find nothing and pin it at the top
   * — the page jumping to the start of the document under a dialog.
   */
  it("writes the offset on the layout that does not read it", () => {
    const world = fakePage(240);
    world.narrow(false);
    raiseOverlay(world.page, world.view, () => {});
    expect(world.properties.get("--svgent-locked-page-top"), "written only where it is read").toBe(
      "-240px",
    );

    // Now the window is narrowed while the overlay is up, and the rule that
    // pins the body starts reading a property nobody has written since.
    world.narrow(true);
    expect(world.properties.get("--svgent-locked-page-top")).toBe("-240px");
  });

  it("stays locked while any overlay is still up, in either release order", () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const world = fakePage(900);
      const releases = [
        raiseOverlay(world.page, world.view, () => {}),
        raiseOverlay(world.page, world.view, () => {}),
      ];
      releases[order[0] as number]?.();
      expect(world.classes.has("svgent-scroll-locked"), `after ${order[0]}`).toBe(true);
      expect(world.scrolledTo).toEqual([]);
      releases[order[1] as number]?.();
      expect(world.classes.has("svgent-scroll-locked"), `after ${order[1]}`).toBe(false);
      expect(world.scrolledTo).toEqual([900]);
      expect(world.properties.has("--svgent-locked-page-top")).toBe(false);
    }
  });

  it("puts back the scroll the first overlay froze, once", () => {
    const world = fakePage(512);
    const release = raiseOverlay(world.page, world.view, () => {});
    release();
    release();
    expect(world.scrolledTo).toEqual([512]);
  });

  it("counts what is up, per document", () => {
    const one = fakePage();
    const two = fakePage();
    const release = raiseOverlay(one.page, one.view, () => {});
    raiseOverlay(two.page, two.view, () => {});
    expect(raisedOverlayCount(one.page)).toBe(1);
    expect(raisedOverlayCount(two.page)).toBe(1);
    release();
    expect(raisedOverlayCount(one.page)).toBe(0);
    expect(raisedOverlayCount(two.page)).toBe(1);
  });
});

/*
 * The hook is the seam the registry cannot defend. Depending on the callback
 * tears this overlay off the stack and pushes it back on at every render of the
 * component holding it: the top becomes whichever studio rendered most
 * recently rather than whichever overlay opened last, and the page unlocks and
 * relocks — `scrollTo` and all — once per render.
 *
 * `useEffectEvent` does not avoid it. React returns a fresh closure from it on
 * every render and only the implementation behind it is stable, which is why
 * its own rule is that it may not appear in a dependency array.
 */
describe("raising an overlay survives a re-render", () => {
  it("depends on whether it is raised, and on nothing else", async () => {
    const source = await readFile(new URL("../src/overlays.ts", import.meta.url), "utf8");
    const hook = source.slice(source.indexOf("export function useRaisedOverlay"));
    expect(hook, "the raise effect").toContain("}, [raised]);");
    expect(hook, "an effect event would be a fresh closure each render").not.toContain(
      "useEffectEvent",
    );
    expect(hook, "the callback has to be read at call time").toMatch(/dismiss\.current\(\)/u);
  });
});
