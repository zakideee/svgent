import { readFile } from "node:fs/promises";
import { GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import { createMessage, deserializeProject } from "@svgent/scene";
import { describe, expect, it } from "vitest";

const ASSET_FILES = {
  generic: "packages/studio/assets/presets/generic-generated-result.webp",
  watercolorTraveler: "packages/studio/assets/presets/watercolor-traveler-dusk.webp",
  vectorConf: "packages/studio/assets/presets/vectorconf-dawn-curves.webp",
  boundsvgPipeline: "packages/studio/assets/presets/boundsvg-render-pipeline.webp",
} as const;

function decodeDataUrl(dataUrl: string): Uint8Array {
  const encoded = dataUrl.split(",", 2)[1];
  if (!encoded) {
    throw new Error("Generated sample image is missing its base64 payload");
  }
  return new Uint8Array(Buffer.from(encoded, "base64"));
}

describe("generated sample images", () => {
  it.each(
    Object.entries(ASSET_FILES),
  )("keeps the embedded %s payload synchronized and lightweight", async (key, filePath) => {
    const image = GENERATED_SAMPLE_IMAGES[key as keyof typeof GENERATED_SAMPLE_IMAGES];
    const assetBytes = new Uint8Array(await readFile(filePath));

    expect(image.mediaType).toBe("image/webp");
    expect(image.width).toBe(768);
    expect(image.height).toBe(512);
    expect(decodeDataUrl(image.dataUrl)).toEqual(assetBytes);
    expect(assetBytes.length).toBeLessThan(16 * 1024);
    expect(new TextDecoder().decode(assetBytes.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(assetBytes.slice(8, 12))).toBe("WEBP");
  });

  it("keeps scene message creation independent from product sample assets", () => {
    expect(createMessage("image", 0).images).toBeUndefined();
  });

  it("round-trips WebP attachments through script import", () => {
    const source = JSON.stringify({
      version: 1,
      messages: [
        {
          role: "image",
          content: "sample",
          images: [GENERATED_SAMPLE_IMAGES.watercolorTraveler],
        },
      ],
    });
    const { project, warnings } = deserializeProject(source);

    expect(warnings).toEqual([]);
    expect(project.messages[0]?.images?.[0]).toMatchObject(
      GENERATED_SAMPLE_IMAGES.watercolorTraveler,
    );
  });
});
