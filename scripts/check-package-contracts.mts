import { spawnSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const SVGENT_PACKAGES = ["assets", "scene", "render", "studio", "cli", "authoring"];
const BOUNDSVG_PACKAGES = ["shape", "core", "browser", "video", "worker"];

/**
 * The engine version the consumer resolves from the registry — the same
 * pinned release the workspace itself depends on, so the contract check
 * exercises what a clean-room install would actually fetch.
 */
async function boundsvgRegistryVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "packages/scene/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const version = manifest.dependencies?.["@boundsvg/core"];
  if (version === undefined || !/^\d/u.test(version)) {
    throw new Error("packages/scene does not pin a registry @boundsvg/core version");
  }
  return version;
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with ${String(result.status)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout;
}

async function tarballFor(directory: string, packageName: string): Promise<string> {
  const prefix = packageName.replace(/^@/u, "").replace("/", "-");
  const file = (await readdir(directory)).find(
    (candidate) => candidate.startsWith(`${prefix}-`) && candidate.endsWith(".tgz"),
  );
  if (!file) {
    throw new Error(`No tarball was produced for ${packageName}`);
  }
  return path.join(directory, file);
}

function tarEntries(tarball: string): string[] {
  return run("tar", ["-tf", tarball], repositoryRoot).trim().split("\n");
}

function packedManifest(tarball: string): Record<string, unknown> {
  return JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"], repositoryRoot));
}

function assertPackageContract(packageName: string, tarball: string): void {
  const entries = tarEntries(tarball);
  for (const required of [
    "package/package.json",
    "package/LICENSE-MIT",
    "package/LICENSE-APACHE",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`${packageName} is missing ${required.replace("package/", "")}`);
    }
  }
  if (entries.some((entry) => entry.startsWith("package/src/"))) {
    throw new Error(`${packageName} leaked source files into its tarball`);
  }
  const manifestText = JSON.stringify(packedManifest(tarball));
  if (/\b(?:link|workspace):/u.test(manifestText)) {
    throw new Error(`${packageName} contains a local-only dependency specifier`);
  }
  if (packageName === "@svgent/studio" && !entries.includes("package/dist/index.css")) {
    throw new Error("@svgent/studio is missing its public CSS entry");
  }
  if (
    packageName === "@svgent/assets" &&
    !entries.some((entry) => entry === "package/fonts/JetBrainsMono-Regular.woff2")
  ) {
    throw new Error("@svgent/assets is missing bundled fonts");
  }
  if (
    packageName === "@svgent/assets" &&
    !entries.includes("package/runtime/boundsvg/boundsvg_bg.wasm")
  ) {
    throw new Error("@svgent/assets is missing the Node rendering runtime");
  }
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "svgent-package-contracts-"));
  const tarballDirectory = path.join(temporaryRoot, "tarballs");
  const consumerDirectory = path.join(temporaryRoot, "consumer");
  try {
    await mkdir(tarballDirectory, { recursive: true });
    await mkdir(consumerDirectory, { recursive: true });

    const dependencies: Record<string, string> = {
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    };
    const devDependencies: Record<string, string> = {
      vite: "^6.0.0",
    };
    const localTarballOverrides: Record<string, string> = {};

    const engineVersion = await boundsvgRegistryVersion();
    for (const shortName of BOUNDSVG_PACKAGES) {
      const packageName = `@boundsvg/${shortName}`;
      dependencies[packageName] = engineVersion;
      localTarballOverrides[packageName] = engineVersion;
    }

    for (const shortName of SVGENT_PACKAGES) {
      const packageName = `@svgent/${shortName}`;
      run(
        "pnpm",
        ["--filter", packageName, "pack", "--pack-destination", tarballDirectory],
        repositoryRoot,
      );
      const tarball = await tarballFor(tarballDirectory, packageName);
      assertPackageContract(packageName, tarball);
      const tarballSpec = `file:${tarball}`;
      dependencies[packageName] = tarballSpec;
      localTarballOverrides[packageName] = tarballSpec;
    }

    await writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "svgent-packed-consumer",
          private: true,
          type: "module",
          scripts: { build: "vite build" },
          dependencies,
          devDependencies,
          pnpm: { overrides: localTarballOverrides },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(consumerDirectory, "consumer.mjs"),
      [
        'import { access } from "node:fs/promises";',
        'import { fileURLToPath } from "node:url";',
        'import { bundledFontPath } from "@svgent/assets/node";',
        'import { DEFAULT_PROJECT, buildSvgentScene } from "@svgent/scene";',
        'import { RENDERABLE_KINDS } from "@svgent/render";',
        'import { Studio } from "@svgent/studio";',
        "const scene = buildSvgentScene(DEFAULT_PROJECT, 0);",
        'if (scene.pageCount < 1 || !RENDERABLE_KINDS.includes("poster-svg") || typeof Studio !== "function") throw new Error("public entrypoint smoke failed");',
        'await access(bundledFontPath("JetBrainsMono-Regular.woff2"));',
        'await access(fileURLToPath(import.meta.resolve("@svgent/studio/styles.css")));',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "index.html"),
      [
        '<!doctype html><html lang="en"><head><meta charset="UTF-8" />',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
        "<title>svgent packed consumer</title></head><body>",
        '<div id="root"></div><script type="module" src="/src.js"></script>',
        "</body></html>",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "src.js"),
      [
        'import { createElement } from "react";',
        'import { createRoot } from "react-dom/client";',
        'import { Studio } from "@svgent/studio";',
        'import "@svgent/studio/styles.css";',
        'const root = document.querySelector("#root");',
        'if (!root) throw new Error("missing mount root");',
        "createRoot(root).render(createElement(Studio, { persistence: false }));",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "vite.config.js"),
      ["export default {", '  worker: { format: "es" },', "};", ""].join("\n"),
    );
    await writeFile(
      path.join(consumerDirectory, "pnpm-workspace.yaml"),
      [
        "packages:",
        '  - "."',
        "# Same-author engine releases, consumed the day they publish — the",
        "# workspace carries the same exclusion.",
        "minimumReleaseAgeExclude:",
        ...BOUNDSVG_PACKAGES.map((shortName) => `  - "@boundsvg/${shortName}"`),
        "# The packed tarballs stand in for the registry: pnpm 10 reads",
        "# overrides from the workspace file, not from package.json.",
        "overrides:",
        ...Object.entries(localTarballOverrides).map(([name, spec]) => `  "${name}": "${spec}"`),
        "",
      ].join("\n"),
    );
    run("pnpm", ["install", "--ignore-scripts", "--no-frozen-lockfile"], consumerDirectory);
    run("node", ["consumer.mjs"], consumerDirectory);
    run("pnpm", ["build"], consumerDirectory);
    await access(path.join(consumerDirectory, "dist/index.html"));
    const consumerAssets = await readdir(path.join(consumerDirectory, "dist/assets"));
    if (!consumerAssets.some((file) => file.endsWith(".css"))) {
      throw new Error("packed Studio consumer build did not emit public CSS");
    }
    await copyFile(
      path.join(repositoryRoot, "examples/logo-motion.json"),
      path.join(consumerDirectory, "logo-motion.json"),
    );
    run(
      "pnpm",
      [
        "exec",
        "svgent",
        "logo-motion.json",
        "--out",
        "rendered",
        "--formats",
        "poster-svg,poster-png",
        "--strict",
      ],
      consumerDirectory,
    );
    await access(path.join(consumerDirectory, "rendered/logo-motion-01.svg"));
    await access(path.join(consumerDirectory, "rendered/logo-motion-01.png"));
    process.stdout.write("Packed package contracts and external consumer smoke passed.\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
