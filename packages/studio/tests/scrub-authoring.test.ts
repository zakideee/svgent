import type { SessionMessage } from "@svgent/scene";
import { describe, expect, it } from "vitest";
import { insertAtScrubAnchor } from "../src/scrub.js";

const message = (id: string, pageBreakBefore = false): SessionMessage => ({
  id,
  role: "assistant",
  content: id,
  ...(pageBreakBefore ? { pageBreakBefore: true } : {}),
});

describe("scrub authoring", () => {
  it("inserts after the step currently under the playhead", () => {
    const inserted = { ...message("new"), role: "user" as const };
    const result = insertAtScrubAnchor([message("a"), message("b")], inserted, {
      afterMessageId: "a",
      beforeMessageId: null,
    });
    expect(result.map((entry) => entry.id)).toEqual(["a", "new", "b"]);
  });

  it("keeps an insertion at the start of the current slide", () => {
    const inserted = { ...message("new"), role: "user" as const };
    const result = insertAtScrubAnchor([message("a"), message("b", true), message("c")], inserted, {
      afterMessageId: null,
      beforeMessageId: "b",
    });
    expect(result.map((entry) => entry.id)).toEqual(["a", "new", "b", "c"]);
    expect(result[1]?.pageBreakBefore).toBe(true);
    // Cleared, not false: an explicit false would join pages under the
    // slide-boundary semantics; this spot falls back to the automatic count.
    expect(result[2]?.pageBreakBefore).toBeUndefined();
  });
});
