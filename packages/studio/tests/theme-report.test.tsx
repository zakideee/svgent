// @vitest-environment happy-dom
/**
 * When the host is told, not what it is told.
 *
 * The studio's shell takes the theme in the render that changes it. If the host
 * hears about it afterwards, in a passive effect, the page it paints from that
 * callback lands a frame behind — on first mount the studio comes up in its
 * theme over a page still in whatever it had. Measured on the running app that
 * is exactly one frame; there is no paint here to measure, but the phase the
 * call lands in is the thing that decides it, and that can be read.
 *
 * A passive sentinel declared before the hook is what reads it. Layout effects
 * run before every passive effect in the commit, so the report comes first
 * whatever the declaration order; a report that is itself passive falls in
 * behind the sentinel that was declared ahead of it.
 */
import { act, useEffect, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useReportedTheme } from "../src/theme-report.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

/** A studio, reduced to the theme it hands to the page. */
function Studio({ theme, order }: { theme: "dark" | "light"; order: string[] }) {
  // Both declared before the hook on purpose. A layout sentinel runs once the
  // studio's own DOM is in the document, so a report that lands after it cannot
  // have come from render; a passive sentinel is what a report made passive
  // would fall in behind.
  useLayoutEffect(() => {
    order.push(`dom committed ${theme}`);
  }, [order, theme]);
  useEffect(() => {
    order.push(`page painted ${theme}`);
  }, [order, theme]);
  useReportedTheme(theme, (next) => order.push(`host told ${next}`));
  return null;
}

function mount(node: React.ReactNode): { root: Root; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const entry = { root, host };
  mounted.push(entry);
  return entry;
}

describe("the theme a studio hands to its page", () => {
  it("tells the host before the frame the theme lands in", () => {
    const order: string[] = [];
    mount(<Studio theme="dark" order={order} />);
    expect(order, "the host heard about the theme a frame late").toEqual([
      "dom committed dark",
      "host told dark",
      "page painted dark",
    ]);
  });

  it("tells it again, still first, when the theme changes", () => {
    const order: string[] = [];
    const entry = mount(<Studio theme="dark" order={order} />);
    order.length = 0;
    act(() => entry.root.render(<Studio theme="light" order={order} />));
    expect(order).toEqual(["dom committed light", "host told light", "page painted light"]);
  });

  it("says nothing on a render that did not change the theme", () => {
    const order: string[] = [];
    const entry = mount(<Studio theme="dark" order={order} />);
    order.length = 0;
    act(() => entry.root.render(<Studio theme="dark" order={order} />));
    expect(order, "a render the theme sat out still called the host").toEqual([]);
  });

  it("keeps calling the callback the host last gave it", () => {
    const seen: string[] = [];
    function Host() {
      const [theme, setTheme] = useState<"dark" | "light">("dark");
      // A fresh closure every render, which is what a host writes.
      useReportedTheme(theme, (next) => seen.push(`${next}@${theme}`));
      return (
        <button type="button" onClick={() => setTheme("light")}>
          switch
        </button>
      );
    }
    const entry = mount(<Host />);
    const button = entry.host.querySelector("button");
    if (button === null) {
      throw new Error("no button to press");
    }
    act(() => button.click());
    expect(seen).toEqual(["dark@dark", "light@light"]);
  });
});
