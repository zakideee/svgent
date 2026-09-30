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

/** Packages only the Markdown parser adapter may name, in any import form. */
const PARSER_ADAPTER_ONLY: Record<string, string> = {
  marked: "packages/scene/src/markdown-marked-adapter.ts",
  "character-entities": "packages/scene/src/markdown-marked-adapter.ts",
};

function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/gu,
    /import\(\s*["']([^"']+)["']\s*\)/gu,
    /require\(\s*["']([^"']+)["']\s*\)/gu,
    /import\(\s*["']([^"']+)["']\s*\)\./gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1] ?? "");
    }
  }
  return specifiers;
}

describe("markdown parser boundary", () => {
  it("keeps the parser library inside its adapter", () => {
    for (const workspace of Object.keys(ALLOWED_WORKSPACE_DEPS)) {
      for (const file of sourceFiles(path.join(workspace, "src"))) {
        for (const specifier of importedSpecifiers(readFileSync(file, "utf8"))) {
          const owner = PARSER_ADAPTER_ONLY[specifier.split("/")[0] ?? ""];
          if (owner !== undefined) {
            expect(`${file} -> ${specifier}`).toBe(`${owner} -> ${specifier}`);
          }
        }
      }
    }
  });

  it("recognises every import form it guards against", () => {
    const forms = [
      'import { Marked } from "marked";',
      'import type { Token } from "marked";',
      'export { Lexer } from "marked";',
      'const lazy = await import("marked");',
      'type Lazy = typeof import("marked").Lexer;',
    ];
    for (const form of forms) {
      expect(importedSpecifiers(form), form).toContain("marked");
    }
  });

  it("leaves the parser out of the published scene types", () => {
    const declarations = readFileSync("packages/scene/dist/index.d.ts", "utf8");
    expect(declarations).not.toMatch(/["']marked["']|["']character-entities["']/u);
    expect(declarations).not.toMatch(/\b(?:Tokens|TokenizerExtension|MarkedOptions)\b/u);
  });
});
