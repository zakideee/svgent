import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export function bundledFontPath(fileName: string): string {
  return fileURLToPath(new URL(`../fonts/${fileName}`, import.meta.url));
}

/** Path of a file in the bundled boundsvg runtime: the wasm and its licenses. */
export function bundledBoundsvgRuntimePath(fileName: string): string {
  return fileURLToPath(new URL(`../runtime/boundsvg/${fileName}`, import.meta.url));
}

/**
 * Load the packaged Node WASM wrapper.
 *
 * Only the SIMD build ships. WebAssembly SIMD has been on by default since
 * Node 16.4 and this package requires Node 20, so a scalar fallback could
 * never be reached — and it was 10 MB of what an install pulls down. A
 * runtime that still cannot instantiate it gets told what it needs rather
 * than a slower render it did not ask for.
 */
export function loadBundledBoundsvgWasm(): unknown {
  const require = createRequire(import.meta.url);
  try {
    return require(fileURLToPath(new URL("../runtime/boundsvg/boundsvg.js", import.meta.url)));
  } catch (cause) {
    throw new Error(
      "Could not instantiate the bundled boundsvg WASM module. It needs Node 20 or newer with WebAssembly SIMD enabled.",
      { cause },
    );
  }
}
