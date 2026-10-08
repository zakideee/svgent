import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.mts"],
  format: ["esm"],
  clean: true,
  noExternal: [/^@svgent\//u, "marked", "character-entities", "prismjs", "unicode-segmenter"],
});
