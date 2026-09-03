import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Every SPDX expression we accept in the dependency tree. An allowlist rather
 * than a copyleft denylist: an unrecognized expression should stop the build
 * and get a human decision, not slip through because nobody predicted it.
 *
 * `pnpm licenses list` reports whatever string the package declared, so the
 * same license arrives in several spellings ("MIT OR Apache-2.0" vs
 * "Apache-2.0 OR MIT"). Both belong here; normalizing them would hide the
 * difference between a dual license and a genuinely new one.
 */
const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "Apache-2.0 OR MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT OR Apache-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/**
 * Narrow, version-pinned exceptions for dependencies that need obligations
 * different from the repository's permissive-license baseline.
 *
 * Wrangler's development-only Miniflare dependency uses sharp, whose prebuilt
 * libvips platform packages declare LGPL-3.0-or-later. They are tooling inputs:
 * neither the Studio build nor any @svgent/* tarball contains them. Keep this
 * package- and version-scoped so another LGPL dependency, or a Wrangler/sharp
 * upgrade, requires a fresh review.
 */
const REVIEWED_WRANGLER_LIBVIPS_PACKAGES = new Set([
  "@img/sharp-libvips-darwin-arm64",
  "@img/sharp-libvips-darwin-x64",
  "@img/sharp-libvips-linux-arm",
  "@img/sharp-libvips-linux-arm64",
  "@img/sharp-libvips-linux-ppc64",
  "@img/sharp-libvips-linux-riscv64",
  "@img/sharp-libvips-linux-s390x",
  "@img/sharp-libvips-linux-x64",
  "@img/sharp-libvips-linuxmusl-arm64",
  "@img/sharp-libvips-linuxmusl-x64",
]);
const REVIEWED_WRANGLER_LIBVIPS_VERSION = "1.2.4";

type LicenseEntry = {
  name: string;
  versions?: string[];
};

function isReviewedPackageLicense(license: string, entry: LicenseEntry): boolean {
  return (
    license === "LGPL-3.0-or-later" &&
    REVIEWED_WRANGLER_LIBVIPS_PACKAGES.has(entry.name) &&
    entry.versions?.length === 1 &&
    entry.versions[0] === REVIEWED_WRANGLER_LIBVIPS_VERSION
  );
}

async function readLicenses(): Promise<Map<string, LicenseEntry[]>> {
  // --json exits non-zero on an empty tree, which only happens without an
  // install; let that surface as the underlying error.
  const { stdout } = await run("pnpm", ["licenses", "list", "--json"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  return new Map(Object.entries(JSON.parse(stdout) as Record<string, LicenseEntry[]>));
}

const licenses = await readLicenses();
const rejected = [...licenses]
  .map(
    ([license, packages]) =>
      [
        license,
        packages.filter(
          (entry) => !ALLOWED_LICENSES.has(license) && !isReviewedPackageLicense(license, entry),
        ),
      ] as const,
  )
  .filter(([, packages]) => packages.length > 0);
const total = [...licenses.values()].reduce((sum, packages) => sum + packages.length, 0);

if (rejected.length > 0) {
  for (const [license, packages] of rejected) {
    const names = packages.map((entry) => entry.name).sort();
    console.error(
      `[svgent] unreviewed license "${license}" (${names.length}): ${names.join(", ")}`,
    );
  }
  console.error(
    "[svgent] review each package, then add the expression to ALLOWED_LICENSES in scripts/check-licenses.mts",
  );
  process.exitCode = 1;
} else {
  console.info(`[svgent] ${total} packages across ${licenses.size} reviewed licenses`);
}
