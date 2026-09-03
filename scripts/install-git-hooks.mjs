import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

// An exported archive has no .git, and an install without devDependencies has
// no prek package — in both cases there are no hooks to install. The package
// probe covers Windows too, where shell: true would otherwise turn a missing
// binary into a cmd.exe exit code instead of ENOENT.
if (!existsSync(".git")) {
  process.exit(0);
}
const require = createRequire(import.meta.url);
try {
  require.resolve("@j178/prek/package.json");
} catch {
  process.exit(0);
}
const result = spawnSync("prek", ["install", "-t", "pre-commit", "-t", "pre-push"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error !== undefined && result.error.code === "ENOENT") {
  process.exit(0);
}
process.exit(result.status ?? 1);
