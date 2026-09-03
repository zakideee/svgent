import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "../src/mp4-ffmpeg.mjs";

const TEST_GENERATOR = { name: "svgent-cli", version: "1.2.3" } as const;
const TEST_COMMENT = '{"simulated":true,"model-kind":"fictional"}';

describe("ffmpeg MP4 metadata", () => {
  it("writes the same package identity as the boundsvg export paths", () => {
    const args = buildFfmpegArgs("out.mp4", "#090b10", {
      generator: TEST_GENERATOR,
      provenanceComment: TEST_COMMENT,
    });
    const metadataIndex = args.indexOf("-metadata");

    expect(metadataIndex).toBeGreaterThanOrEqual(0);
    expect(args[metadataIndex + 1]).toBe(
      `encoding_tool=${TEST_GENERATOR.name}/${TEST_GENERATOR.version}`,
    );
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("writes the provenance comment alongside the encoder identity", () => {
    const args = buildFfmpegArgs("out.mp4", "#090b10", {
      generator: TEST_GENERATOR,
      provenanceComment: TEST_COMMENT,
    });
    expect(args).toContain(`comment=${TEST_COMMENT}`);
  });

  it("applies the selected frame rate and CRF", () => {
    const args = buildFfmpegArgs("out.mp4", "#090b10", {
      generator: TEST_GENERATOR,
      provenanceComment: TEST_COMMENT,
      frameRate: 10,
      crf: 28,
    });
    expect(args[args.indexOf("-framerate") + 1]).toBe("10");
    expect(args[args.indexOf("-crf") + 1]).toBe("28");
  });
});
