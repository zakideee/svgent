/** Exercise one packed CLI through the package managers' installed entrypoints. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { webpFrames } from "./webp-frames.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: { tarball: { type: "string" }, output: { type: "string" } },
});
const temporaryRoot = values.output
  ? path.resolve(values.output)
  : await mkdtemp(path.join(tmpdir(), "svgent-cli-consumer-"));
await mkdir(temporaryRoot, { recursive: true });
const consumerRoot = path.join(temporaryRoot, "consumer");
await mkdir(consumerRoot);
const npmConfig = path.join(temporaryRoot, "npmrc");
await writeFile(npmConfig, "registry=https://registry.npmjs.org/\n");
const environment = {
  ...process.env,
  NPM_CONFIG_USERCONFIG: npmConfig,
  NPM_CONFIG_CACHE: path.join(temporaryRoot, "npm-cache"),
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
};

type Outcome = {
  ok: boolean;
  cliVersion: string;
  error?: { code: string };
  artifacts: {
    path: string;
    format: string;
    widthPx: number;
    heightPx: number;
    durationMs: number;
  }[];
};
function run(command: string, args: string[], cwd = consumerRoot): string {
  const windowsShell =
    process.platform === "win32" &&
    (["npm", "npx", "pnpm"].includes(command) || command.endsWith(".cmd"));
  const argumentsForCommand = windowsShell
    ? args.map((entry) => `"${entry.replaceAll('"', '\\"')}"`)
    : args;
  const execution = spawnSync(command, argumentsForCommand, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: windowsShell,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (execution.status !== 0) {
    const detail = execution.stderr || execution.stdout || execution.error?.message;
    throw new Error(`${command} failed (${execution.status}): ${detail ?? "No process output"}`);
  }
  return execution.stdout;
}
function cli(command: string, prefix: string[], args: string[]): Outcome {
  const text = run(command, [...prefix, ...args, "--json"]);
  const lines = text.trim().split("\n");
  if (lines.length !== 1) {
    throw new Error("CLI did not return one stdout result");
  }
  const outcome = JSON.parse(text) as Outcome;
  if (!outcome.ok || outcome.cliVersion !== "0.1.0") {
    throw new Error("CLI command failed or has the wrong version");
  }
  return outcome;
}
function authored(surface: string, lang: string) {
  return {
    version: 1,
    basis: "fictional",
    title: lang === "ja" ? "テスト追加" : "Parser test",
    surface,
    modelLabel: "Example model",
    workspaceLabel: "example/parser",
    branchLabel: "feat/parser",
    appearance: { canvasWidth: 640, canvasHeight: 480, fontScale: 1.2 },
    timing: { finalHoldMs: 500 },
    messages: [
      {
        role: "user",
        content: lang === "ja" ? "テストを追加して。" : "Add a test.",
        timing: { durationMs: 1200, pauseBeforeMs: 0, transitionMs: 100 },
      },
      {
        role: "assistant",
        content: lang === "ja" ? "テストが通りました。" : "The test passes.",
        timing: { durationMs: 900, pauseBeforeMs: 0, transitionMs: 100 },
      },
    ],
  };
}

try {
  let tarball = values.tarball ? path.resolve(values.tarball) : undefined;
  if (!tarball) {
    const packRoot = path.join(temporaryRoot, "tarballs");
    await mkdir(packRoot);
    run(
      "pnpm",
      ["--filter", "@svgent/cli", "--fail-if-no-match", "pack", "--pack-destination", packRoot],
      repositoryRoot,
    );
    tarball = path.join(packRoot, "svgent-cli-0.1.0.tgz");
  }
  const sha256 = createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex");
  await writeFile(
    path.join(consumerRoot, "package.json"),
    JSON.stringify({ name: "svgent-cli-consumer", private: true, type: "module" }),
  );
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const installedRoot = path.join(consumerRoot, "node_modules/@svgent/cli");
  const manifest = JSON.parse(await readFile(path.join(installedRoot, "package.json"), "utf8")) as {
    exports?: unknown;
    devDependencies?: unknown;
    scripts?: unknown;
    dependencies: Record<string, string>;
    bin: { svgent: string };
  };
  if (
    manifest.exports !== undefined ||
    manifest.devDependencies !== undefined ||
    manifest.scripts !== undefined ||
    Object.keys(manifest.dependencies).some((name) => name.startsWith("@svgent/")) ||
    manifest.dependencies["@boundsvg/core"] !== "0.7.0"
  ) {
    throw new Error("CLI retained a workspace runtime dependency or JS API");
  }
  for (const required of [
    "fonts/JetBrainsMono-Regular.woff2",
    "fonts/NotoSansJP-Regular.subset.woff2",
    "fonts/JetBrainsMono-LICENSE-OFL.txt",
    "fonts/NotoSansJP-LICENSE-OFL.txt",
    "runtime/boundsvg/boundsvg.js",
    "runtime/boundsvg/boundsvg_bg.wasm",
    "runtime/boundsvg/LICENSE-MIT",
    "runtime/boundsvg/LICENSE-APACHE",
    "runtime/boundsvg/THIRD-PARTY-LICENSES",
    "licenses/marked-LICENSE",
    "licenses/character-entities-license",
    "licenses/prismjs-LICENSE",
    "licenses/unicode-segmenter-LICENSE",
  ]) {
    await access(path.join(installedRoot, required));
  }
  const bin = path.join(
    consumerRoot,
    `node_modules/.bin/svgent${process.platform === "win32" ? ".cmd" : ""}`,
  );
  await access(bin);
  if (
    process.platform !== "win32" &&
    (await realpath(bin)) !== path.resolve(installedRoot, manifest.bin.svgent)
  ) {
    throw new Error("npm did not create the actual bin symlink");
  }
  const npmPrefixes = [
    ["npm", ["exec", "--", "svgent"]],
    ["npx", ["--no-install", "svgent"]],
    ["pnpm", ["exec", "svgent"]],
  ] as const;
  const artifacts: Outcome["artifacts"] = [];
  for (const surface of ["app", "tui"]) {
    for (const lang of ["en", "ja"]) {
      const file = `${surface}-${lang}.json`;
      await writeFile(path.join(consumerRoot, file), JSON.stringify(authored(surface, lang)));
      const outcome = cli(
        bin,
        [],
        [
          "render",
          file,
          "--out",
          `${surface}-${lang}`,
          "--formats",
          "poster-svg,poster-png,animated-svg,gif,poster-webp,animated-webp,transcript-svg,transcript-png",
          "--scale",
          "0.5",
          "--motion-quality",
          "economy",
          "--lang",
          lang,
          "--strict",
        ],
      );
      artifacts.push(...outcome.artifacts);
      for (const artifact of outcome.artifacts) {
        const bytes = await readFile(artifact.path);
        if (
          !bytes.includes(Buffer.from("simulated")) ||
          !bytes.includes(Buffer.from("fictional"))
        ) {
          throw new Error(`${artifact.format} lost provenance`);
        }
        if (
          artifact.format.endsWith("png") &&
          (bytes.readUInt32BE(16) !== artifact.widthPx ||
            bytes.readUInt32BE(20) !== artifact.heightPx)
        ) {
          throw new Error("PNG dimensions differ from the reported dimensions");
        }
        if (artifact.format.endsWith("svg") && !bytes.includes(Buffer.from("<svg"))) {
          throw new Error("Missing SVG root");
        }
      }
    }
  }
  for (const [index, [command, prefix]] of npmPrefixes.entries()) {
    artifacts.push(
      ...cli(
        command,
        [...prefix],
        [
          "render",
          "app-en.json",
          "--out",
          `launcher-${index}`,
          "--formats",
          "poster-png,animated-svg",
          "--scale",
          "0.5",
          "--strict",
        ],
      ).artifacts,
    );
  }
  const execRoot = path.join(temporaryRoot, "npm-exec");
  await mkdir(execRoot);
  await copyFile(path.join(consumerRoot, "app-en.json"), path.join(execRoot, "script.json"));
  const execOutcome = JSON.parse(
    run(
      "npm",
      [
        "exec",
        "--yes",
        "--package",
        tarball,
        "--",
        "svgent",
        "render",
        "script.json",
        "--formats",
        "poster-png,animated-svg",
        "--scale",
        "0.5",
        "--strict",
        "--json",
      ],
      execRoot,
    ),
  ) as Outcome;
  if (!execOutcome.ok) {
    throw new Error("Tarball npm exec failed");
  }
  artifacts.push(...execOutcome.artifacts);
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const decoderAvailable = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
  if (decoderAvailable) {
    const video = cli(
      "npm",
      ["exec", "--", "svgent"],
      [
        "render",
        "tui-ja.json",
        "--out",
        "mp4",
        "--formats",
        "mp4",
        "--scale",
        "0.5",
        "--motion-quality",
        "economy",
        "--strict",
      ],
    );
    artifacts.push(...video.artifacts);
    for (const artifact of artifacts.filter((entry) => !entry.format.endsWith("svg"))) {
      if (artifact.format === "animated-webp") {
        const frames = webpFrames(await readFile(artifact.path));
        const durationMs = frames.reduce((sum, frame) => sum + frame.durationMs, 0);
        if (Math.abs(durationMs - artifact.durationMs) > 125) {
          throw new Error("WebP duration differs from its reported timeline");
        }
        for (const [index, frame] of frames.entries()) {
          const framePath = `${artifact.path}.frame-${index}.webp`;
          await writeFile(framePath, frame.bytes);
          run(ffmpeg, ["-v", "error", "-i", framePath, "-frames:v", "1", "-f", "null", "-"]);
        }
      } else {
        run(ffmpeg, ["-v", "error", "-i", artifact.path, "-frames:v", "1", "-f", "null", "-"]);
      }
    }
    const videoArtifact = video.artifacts[0];
    if (!videoArtifact) {
      throw new Error("MP4 artifact missing");
    }
    run(ffmpeg, [
      "-v",
      "error",
      "-i",
      videoArtifact.path,
      "-frames:v",
      "1",
      path.join(consumerRoot, "mp4-frame.png"),
    ]);
  }
  const failure = spawnSync(
    "npm",
    ["exec", "--", "svgent", "render", "app-en.json", "--formats", "mp4", "--json"],
    {
      cwd: consumerRoot,
      env: { ...environment, FFMPEG_PATH: path.join(consumerRoot, "missing-ffmpeg") },
      encoding: "utf8",
    },
  );
  if (
    process.platform !== "win32" &&
    (failure.status === 0 ||
      (JSON.parse(failure.stdout) as Outcome).error?.code !== "FFMPEG_UNAVAILABLE")
  ) {
    throw new Error("Missing ffmpeg did not fail explicitly");
  }
  const proof = {
    platform: process.platform,
    node: process.version,
    tarball,
    sha256,
    launchers: [
      process.platform === "win32" ? "npm Windows shim" : "npm bin symlink",
      "npm exec",
      "npx installed bin",
      "pnpm exec",
      "npm exec tarball outside consumer",
    ],
    decoderAvailable,
    artifacts,
    installedFiles: await readdir(installedRoot),
  };
  await writeFile(path.join(temporaryRoot, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  process.stdout.write(
    `Standalone CLI consumer passed (${process.platform}; decoder ${decoderAvailable ? "available" : "unavailable"}).\n`,
  );
} finally {
  if (!values.output) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
