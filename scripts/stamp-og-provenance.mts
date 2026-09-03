/**
 * Stamps provenance onto the captured share cards. The card composites are
 * browser screenshots of `apps/studio/og-src/card-*.html`, so unlike every
 * rendered artifact they leave the browser without metadata; this puts the
 * same `simulated=true` / `model-kind` comment onto the final PNGs.
 */
import { readFile, writeFile } from "node:fs/promises";
import { stampPngProvenance } from "@svgent/render";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: tsx scripts/stamp-og-provenance.mts <png> [...png]");
  process.exit(1);
}
for (const target of targets) {
  const stamped = stampPngProvenance(new Uint8Array(await readFile(target)), {
    modelKind: "fictional",
  });
  await writeFile(target, stamped);
  console.info(`[svgent] stamped ${target}`);
}
