import { readFile } from "node:fs/promises";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import { bundledBoundsvgRuntimePath, bundledFontPath } from "@svgent/assets/node";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const FONT_FILES = Object.values(BUNDLED_FONT_FILES);

const THIRD_PARTY_LICENSES_PATH = "third-party-licenses.txt";

/**
 * The site distributes webfonts and the engine's WASM binaries, so their
 * notices ship beside them: both OFL texts and the boundsvg license set,
 * which covers the render and MP4 muxer binaries alike. The footer of every
 * page links the file.
 */
async function thirdPartyLicensesText(): Promise<string> {
  const section = (title: string, body: string): string =>
    `${"=".repeat(72)}\n${title}\n${"=".repeat(72)}\n\n${body.trim()}\n`;
  return [
    "Third-party notices for files distributed by this site.\n",
    section(
      "JetBrains Mono (fonts/JetBrainsMono-Regular.woff2) — SIL OFL 1.1",
      await readFile(bundledFontPath("JetBrainsMono-LICENSE-OFL.txt"), "utf8"),
    ),
    section(
      "Noto Sans JP subset (fonts/NotoSansJP-Regular.subset.woff2) — SIL OFL 1.1",
      await readFile(bundledFontPath("NotoSansJP-LICENSE-OFL.txt"), "utf8"),
    ),
    section(
      "boundsvg WASM binaries — MIT",
      await readFile(bundledBoundsvgRuntimePath("LICENSE-MIT"), "utf8"),
    ),
    section(
      "boundsvg WASM binaries — Apache-2.0",
      await readFile(bundledBoundsvgRuntimePath("LICENSE-APACHE"), "utf8"),
    ),
    section(
      "boundsvg WASM binaries — bundled third-party licenses",
      await readFile(bundledBoundsvgRuntimePath("THIRD-PARTY-LICENSES"), "utf8"),
    ),
  ].join("\n");
}

function bundledFontsServePlugin(): Plugin {
  return {
    name: "svgent-bundled-fonts-serve",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/fonts", async (request, response, next) => {
        const fileName = decodeURIComponent((request.url ?? "").replace(/^\//u, ""));
        if (!FONT_FILES.includes(fileName as (typeof FONT_FILES)[number])) {
          next();
          return;
        }
        response.setHeader("Content-Type", "font/woff2");
        response.end(await readFile(bundledFontPath(fileName)));
      });
      server.middlewares.use(`/${THIRD_PARTY_LICENSES_PATH}`, async (_request, response) => {
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(await thirdPartyLicensesText());
      });
    },
  };
}

function bundledFontsBuildPlugin(): Plugin {
  return {
    name: "svgent-bundled-fonts-build",
    apply: "build",
    async buildStart() {
      for (const fileName of FONT_FILES) {
        this.emitFile({
          type: "asset",
          fileName: `fonts/${fileName}`,
          source: await readFile(bundledFontPath(fileName)),
        });
      }
      this.emitFile({
        type: "asset",
        fileName: THIRD_PARTY_LICENSES_PATH,
        source: await thirdPartyLicensesText(),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), bundledFontsServePlugin(), bundledFontsBuildPlugin()],
  build: {
    rollupOptions: {
      // One page per language: /(en) and /ja/ are separate static URLs with
      // hreflang alternates, not Accept-Language negotiation. Each app then
      // sits one level down, which leaves the root free for the next one.
      input: {
        landing: "index.html",
        landingJa: "ja/index.html",
        studio: "studio/index.html",
        studioJa: "ja/studio/index.html",
        inputs: "inputs/index.html",
        inputsJa: "ja/inputs/index.html",
        view: "view/index.html",
        notFound: "404.html",
        notFoundJa: "ja/404.html",
      },
    },
  },
  // The MP4 exporter samples frames in module workers.
  worker: {
    format: "es",
  },
  server: {
    fs: {
      allow: ["../..", "../../../boundsvg"],
    },
  },
  optimizeDeps: {
    // The engines locate their binaries with `new URL("…_bg.wasm",
    // import.meta.url)`. Pre-bundling rewrites the module into `.vite/deps/`
    // and leaves the binary behind, so the URL resolves to the dev server's
    // HTML fallback and instantiation fails on the magic word. The names here
    // are the packages that ship those binaries — they were the pre-scoped
    // ones until now, which is why `pnpm dev` had stopped drawing anything.
    exclude: ["@boundsvg/browser", "@boundsvg/core", "@boundsvg/worker", "@boundsvg/video"],
  },
});
