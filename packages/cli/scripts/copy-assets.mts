/** Package the runtime files next to the bundled CLI. */
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundledFontPath } from "@svgent/assets/node";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const assetsRoot = path.dirname(path.dirname(bundledFontPath("JetBrainsMono-Regular.woff2")));
await cp(path.join(assetsRoot, "fonts"), path.join(packageRoot, "fonts"), { recursive: true });
await cp(path.join(assetsRoot, "runtime"), path.join(packageRoot, "runtime"), { recursive: true });
const licenseRoot = path.join(packageRoot, "licenses");
await mkdir(licenseRoot, { recursive: true });
const sceneRequire = createRequire(import.meta.resolve("@svgent/scene"));
for (const name of ["marked", "character-entities", "prismjs", "unicode-segmenter"]) {
  let dependencyRoot = path.dirname(sceneRequire.resolve(name));
  while (true) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(dependencyRoot, "package.json"), "utf8"),
      ) as { name?: string };
      if (manifest.name === name) {
        break;
      }
    } catch {}
    const parent = path.dirname(dependencyRoot);
    if (parent === dependencyRoot) {
      throw new Error(`Cannot find the license for ${name}`);
    }
    dependencyRoot = parent;
  }
  const licenseFiles = (await readdir(dependencyRoot)).filter((entry) =>
    /^(?:licen[sc]e|copying)/iu.test(entry),
  );
  if (licenseFiles.length === 0) {
    throw new Error(`Missing license for ${name}`);
  }
  for (const file of licenseFiles) {
    await cp(path.join(dependencyRoot, file), path.join(licenseRoot, `${name}-${file}`));
  }
}
await writeFile(
  path.join(licenseRoot, "NOTICE.txt"),
  "Bundled JavaScript: marked, character-entities, prismjs, unicode-segmenter.\nFont licenses are in fonts/. boundsvg and WASM notices are in runtime/boundsvg/.\n",
);

const distributionRoot = path.join(packageRoot, "package");
await rm(distributionRoot, { recursive: true, force: true });
await mkdir(distributionRoot);
for (const entry of [
  "dist",
  "fonts",
  "runtime",
  "licenses",
  "README.md",
  "LICENSE-MIT",
  "LICENSE-APACHE",
]) {
  await cp(path.join(packageRoot, entry), path.join(distributionRoot, entry), { recursive: true });
}
const manifest = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
) as Record<string, unknown>;
delete manifest.scripts;
delete manifest.devDependencies;
manifest.publishConfig = { access: "public" };
await writeFile(
  path.join(distributionRoot, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
