import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const ALLOWED_WORKSPACE_DEPS: Record<string, readonly string[]> = {
  "packages/assets": [],
  "packages/scene": [],
  "packages/render": ["@svgent/scene"],
  "packages/authoring": ["@svgent/scene"],
  "packages/studio": ["@svgent/assets", "@svgent/render", "@svgent/scene"],
  "packages/cli": ["@svgent/assets", "@svgent/render", "@svgent/scene"],
  "apps/studio": ["@svgent/studio"],
  "apps/webmcp": ["@svgent/authoring", "@svgent/scene", "@svgent/studio"],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.(mts|ts|tsx)$/u.test(entry.name) ? [full] : [];
  });
}

describe("workspace import boundaries", () => {
  for (const [workspace, allowed] of Object.entries(ALLOWED_WORKSPACE_DEPS)) {
    it(`${workspace} declares only its allowed @svgent dependencies`, () => {
      const manifest = JSON.parse(
        readFileSync(path.join(workspace, "package.json"), "utf8"),
      ) as PackageManifest;
      const declared = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      };
      const svgentDependencies = Object.keys(declared)
        .filter((name) => name.startsWith("@svgent/"))
        .sort();
      expect(svgentDependencies).toEqual([...allowed].sort());
    });

    it(`${workspace} does not bypass package exports`, () => {
      for (const file of sourceFiles(path.join(workspace, "src"))) {
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(/(?:from\s+|import\()["']([^"']+)["']/gu)) {
          const specifier = match[1] ?? "";
          expect(`${file} -> ${specifier}`).not.toMatch(/^@svgent\/[^/]+\/src(?:\/|$)/u);
          if (specifier.startsWith(".")) {
            const resolved = path.resolve(path.dirname(file), specifier);
            expect(`${file} -> ${resolved}`).toContain(path.resolve(workspace));
          }
        }
      }
    });
  }
});
