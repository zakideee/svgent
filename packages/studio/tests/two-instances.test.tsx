// @vitest-environment happy-dom
/**
 * Two studios in one document, actually mounted.
 *
 * Every step of this work has been checked by reading the source, by driving
 * the registry underneath the hook, and by looking at a browser by hand. None
 * of those reach the seam between React and the state a page shares — and that
 * is where the worst defect of the four steps lived: an overlay was taken off
 * the stack and pushed back on at every render, so the top became whichever
 * studio rendered most recently rather than whichever overlay opened last.
 * Nothing here could have caught it. This can.
 *
 * The studio itself cannot be mounted in this environment — its engine loads a
 * wasm binary through a fetch the loader builds from `import.meta.url`, and it
 * is created inside a hook rather than passed in. So what stands in for a
 * studio is the part that holds the shared state: an overlay raised from a
 * component, twice, in one document.
 */
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { raisedOverlayCount, useRaisedOverlay } from "../src/overlays.js";

// React holds to `act`'s contract only once it has been told it is under a
// test. Absent this every call warns and whether anything flushed is luck.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** A root and the element it was rendered into, kept so both can be undone. */
type Mounted = { root: Root; host: HTMLElement };

const mounted: Mounted[] = [];

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  // Read before the reset and asked after it: these tests share one document,
  // so a lock left standing would be wiped here and go unnoticed.
  const leftRaised = raisedOverlayCount(document);
  const leftLocked = locked();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  expect(leftRaised, "an overlay outlived the studio holding it").toBe(0);
  expect(leftLocked, "the page was left frozen").toBe(false);
});

/** A studio, reduced to the thing it shares with the page. */
function Studio({
  name,
  open,
  onDismiss,
}: {
  name: string;
  open: boolean;
  onDismiss: (name: string) => void;
}) {
  const [, setTick] = useState(0);
  useRaisedOverlay(open, () => onDismiss(name));
  return (
    <button type="button" data-studio={name} onClick={() => setTick((count) => count + 1)}>
      {name}
    </button>
  );
}

function mount(node: React.ReactNode): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const entry: Mounted = { root, host };
  mounted.push(entry);
  return entry;
}

/**
 * Renders the named studio once more. The button is insisted upon: a selector
 * that quietly missed would take the re-render with it and leave the test
 * green while proving nothing.
 */
function reRender(entry: Mounted, name: string): void {
  const button = entry.host.querySelector<HTMLButtonElement>(`[data-studio="${name}"]`);
  if (button === null) {
    throw new Error(`no studio named ${name} to re-render`);
  }
  act(() => button.click());
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

const locked = (): boolean => document.documentElement.classList.contains("svgent-scroll-locked");

describe("two studios raising overlays in one document", () => {
  it("gives Escape to the overlay that opened last", () => {
    const dismissed: string[] = [];
    mount(<Studio name="first" open onDismiss={(name) => dismissed.push(name)} />);
    mount(<Studio name="second" open onDismiss={(name) => dismissed.push(name)} />);

    pressEscape();
    expect(dismissed, "one press closed more than one studio").toEqual(["second"]);
  });

  /*
   * The defect the four steps came closest to shipping. Anything re-renders a
   * studio — an export ticking its elapsed seconds, a hover, a keystroke — and
   * an overlay that re-registers on each render climbs to the top of a stack it
   * never left.
   */
  it("does not reorder the stack when a studio re-renders", () => {
    const dismissed: string[] = [];
    const first = mount(<Studio name="first" open onDismiss={(name) => dismissed.push(name)} />);
    mount(<Studio name="second" open onDismiss={(name) => dismissed.push(name)} />);

    for (let render = 0; render < 3; render += 1) {
      reRender(first, "first");
    }

    pressEscape();
    expect(dismissed, "the studio that rendered last answered instead of the one on top").toEqual([
      "second",
    ]);
  });

  it("holds the page until the last overlay comes down", () => {
    const first = mount(<Studio name="first" open onDismiss={() => {}} />);
    const second = mount(<Studio name="second" open onDismiss={() => {}} />);
    expect(locked()).toBe(true);

    act(() => first.root.unmount());
    expect(locked(), "one studio's close unfroze the page under the other").toBe(true);

    act(() => second.root.unmount());
    expect(locked()).toBe(false);
  });

  it("keeps the page still across a re-render", () => {
    const only = mount(<Studio name="only" open onDismiss={() => {}} />);
    // Locked at the end is what the broken shape looked like too: it dropped
    // the lock and took it back inside one commit. The scroll it put the page
    // back to on the way through is the half that shows.
    const scrolledTo: number[] = [];
    const restore = window.scrollTo;
    window.scrollTo = ((options: ScrollToOptions) => {
      scrolledTo.push(options.top ?? 0);
    }) as typeof window.scrollTo;
    try {
      reRender(only, "only");
    } finally {
      window.scrollTo = restore;
    }
    expect(scrolledTo, "a render dropped the lock and took it again").toEqual([]);
    expect(locked()).toBe(true);
  });

  it("lets go when a studio unmounts with its overlay still up", () => {
    const dismissed: string[] = [];
    const only = mount(<Studio name="only" open onDismiss={(name) => dismissed.push(name)} />);
    act(() => only.root.unmount());

    expect(locked()).toBe(false);
    pressEscape();
    expect(dismissed, "a studio that is gone still answered").toEqual([]);
  });

  it("survives the double mount StrictMode performs", () => {
    const dismissed: string[] = [];
    mount(
      <StrictMode>
        <Studio name="strict" open onDismiss={(name) => dismissed.push(name)} />
      </StrictMode>,
    );
    // Escape only ever asks the top of the stack once, so the dismissals alone
    // read the same whether one overlay is raised or two. The count is the
    // claim.
    expect(raisedOverlayCount(document), "the discarded mount left its overlay up").toBe(1);
    expect(locked()).toBe(true);
    pressEscape();
    expect(dismissed, "the discarded mount answered as well").toEqual(["strict"]);
  });
});
