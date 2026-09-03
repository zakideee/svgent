import {
  completionCount,
  createCompletionSpan,
  createImeSpan,
  draftTypedText,
  imeConversionCount,
  parseDraftSegments,
  stripDraftMarkup,
} from "@svgent/scene";
import { describe, expect, it } from "vitest";
import { planDraftTyping } from "../src/composer.js";

describe("IME markup", () => {
  it("builds validated spans for a selected written range", () => {
    expect(createImeSpan("画面", "がめん")).toBe("[[画面|がめん]]");
    expect(createImeSpan("鯖", " サーバー ")).toBe("[[鯖|サーバー]]");
    expect(createImeSpan("", "かな")).toBeNull();
    expect(createImeSpan("画面", "screen")).toBeNull();
    expect(createImeSpan("[[画面]]", "がめん")).toBeNull();
    expect(createImeSpan("画面\n全体", "がめん")).toBeNull();
  });

  it("converts kana-reading spans", () => {
    const content = "この[[画面|がめん]]の[[配色|はいしょく]]を直して";
    expect(stripDraftMarkup(content)).toBe("この画面の配色を直して");
    expect(draftTypedText(content)).toBe("このがめんのはいしょくを直して");
    expect(imeConversionCount(content)).toBe(2);
    expect(parseDraftSegments(content).map((segment) => segment.typed ?? "")).toEqual([
      "",
      "がめん",
      "",
      "はいしょく",
      "",
    ]);
  });

  it("leaves code-like double brackets alone — readings must be kana", () => {
    for (const literal of ["x[[i|0]]", "`arr[[a|b]]`", "[[Page|Alias]]", "[[값|value]]"]) {
      expect(stripDraftMarkup(literal)).toBe(literal);
      expect(imeConversionCount(literal)).toBe(0);
    }
  });

  it("supports katakana readings", () => {
    expect(stripDraftMarkup("[[鯖|サーバー]]を再起動")).toBe("鯖を再起動");
    expect(draftTypedText("[[鯖|サーバー]]を再起動")).toBe("サーバーを再起動");
  });
});

describe("completion markup", () => {
  it("builds a span only when the typed part is a shorter prefix", () => {
    expect(createCompletionSpan("pnpm build", "pn")).toBe("{{pnpm build|pn}}");
    expect(createCompletionSpan("@src/config.ts", "@src/co")).toBe("{{@src/config.ts|@src/co}}");
    // Not a prefix: nothing about pressing Tab would produce this.
    expect(createCompletionSpan("pnpm build", "build")).toBeNull();
    // Nothing left to arrive.
    expect(createCompletionSpan("pnpm", "pnpm")).toBeNull();
    expect(createCompletionSpan("pnpm", "")).toBeNull();
    expect(createCompletionSpan("", "p")).toBeNull();
    expect(createCompletionSpan("a{b}", "a")).toBeNull();
    expect(createCompletionSpan("two\nlines", "two")).toBeNull();
  });

  it("types the prefix and shows the finished text", () => {
    const content = "{{pnpm typecheck|pnpm ty}} を流して";
    expect(stripDraftMarkup(content)).toBe("pnpm typecheck を流して");
    expect(draftTypedText(content)).toBe("pnpm ty を流して");
    expect(completionCount(content)).toBe(1);
    expect(imeConversionCount(content)).toBe(0);
  });

  it("leaves template syntax alone — the typed part has to be a prefix", () => {
    // The rule that keeps an authored completion honest is also what stops a
    // Handlebars or Jinja expression from being animated as one.
    for (const literal of ["{{name|upper}}", "{{ user.name }}", "{{a|b}}", "{{x|xy}}"]) {
      expect(stripDraftMarkup(literal)).toBe(literal);
      expect(completionCount(literal)).toBe(0);
    }
  });

  it("mixes with conversion spans in one draft", () => {
    const content = "{{@src/env.ts|@src/e}} の[[定数|ていすう]]を直して";
    expect(stripDraftMarkup(content)).toBe("@src/env.ts の定数を直して");
    expect(draftTypedText(content)).toBe("@src/e のていすうを直して");
    expect(completionCount(content)).toBe(1);
    expect(imeConversionCount(content)).toBe(1);
    expect(parseDraftSegments(content).map((segment) => segment.kind ?? "plain")).toEqual([
      "completion",
      "plain",
      "ime",
      "plain",
    ]);
  });

  it("preserves hard newlines while IME and completion phases replace their text", () => {
    const phases = planDraftTyping({
      content: "first\n[[漢字|かな]]\n{{path/file|path}}",
      startMs: 180,
      charsPerSecond: 10,
    });

    // The written form holds underlined for the commit beat, so the run is
    // three states rather than two: keyed kana, converted, committed.
    expect(phases?.map((phase) => phase.text)).toEqual([
      "first\nかな",
      "first\n漢字",
      "first\n漢字\npath",
      "first\n漢字\npath/file",
    ]);
    expect(phases?.map((phase) => phase.composing?.settled)).toEqual([
      false,
      true,
      undefined,
      undefined,
    ]);
  });
});
