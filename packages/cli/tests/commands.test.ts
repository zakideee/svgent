/** Cross-process command behavior and authored-file ownership. */
import { execFile, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { type CliOptions, renderScriptFile } from "../src/rendering.mjs";

const run = promisify(execFile);
const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const SCRIPT = {
  version: 1,
  basis: "fictional",
  title: "Parser test",
  messages: [
    { role: "user", content: "Add a parser test." },
    { role: "assistant", content: "The parser test passes." },
  ],
};
type Outcome = {
  ok: boolean;
  cliVersion: string;
  source: { sha256: string };
  normalized: {
    messages: { id: string; content: string; timing?: { durationMs?: number } }[];
    timing: unknown;
  };
  pages: {
    durationMs: number;
    messages: { id: string; revealEndMs: number; settledMs: number }[];
  }[];
  warnings: string[];
  error: { code: string };
  output: { path: string };
  changes: { path: string }[];
  artifacts: { path: string; timeMs: number; widthPx: number; heightPx: number }[];
};

async function command(args: string[], options: { fail?: boolean } = {}): Promise<Outcome> {
  try {
    const { stdout } = await run(process.execPath, [binPath, ...args, "--json"], {
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(options.fail).not.toBe(true);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "") as Outcome;
  } catch (cause) {
    if (!options.fail) {
      throw cause;
    }
    const failure = cause as Error & { stdout: string; code: number };
    expect(failure.code).not.toBe(0);
    const outcome = JSON.parse(failure.stdout) as Outcome;
    expect(outcome.ok).toBe(false);
    return outcome;
  }
}
async function input(script: unknown = SCRIPT): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "svgent-command-"));
  const scriptPath = path.join(directory, "script.json");
  await writeFile(scriptPath, JSON.stringify(script));
  return scriptPath;
}

describe("CLI authoring across separate processes", () => {
  it.skipIf(process.platform === "win32")("refuses to replace a read-only artifact", async () => {
    const scriptPath = await input();
    const args = [
      "render",
      scriptPath,
      "--out",
      path.dirname(scriptPath),
      "--formats",
      "poster-svg",
      "--strict",
    ];
    const first = await command(args);
    const artifactPath = first.artifacts[0]!.path;
    const before = await readFile(artifactPath);
    await chmod(artifactPath, 0o444);
    await writeFile(scriptPath, JSON.stringify({ ...SCRIPT, title: "Changed input" }));
    const rejected = spawnSync(process.execPath, [binPath, ...args, "--json"], {
      encoding: "utf8",
    });
    expect(rejected.status).not.toBe(0);
    expect((JSON.parse(rejected.stdout) as Outcome).error.code).toBe("INVALID_OUTPUT");
    expect(await readFile(artifactPath)).toEqual(before);
    expect((await stat(artifactPath)).mode & 0o777).toBe(0o444);
  });

  it.skipIf(process.platform === "win32")(
    "preserves permissions when replacing an artifact",
    async () => {
      const scriptPath = await input();
      const args = [
        "render",
        scriptPath,
        "--out",
        path.dirname(scriptPath),
        "--formats",
        "poster-svg",
        "--strict",
      ];
      const first = await command(args);
      const artifactPath = first.artifacts[0]!.path;
      await chmod(artifactPath, 0o600);
      await command(args);
      expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
    },
  );

  it("protects an explicitly supplied font whose path is a render destination", async () => {
    const scriptPath = await input({
      ...SCRIPT,
      appearance: { canvasWidth: 640, canvasHeight: 480 },
    });
    const fontPath = path.join(path.dirname(scriptPath), "script-01.png");
    await copyFile(
      fileURLToPath(new URL("../fonts/JetBrainsMono-Regular.woff2", import.meta.url)),
      fontPath,
    );
    const before = await readFile(fontPath);
    expect(
      (
        await command(
          [
            "render",
            scriptPath,
            "--out",
            path.dirname(scriptPath),
            "--formats",
            "poster-png",
            "--sans-font",
            fontPath,
            "--strict",
          ],
          { fail: true },
        )
      ).error.code,
    ).toBe("INVALID_OUTPUT");
    expect(await readFile(fontPath)).toEqual(before);
  });

  it("refuses to reuse a physical artifact written for another input in the batch", async () => {
    const first = await input({ ...SCRIPT, appearance: { canvasWidth: 640, canvasHeight: 480 } });
    const second = await input({
      ...SCRIPT,
      title: "Second input",
      appearance: { canvasWidth: 640, canvasHeight: 480 },
    });
    const options: CliOptions = {
      outDir: path.join(path.dirname(first), "output"),
      formats: ["poster-svg"],
      idNamespace: undefined,
      pages: "all",
      lang: "en",
      fontOverrides: {},
      strict: true,
      allowFontFetch: false,
      scale: 1,
      motionQuality: "economy",
      animatedSvgIterations: "infinite",
      warnings: [],
    };
    const writtenArtifacts = new Set<string>();
    const rendered = await renderScriptFile(first, options, {
      inputPaths: [first, second],
      writtenArtifacts,
    });
    const artifactPath = rendered.artifacts[0]!.path;
    const before = await readFile(artifactPath);
    await expect(
      renderScriptFile(second, options, { inputPaths: [first, second], writtenArtifacts }),
    ).rejects.toMatchObject({ code: "OUTPUT_COLLISION" });
    expect(await readFile(artifactPath)).toEqual(before);
  });

  it("accepts explicit message defaults without accepting unknown fields", async () => {
    const scriptPath = await input({
      ...SCRIPT,
      messages: [
        { role: "user", content: "Continue.", timing: {}, images: [], pageBreakBefore: false },
        { role: "thinking", content: "Checking", highlight: false },
        { role: "permission", content: "Edit the parser", decision: "allow" },
        { role: "assistant", content: "Done." },
      ],
    });
    const validation = await command(["validate", scriptPath, "--strict"]);
    expect(validation.warnings).toEqual([]);
    const operations = path.join(path.dirname(scriptPath), "patch.json");
    await writeFile(
      operations,
      JSON.stringify([
        {
          op: "set-message-timing",
          messageId: validation.normalized.messages[3]?.id,
          changes: { durationMs: 2000 },
        },
      ]),
    );
    const edited = await command(["patch", scriptPath, "--operations", operations]);
    expect((await command(["validate", edited.output.path, "--strict"])).warnings).toEqual([]);
    await writeFile(scriptPath, JSON.stringify({ ...SCRIPT, unknown: [] }));
    expect((await command(["validate", scriptPath, "--strict"], { fail: true })).error.code).toBe(
      "WARNINGS",
    );
  });

  it("rejects colliding render names before writing artifacts", async () => {
    const first = await input();
    const second = await input({ ...SCRIPT, title: "Another input" });
    const output = path.join(path.dirname(first), "outputs");
    expect(
      (
        await command(["render", first, second, "--out", output, "--formats", "poster-svg"], {
          fail: true,
        })
      ).error.code,
    ).toBe("OUTPUT_COLLISION");
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("protects another input whose path is a render destination", async () => {
    const scriptPath = await input();
    const second = path.join(path.dirname(scriptPath), "script-01.svg");
    await writeFile(second, JSON.stringify(SCRIPT));
    const before = await readFile(second);
    expect(
      (
        await command(
          [
            "render",
            scriptPath,
            second,
            "--out",
            path.dirname(scriptPath),
            "--formats",
            "poster-svg",
          ],
          { fail: true },
        )
      ).error.code,
    ).toBe("INVALID_OUTPUT");
    expect(await readFile(second)).toEqual(before);
  });

  it("reports render warnings and invalid page numbers consistently", async () => {
    const scriptPath = await input({
      ...SCRIPT,
      appearance: { canvasWidth: 2560, canvasHeight: 2560 },
    });
    const rendered = await command(
      ["render", scriptPath, "--scale", "4", "--formats", "poster-png", "--strict"],
      { fail: true },
    );
    expect(rendered.error.code).toBe("WARNINGS");
    expect(rendered.warnings[0]).toContain("3840px");
    expect((await command(["render", scriptPath, "--pages", "2"], { fail: true })).error.code).toBe(
      "INVALID_ARGUMENT",
    );
    expect(
      (await command(["fit", scriptPath, "--page", "2", "--target-ms", "5000"], { fail: true }))
        .error.code,
    ).toBe("INVALID_ARGUMENT");
    const imePath = await input({
      ...SCRIPT,
      messages: [{ role: "user", content: `[[語|${"あ".repeat(30)}]]` }],
    });
    expect((await command(["validate", imePath, "--lang", "ja"])).warnings[0]).toContain("IME読み");
  });

  it.skipIf(process.platform === "win32")(
    "protects inputs from linked render destinations",
    async () => {
      for (const kind of ["symbolic", "hard"] as const) {
        const scriptPath = await input();
        const before = await readFile(scriptPath);
        const output = path.join(path.dirname(scriptPath), "output");
        await mkdir(output);
        const destination = path.join(output, "script-01.svg");
        await (kind === "symbolic"
          ? symlink(scriptPath, destination)
          : link(scriptPath, destination));
        expect(
          (
            await command(["render", scriptPath, "--out", output, "--formats", "poster-svg"], {
              fail: true,
            })
          ).error.code,
        ).toBe("INVALID_OUTPUT");
        expect(await readFile(scriptPath)).toEqual(before);
      }
    },
  );

  it("reads stable IDs and page-local reveal times without modifying the source", async () => {
    const scriptPath = await input();
    const before = await readFile(scriptPath);
    const first = await command(["inspect", scriptPath, "--strict"]);
    const second = await command(["inspect", scriptPath]);
    expect(first.ok).toBe(true);
    expect(first.cliVersion).toBe("0.1.0");
    expect(first.source.sha256).toMatch(/^[a-f\d]{64}$/u);
    expect(second.pages).toEqual(first.pages);
    expect(first.pages[0]?.messages[0]?.id).toMatch(/^imported-/u);
    expect(first.pages[0]?.messages[0]?.settledMs).toBeGreaterThanOrEqual(
      first.pages[0]?.messages[0]?.revealEndMs ?? 0,
    );
    await command(["validate", scriptPath]);
    expect(await readFile(scriptPath)).toEqual(before);
  });

  it("patches a stable ID while preserving unrelated text and project pacing", async () => {
    const scriptPath = await input();
    const before = await command(["validate", scriptPath]);
    const inspection = await command(["inspect", scriptPath]);
    const id = inspection.pages[0]?.messages[1]?.id;
    const operations = path.join(path.dirname(scriptPath), "patch.json");
    await writeFile(
      operations,
      JSON.stringify([{ op: "set-message-timing", messageId: id, changes: { durationMs: 1800 } }]),
    );
    const patched = await command([
      "patch",
      scriptPath,
      "--operations",
      operations,
      "--expect-source",
      inspection.source.sha256,
    ]);
    const after = await command(["validate", patched.output.path, "--strict"]);
    expect(after.normalized.timing).toEqual(before.normalized.timing);
    expect(after.normalized.messages[0]).toEqual(before.normalized.messages[0]);
    expect(after.normalized.messages[1]).toEqual({
      ...before.normalized.messages[1],
      timing: { durationMs: 1800 },
    });
    expect(patched.changes).toHaveLength(1);
    expect((await command(["inspect", scriptPath])).source.sha256).toBe(inspection.source.sha256);
    expect(
      (await command(["patch", scriptPath, "--operations", operations], { fail: true })).error.code,
    ).toBe("OUTPUT_EXISTS");
  });

  it("rejects stale identity and requires the expected hash for an in-place edit", async () => {
    const scriptPath = await input();
    const inspected = await command(["inspect", scriptPath]);
    const operations = path.join(path.dirname(scriptPath), "patch.json");
    await writeFile(
      operations,
      JSON.stringify([
        {
          op: "set-message-content",
          messageId: inspected.pages[0]?.messages[1]?.id,
          content: "Done.",
        },
      ]),
    );
    expect(
      (
        await command(["patch", scriptPath, "--operations", operations, "--in-place"], {
          fail: true,
        })
      ).error.code,
    ).toBe("EXPECTED_HASH_REQUIRED");
    await writeFile(scriptPath, `${JSON.stringify(SCRIPT)}\n`);
    const changed = await readFile(scriptPath);
    expect(
      (
        await command(
          [
            "patch",
            scriptPath,
            "--operations",
            operations,
            "--in-place",
            "--expect-source",
            inspected.source.sha256,
          ],
          { fail: true },
        )
      ).error.code,
    ).toBe("STALE_SOURCE");
    expect(await readFile(scriptPath)).toEqual(changed);
    const fresh = await command(["inspect", scriptPath]);
    await command([
      "patch",
      scriptPath,
      "--operations",
      operations,
      "--in-place",
      "--expect-source",
      fresh.source.sha256,
    ]);
    const updated = await command(["validate", scriptPath]);
    expect(updated.normalized.messages[1]?.content).toBe("Done.");
    expect(updated.normalized.messages[1]?.id).toBe(inspected.pages[0]?.messages[1]?.id);
  });

  it("fails ambiguous IDs, unknown IDs, invalid JSON, and strict normalization", async () => {
    const duplicate = await input({
      ...SCRIPT,
      messages: SCRIPT.messages.map((message) => ({ ...message, id: "same" })),
    });
    expect((await command(["inspect", duplicate], { fail: true })).error.code).toBe("DUPLICATE_ID");
    const scriptPath = await input();
    const operations = path.join(path.dirname(scriptPath), "patch.json");
    await writeFile(
      operations,
      JSON.stringify([{ op: "set-message-content", messageId: "missing", content: "Done." }]),
    );
    expect(
      (await command(["patch", scriptPath, "--operations", operations], { fail: true })).error.code,
    ).toBe("INVALID_INPUT");
    await writeFile(scriptPath, "{");
    expect((await command(["validate", scriptPath], { fail: true })).error.code).toBe(
      "INVALID_INPUT",
    );
    await writeFile(scriptPath, JSON.stringify({ ...SCRIPT, appearance: { canvasWidth: 99 } }));
    expect((await command(["validate", scriptPath])).warnings.length).toBeGreaterThan(0);
    expect((await command(["validate", scriptPath, "--strict"], { fail: true })).error.code).toBe(
      "WARNINGS",
    );
    expect(
      (await command(["patch", scriptPath, "--operations", operations], { fail: true })).error.code,
    ).toBe("WARNINGS");
  });

  it("does not silently discard supplied fields or truncate long content in an edit", async () => {
    const scriptPath = await input({
      ...SCRIPT,
      extra: "preserve me",
      messages: [{ role: "assistant", content: "x".repeat(2401) }],
    });
    const validation = await command(["validate", scriptPath]);
    expect(validation.warnings.some((warning) => warning.includes("extra"))).toBe(true);
    expect(validation.warnings.some((warning) => warning.includes("content"))).toBe(true);
    const settings = path.join(path.dirname(scriptPath), "direction.json");
    await writeFile(settings, JSON.stringify({ scene: { surface: "tui" } }));
    const before = await readFile(scriptPath);
    expect(
      (await command(["direct", scriptPath, "--settings", settings], { fail: true })).error.code,
    ).toBe("WARNINGS");
    expect(await readFile(scriptPath)).toEqual(before);
  });

  it("fits local timing and directs the scene without editing the messages", async () => {
    const scriptPath = await input();
    const before = await command(["validate", scriptPath]);
    const settings = path.join(path.dirname(scriptPath), "direction.json");
    await writeFile(
      settings,
      JSON.stringify({
        scene: { surface: "tui" },
        camera: { follow: true, zoom: 1.6 },
        display: { footer: false },
        appearance: { canvasWidth: 960 },
      }),
    );
    const directed = await command(["direct", scriptPath, "--settings", settings]);
    expect(
      (await command(["validate", directed.output.path, "--strict"])).normalized.messages,
    ).toEqual(before.normalized.messages);
    const fitted = await command([
      "fit",
      scriptPath,
      "--target-ms",
      "10000",
      "--output",
      path.join(path.dirname(scriptPath), "fitted.json"),
    ]);
    const after = await command(["validate", fitted.output.path, "--strict"]);
    expect(after.normalized.timing).toEqual(before.normalized.timing);
    expect(after.normalized.messages.map(({ content, id }) => ({ content, id }))).toEqual(
      before.normalized.messages.map(({ content, id }) => ({ content, id })),
    );
    expect(
      Math.abs((await command(["inspect", fitted.output.path])).pages[0]!.durationMs - 10000),
    ).toBeLessThanOrEqual(80);
  });

  it("captures an explicit moment and fails when ffmpeg is unavailable", async () => {
    const scriptPath = await input({
      ...SCRIPT,
      appearance: { canvasWidth: 640, canvasHeight: 480 },
      messages: [{ role: "assistant", content: "Done.", timing: { durationMs: 800 } }],
    });
    const outputPath = path.join(path.dirname(scriptPath), "frame.png");
    const snapshot = await command([
      "snapshot",
      scriptPath,
      "--time",
      "400",
      "--output",
      outputPath,
      "--strict",
    ]);
    expect(snapshot.artifacts[0]?.timeMs).toBe(400);
    const initialPath = path.join(path.dirname(scriptPath), "initial.png");
    await command(["snapshot", scriptPath, "--time", "0", "--output", initialPath, "--strict"]);
    const bytes = await readFile(outputPath);
    expect(await readFile(initialPath)).not.toEqual(bytes);
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(snapshot.artifacts[0]?.widthPx);
    expect(bytes.readUInt32BE(20)).toBe(snapshot.artifacts[0]?.heightPx);
    expect(bytes.includes(Buffer.from('"simulated":true'))).toBe(true);
    const { stdout } = await run(
      process.execPath,
      [binPath, "render", scriptPath, "--formats", "mp4", "--json"],
      { env: { ...process.env, FFMPEG_PATH: path.join(path.dirname(scriptPath), "no-ffmpeg") } },
    ).catch((cause: Error & { stdout: string }) => ({ stdout: cause.stdout }));
    expect((JSON.parse(stdout) as Outcome).error.code).toBe("FFMPEG_UNAVAILABLE");
  }, 120000);

  it.skipIf(process.platform === "win32")(
    "preserves a symlink target rather than replacing its in-place path",
    async () => {
      const scriptPath = await input();
      const linked = path.join(path.dirname(scriptPath), "linked.json");
      await symlink(scriptPath, linked);
      const inspected = await command(["inspect", linked]);
      const operations = path.join(path.dirname(scriptPath), "patch.json");
      await writeFile(
        operations,
        JSON.stringify([
          {
            op: "set-message-content",
            messageId: inspected.pages[0]?.messages[0]?.id,
            content: "Changed.",
          },
        ]),
      );
      expect(
        (
          await command(
            [
              "patch",
              linked,
              "--operations",
              operations,
              "--in-place",
              "--expect-source",
              inspected.source.sha256,
            ],
            { fail: true },
          )
        ).error.code,
      ).toBe("INVALID_ARGUMENT");
      expect(await readFile(scriptPath, "utf8")).toBe(JSON.stringify(SCRIPT));
    },
  );
});
