/**
 * Rendering a script is an offline operation unless the operator says
 * otherwise.
 *
 * A script is data that arrives from somewhere — an assistant, a pipe, a
 * repository — and one of its fields can name a Google font. Honouring that
 * field means a network request whose query string spells out every
 * character the script draws. The decision belongs to whoever runs the CLI,
 * so it is a flag, and the substitution that happens without the flag is
 * reported rather than made quietly.
 */

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const binPath = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

const SCRIPT = JSON.stringify({
  version: 1,
  title: "font probe",
  surface: "tui",
  fonts: {
    sans: { source: "google", family: "Zen Maru Gothic" },
    mono: { source: "bundled" },
  },
  messages: [{ role: "user", content: "hello" }],
});

describe("a script that names a Google font", () => {
  it("renders from the bundled font and says that it did", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "svgent-font-"));
    const scriptPath = path.join(dir, "probe.json");
    await writeFile(scriptPath, SCRIPT);

    // No network is stubbed here on purpose: if the default ever starts
    // fetching again, this runs a real request and the assertion below is
    // what catches it.
    const { stderr } = await run(process.execPath, [
      binPath,
      scriptPath,
      "--out",
      path.join(dir, "out"),
      "--formats",
      "poster-svg",
    ]);

    expect(stderr).toContain("Zen Maru Gothic");
    expect(stderr).toContain("fonts.googleapis.com");
    expect(stderr).toContain("--allow-font-fetch");
  }, 120_000);
});
