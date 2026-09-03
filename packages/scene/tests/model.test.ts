import {
  AGENT_BEHAVIOR_PRESETS,
  disclosureFor,
  modelLabelIssue,
  REENACTMENT_BADGE,
  resolveSafeModelLabel,
  SAFE_MODEL_LABEL,
  SCENE_PACING_PRESETS,
  SIMULATION_BADGE,
  USER_INPUT_PRESETS,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";

describe("model label validation", () => {
  // Shape checks only: svgent does not police model names (an unbounded
  // denylist would always be stale). The artifact's nature is carried by
  // the provenance metadata, not by label lists.
  it("passes any name through untouched, real products included", () => {
    expect(modelLabelIssue("Claude 4")).toBeNull();
    expect(resolveSafeModelLabel("Claude 4")).toBe("Claude 4");
    expect(modelLabelIssue("Aster 4 · fictional")).toBeNull();
    expect(resolveSafeModelLabel("Aster 4 · fictional")).toBe("Aster 4 · fictional");
  });

  it("rejects empty and overlong labels", () => {
    expect(modelLabelIssue("")).toBe("empty");
    expect(modelLabelIssue("x".repeat(41))).toBe("too-long");
    expect(resolveSafeModelLabel("")).toBe(SAFE_MODEL_LABEL);
  });

  it("keeps the disclosure strings unambiguous", () => {
    expect(SIMULATION_BADGE).toContain("SIMULATED");
    expect(SIMULATION_BADGE).toContain("FICTIONAL");
    expect(REENACTMENT_BADGE).toContain("SIMULATED");
    expect(disclosureFor("fictional")).toBe(SIMULATION_BADGE);
    expect(disclosureFor("reenactment")).toBe(REENACTMENT_BADGE);
  });
});

/**
 * The three preset groups are the Studio's claim about who owns which
 * second: the reader, the agent, or the edit. A value that lands in the
 * wrong group is not a bug the preview can show — the scene plays fine and
 * only the label is a lie — so the split is pinned here.
 *
 * `permissionMs` is the case that motivated this. The card is the agent's
 * to offer, but the dwell before it is answered is the reader deciding, and
 * it times the choice picker as well as the permission prompt. It belongs
 * to no group: it stays a slider of its own.
 */
describe("timing preset groups", () => {
  const keysOf = (presets: typeof USER_INPUT_PRESETS): Set<string> =>
    new Set(presets.flatMap((preset) => Object.keys(preset.apply)));

  it("keeps the reader's keys out of the agent's group", () => {
    expect([...keysOf(AGENT_BEHAVIOR_PRESETS)].sort()).toEqual([
      "agentTypingCps",
      "imageGenMs",
      "thinkingMs",
      "toolRunMs",
    ]);
  });

  it("keeps the agent's keys out of the reader's group", () => {
    expect([...keysOf(USER_INPUT_PRESETS)].sort()).toEqual(["userTypingCps"]);
  });

  it("leaves the edit's own pacing to the scene group", () => {
    expect([...keysOf(SCENE_PACING_PRESETS)].sort()).toEqual(["finalHoldMs", "transitionMs"]);
  });

  it("gives every group's presets the same keys, so switching is reversible", () => {
    for (const presets of [USER_INPUT_PRESETS, AGENT_BEHAVIOR_PRESETS, SCENE_PACING_PRESETS]) {
      const shared = keysOf(presets);
      for (const preset of presets) {
        expect(new Set(Object.keys(preset.apply)), preset.id).toEqual(shared);
      }
    }
  });
});
