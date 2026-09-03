import { assertIdentifierNamespace } from "@svgent/render";
import { describe, expect, it } from "vitest";
import { instantiatePreset, SCRIPT_PRESETS } from "../src/presets.js";

describe("Studio presets", () => {
  it("keeps every preset within authoring limits", () => {
    for (const lang of ["ja", "en"] as const) {
      for (const preset of SCRIPT_PRESETS) {
        const messages = instantiatePreset(preset, lang);
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.length).toBeLessThanOrEqual(12);
        expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
        expect(
          messages.reduce((sum, message) => sum + message.content.length, 0),
        ).toBeLessThanOrEqual(3_200);
      }
    }
  });
});

describe("preset translation pairs", () => {
  // The two languages are kept as a translation pair rather than independent
  // originals, on the grounds that a drift between them is something you can
  // see and fix. That only holds if something looks: these are the checks.
  it("runs the same beats in both languages", () => {
    for (const preset of SCRIPT_PRESETS) {
      // Roles and highlights together: a one-sided highlight would give one
      // language a held note the other never plays.
      const beats = (lang: "ja" | "en") =>
        instantiatePreset(preset, lang).map((message) => ({
          role: message.role,
          highlight: message.highlight === true,
        }));
      expect(beats("en"), `${preset.id} should follow the Japanese beat for beat`).toEqual(
        beats("ja"),
      );
    }
  });

  it("keeps the pair's identifiers in correspondence", () => {
    for (const preset of SCRIPT_PRESETS) {
      const { ja, en } = preset.variants;
      if (preset.id === "template") {
        // The scaffold's labels are placeholders, substituted per language
        // (〇〇 / TOPIC), so they correspond without being equal.
        continue;
      }
      expect([en.title, en.workspaceLabel, en.branchLabel], preset.id).toEqual([
        ja.title,
        ja.workspaceLabel,
        ja.branchLabel,
      ]);
    }
  });
});

/*
 * The gallery names each thumbnail's identifiers after the preset, and the
 * name is built by a helper that refuses anything outside `[a-zA-Z0-9-]`. Both
 * gallery renders sit inside a `catch`, so a preset id with an underscore in
 * it does not raise anything a person would see — the card just falls back to
 * text, indistinguishable from a preset that failed to draw.
 */
describe("every preset can name what it draws", () => {
  it("carries an id the identifier rules accept", () => {
    for (const preset of SCRIPT_PRESETS) {
      expect(() => assertIdentifierNamespace(preset.id), preset.id).not.toThrow();
    }
  });
});
