/**
 * Regenerates every committed artifact: the README demos, the landing hero
 * loop, and the inputs page samples.
 *
 * These files have to follow the render pipeline: change a `readme-*`
 * script, change `packages/scene` or `packages/render` in a way that moves
 * pixels, or update boundsvg, and the README starts showing something the
 * tool no longer produces. A prose command list is easy to skip, so the
 * list lives here instead. `pnpm demos:regen` renders into a temporary
 * directory, renders a second time into another, and only replaces the
 * committed files when the two agree byte for byte. The pipeline is
 * deterministic, so a mismatch is a real finding rather than noise.
 *
 * Usage:
 *   pnpm demos:regen             render, verify, replace
 *   pnpm demos:regen --check     render, verify, report drift, change nothing
 *   pnpm demos:regen --once      skip the second pass (faster; no determinism proof)
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.dirname(path.dirname(new URL(import.meta.url).pathname));
/**
 * Where each family of committed artifacts lives. The READMEs' demos, the
 * landing page's hero loop, and the inputs page's samples are rendered from
 * the same pipeline, so one guard covers them all: an edited script whose
 * artifacts were not re-rendered fails `--check` either way.
 */
const TARGET_DIRS = {
  demo: path.join(repoRoot, "assets", "readme", "demo"),
  hero: path.join(repoRoot, "apps", "studio", "public", "hero"),
  inputs: path.join(repoRoot, "apps", "studio", "public", "inputs"),
} as const;

type Target = keyof typeof TARGET_DIRS;

/**
 * One render invocation. `scale` is omitted where it would not apply: SVG is
 * vector output and ignores it. `target` defaults to the README demos, and
 * `dir` to `examples` — the inputs page also shows fixture transcripts.
 */
type Job = {
  script: string;
  formats: string;
  scale?: number;
  target?: Target;
  dir?: "examples" | "fixtures/scripts";
};

/**
 * Both languages, in the order the READMEs present them. Scales are the ones
 * the committed artifacts were made at — animated WebP at 0.75 keeps the motion
 * legible at README width, everything raster else at 0.5.
 */
const JOBS: Job[] = [
  { script: "readme-english", formats: "transcript-svg" },

  { script: "readme-en-tui-dark", formats: "animated-svg" },
  { script: "readme-en-tui-dark", formats: "animated-webp", scale: 0.75 },
  { script: "readme-en-tui-dark", formats: "poster-webp,mp4,transcript-png", scale: 0.5 },
  { script: "readme-en-app-image", formats: "animated-svg" },
  { script: "readme-en-app-image", formats: "animated-webp", scale: 0.75 },
  { script: "readme-en-app-image", formats: "poster-webp,mp4", scale: 0.5 },
  { script: "readme-en-app-zoom", formats: "animated-svg" },
  { script: "readme-en-slides-light", formats: "poster-webp", scale: 0.5 },

  { script: "readme-tui-dark", formats: "animated-svg" },
  { script: "readme-tui-dark", formats: "animated-webp", scale: 0.75 },
  { script: "readme-tui-dark", formats: "poster-webp,mp4,transcript-png", scale: 0.5 },
  { script: "readme-app-image", formats: "animated-svg" },
  { script: "readme-app-image", formats: "animated-webp", scale: 0.75 },
  { script: "readme-app-image", formats: "poster-webp,mp4", scale: 0.5 },
  { script: "readme-tui-zoom", formats: "animated-svg" },
  { script: "readme-slides-light", formats: "poster-webp", scale: 0.5 },

  { script: "site-hero-app", formats: "animated-svg,poster-webp", target: "hero" },
  { script: "site-hero-tui", formats: "animated-svg,poster-webp", target: "hero" },
  { script: "site-hero-app-zoom", formats: "animated-svg", target: "hero" },
  { script: "site-hero-tui-zoom", formats: "animated-svg", target: "hero" },
  { script: "site-hero-en-app", formats: "animated-svg,poster-webp", target: "hero" },
  { script: "site-hero-en-tui", formats: "animated-svg,poster-webp", target: "hero" },
  { script: "site-hero-en-app-zoom", formats: "animated-svg", target: "hero" },
  { script: "site-hero-en-tui-zoom", formats: "animated-svg", target: "hero" },

  { script: "site-input-camera", formats: "animated-svg,poster-webp", target: "inputs" },
  { script: "site-input-completion", formats: "animated-svg,poster-webp", target: "inputs" },
  { script: "site-input-ime", formats: "animated-svg,poster-webp", target: "inputs" },
  { script: "site-input-slides", formats: "poster-webp", target: "inputs" },
  { script: "site-input-voice", formats: "animated-svg,poster-webp", target: "inputs" },

  {
    script: "choice-freeform-tui",
    formats: "transcript-png",
    target: "inputs",
    dir: "fixtures/scripts",
  },
  { script: "code-diff-tui", formats: "transcript-png", target: "inputs", dir: "fixtures/scripts" },
  { script: "image-attach", formats: "transcript-png", target: "inputs", dir: "fixtures/scripts" },
  {
    script: "image-generation",
    formats: "transcript-png",
    target: "inputs",
    dir: "fixtures/scripts",
  },
  {
    script: "markdown-kitchen-sink-app",
    formats: "transcript-png",
    target: "inputs",
    dir: "fixtures/scripts",
  },
  {
    script: "permission-deny",
    formats: "transcript-png",
    target: "inputs",
    dir: "fixtures/scripts",
  },
  { script: "mixed-scripts", formats: "transcript-png", target: "inputs", dir: "fixtures/scripts" },
  {
    script: "theme-light-transparent",
    formats: "transcript-png",
    target: "inputs",
    dir: "fixtures/scripts",
  },
  {
    script: "tool-multi-command",
    formats: "transcript-png",
    target: "inputs",
    dir: "fixtures/scripts",
  },
];

/**
 * `pnpm render` rebuilds the workspace before every invocation; across two
 * passes of this job list that is dozens of rebuilds of unchanged packages.
 * The engine is copied into `packages/assets/runtime/` by the build, so
 * rendering itself needs no rebuild. Build once, then drive the CLI directly.
 */
async function buildOnce(): Promise<void> {
  process.stdout.write("building packages\n");
  await run("pnpm", ["build:packages"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
}

async function renderInto(outDir: string): Promise<void> {
  for (const target of Object.keys(TARGET_DIRS) as Target[]) {
    await mkdir(path.join(outDir, target), { recursive: true });
  }
  for (const job of JOBS) {
    const args = [
      "packages/cli/dist/bin.js",
      `${job.dir ?? "examples"}/${job.script}.json`,
      "--out",
      path.join(outDir, job.target ?? "demo"),
      "--formats",
      job.formats,
      "--strict",
      // Pinned rather than inherited. The CLI's default motion profile is a
      // product decision about what an author's export should cost them, and
      // it has already moved once; these are the project's own showcase, and
      // they should not re-encode because that default shifted. `high` is the
      // sampling the committed artifacts were made at.
      "--motion-quality",
      "high",
      ...(job.scale === undefined ? [] : ["--scale", String(job.scale)]),
    ];
    process.stdout.write(`  ${job.script} → ${job.formats}\n`);
    await run(process.execPath, args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  }
}

async function filesIn(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => !name.startsWith(".")).sort();
}

/** Every rendered artifact, as `target/name` pairs. */
async function renderedEntries(root: string): Promise<Array<{ target: Target; name: string }>> {
  const entries: Array<{ target: Target; name: string }> = [];
  for (const target of Object.keys(TARGET_DIRS) as Target[]) {
    for (const name of await filesIn(path.join(root, target))) {
      entries.push({ target, name });
    }
  }
  return entries;
}

async function differs(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return !left.equals(right);
}

/** Render a second pass and report artifacts that differ between the two. */
async function assertDeterministic(workRoot: string, first: string): Promise<boolean> {
  const second = path.join(workRoot, "pass2");
  process.stdout.write("pass 2 (determinism)\n");
  await renderInto(second);
  const names = await renderedEntries(first);
  const unstable: string[] = [];
  for (const { target, name } of names) {
    if (await differs(path.join(first, target, name), path.join(second, target, name))) {
      unstable.push(`${target}/${name}`);
    }
  }
  if (unstable.length > 0) {
    process.stdout.write(`\nnot deterministic across two passes:\n`);
    for (const name of unstable) {
      process.stdout.write(`  ${name}\n`);
    }
    return false;
  }
  process.stdout.write(`  ${names.length} artifacts identical across both passes\n`);
  return true;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const once = process.argv.includes("--once");
  const workRoot = await mkdtemp(path.join(tmpdir(), "svgent-demos-"));
  const first = path.join(workRoot, "pass1");

  try {
    await buildOnce();
    process.stdout.write("pass 1\n");
    await renderInto(first);

    if (!once && !(await assertDeterministic(workRoot, first))) {
      process.exitCode = 1;
      return;
    }

    const rendered = await renderedEntries(first);
    const renderedKeys = new Set(rendered.map(({ target, name }) => `${target}/${name}`));
    const committed = new Set<string>();
    for (const target of Object.keys(TARGET_DIRS) as Target[]) {
      for (const name of await filesIn(TARGET_DIRS[target])) {
        committed.add(`${target}/${name}`);
      }
    }
    const changed: Array<{ target: Target; name: string }> = [];
    for (const { target, name } of rendered) {
      const committedPath = path.join(TARGET_DIRS[target], name);
      if (
        !committed.has(`${target}/${name}`) ||
        (await differs(path.join(first, target, name), committedPath))
      ) {
        changed.push({ target, name });
      }
    }
    const orphaned = [...committed].filter((key) => !renderedKeys.has(key));

    process.stdout.write(
      `\n${changed.length} of ${rendered.length} artifacts differ from the tree\n`,
    );
    for (const { target, name } of changed) {
      process.stdout.write(`  ${target}/${name}\n`);
    }
    for (const key of orphaned) {
      process.stdout.write(`  (no longer produced) ${key}\n`);
    }

    if (checkOnly) {
      process.exitCode = changed.length > 0 || orphaned.length > 0 ? 1 : 0;
      return;
    }
    for (const { target, name } of changed) {
      await writeFile(
        path.join(TARGET_DIRS[target], name),
        await readFile(path.join(first, target, name)),
      );
    }
    process.stdout.write(changed.length > 0 ? "\nupdated\n" : "\nnothing to update\n");
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

await main();
