import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const coreRoot = path.dirname(require.resolve("@boundsvg/core/package.json"));
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetRoot = path.join(packageRoot, "runtime/boundsvg");

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });

// The scalar (non-SIMD) build is deliberately not copied. WebAssembly SIMD
// has been on by default since Node 16.4 and this package requires Node 20,
// so the fallback could never be reached — and at 10 MB it was two thirds of
// what an install pulls down.
for (const relativePath of ["package.json", "boundsvg.js", "boundsvg_bg.wasm"]) {
  await copyFile(
    path.join(coreRoot, "wasm-pkg", relativePath),
    path.join(targetRoot, relativePath),
  );
}

for (const license of ["LICENSE-MIT", "LICENSE-APACHE", "THIRD-PARTY-LICENSES"]) {
  await copyFile(path.join(coreRoot, license), path.join(targetRoot, license));
}
