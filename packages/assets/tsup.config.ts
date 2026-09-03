import { defineConfig } from "tsup";

// Published source maps carry locations only, not embedded source text.
export default defineConfig({
  esbuildOptions(options) {
    options.sourcesContent = false;
  },
});
