import { readFile } from "node:fs/promises";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledFontPath, loadBundledBoundsvgWasm } from "@svgent/assets/node";
import { describe, expect, it } from "vitest";

describe("bundled assets", () => {
  it.each(Object.values(BUNDLED_FONT_FILES))("ships %s with non-empty font bytes", async (file) => {
    const bytes = await readFile(bundledFontPath(file));
    expect(bytes.byteLength).toBeGreaterThan(1_000);
  });

  it.each(["LICENSE-MIT", "LICENSE-APACHE"])("ships %s", async (file) => {
    const contents = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    expect(contents.length).toBeGreaterThan(100);
  });

  it("loads the packaged Node WASM module independently of cwd", () => {
    expect(loadBundledBoundsvgWasm()).toBeTypeOf("object");
  });
});
