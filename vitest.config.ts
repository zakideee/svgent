import { defineConfig } from "vitest/config";

// Scene and integration tests rasterize in WASM for seconds at a time. On a
// small CI runner, one worker per core leaves the coordinating process
// starved, and a worker's status update then times out even though every
// test passes. Two workers keep it responsive there; local runs keep the
// default.
export default defineConfig({
  test: {
    maxWorkers: process.env.CI ? 2 : undefined,
  },
});
