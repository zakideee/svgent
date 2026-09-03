/**
 * The READMEs state the size of every artifact they show, and the length of
 * every MP4. Those numbers move whenever a script's timing changes, and a
 * stale one is invisible in review — the page still renders, the figure is
 * just wrong. So each claim is paired with the file it describes and
 * checked here, and any new claim has to join the table to pass.
 */

import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const README_FILES = ["README.md", "README.ja.md"] as const;
const DEMO_DIR = "assets/readme/demo";

/** Every stated size, as `claim text` → the artifact it describes. */
const SIZE_CLAIMS: Array<{ file: string; claim: string; artifact: string }> = [
  {
    file: "README.md",
    claim: "transcript SVG (0.66 MB)",
    artifact: `${DEMO_DIR}/readme-english-01.transcript.svg`,
  },
  {
    file: "README.md",
    claim: "animated SVG (1.77 MB)",
    artifact: `${DEMO_DIR}/readme-en-tui-dark-01.animated.svg`,
  },
  {
    file: "README.md",
    claim: "Animated WebP (3.43 MB)",
    artifact: `${DEMO_DIR}/readme-en-tui-dark-01.animated.webp`,
  },
  {
    file: "README.md",
    claim: "MP4 (28.4 seconds, 0.26 MB)",
    artifact: `${DEMO_DIR}/readme-en-tui-dark-01.mp4`,
  },
  {
    file: "README.md",
    claim: "animated SVG (1.46 MB)",
    artifact: `${DEMO_DIR}/readme-en-app-image-01.animated.svg`,
  },
  {
    file: "README.md",
    claim: "Animated WebP (5.00 MB)",
    artifact: `${DEMO_DIR}/readme-en-app-image-01.animated.webp`,
  },
  {
    file: "README.md",
    claim: "MP4 (20.1 seconds, 0.18 MB)",
    artifact: `${DEMO_DIR}/readme-en-app-image-01.mp4`,
  },
  {
    file: "README.md",
    claim: "animated SVG (1.54 MB)",
    artifact: `${DEMO_DIR}/readme-en-app-zoom-01.animated.svg`,
  },
  {
    file: "README.md",
    claim: "Regular final frame (WebP, 0.05 MB)",
    artifact: `${DEMO_DIR}/readme-en-tui-dark-01.webp`,
  },
  {
    file: "README.md",
    claim: "Full transcript (PNG, 0.16 MB)",
    artifact: `${DEMO_DIR}/readme-en-tui-dark-01.transcript.png`,
  },
  {
    file: "README.ja.md",
    claim: "animated SVG (2.65 MB)",
    artifact: `${DEMO_DIR}/readme-tui-dark-01.animated.svg`,
  },
  {
    file: "README.ja.md",
    claim: "animated WebP (1.74 MB)",
    artifact: `${DEMO_DIR}/readme-tui-dark-01.animated.webp`,
  },
  {
    file: "README.ja.md",
    claim: "MP4 (26.8秒、0.25 MB)",
    artifact: `${DEMO_DIR}/readme-tui-dark-01.mp4`,
  },
  {
    file: "README.ja.md",
    claim: "animated SVG (1.81 MB)",
    artifact: `${DEMO_DIR}/readme-app-image-01.animated.svg`,
  },
  {
    file: "README.ja.md",
    claim: "animated WebP (2.46 MB)",
    artifact: `${DEMO_DIR}/readme-app-image-01.animated.webp`,
  },
  {
    file: "README.ja.md",
    claim: "MP4 (20.4秒、0.19 MB)",
    artifact: `${DEMO_DIR}/readme-app-image-01.mp4`,
  },
  {
    file: "README.ja.md",
    claim: "animated SVG (1.93 MB)",
    artifact: `${DEMO_DIR}/readme-tui-zoom-01.animated.svg`,
  },
  {
    file: "README.ja.md",
    claim: "通常の最終フレーム (WebP、0.05 MB)",
    artifact: `${DEMO_DIR}/readme-tui-dark-01.webp`,
  },
  {
    file: "README.ja.md",
    claim: "会話全体 (PNG、0.16 MB)",
    artifact: `${DEMO_DIR}/readme-tui-dark-01.transcript.png`,
  },
];

/**
 * Ranges rather than a single artifact: the three slides are one figure,
 * and the claim is the span they fall in.
 */
const RANGE_CLAIMS: Array<{ file: string; claim: string; artifacts: string[] }> = [
  {
    file: "README.md",
    claim: "three poster WebP files (0.02 MB each)",
    artifacts: [1, 2, 3].map((page) => `${DEMO_DIR}/readme-en-slides-light-0${page}.webp`),
  },
  {
    file: "README.ja.md",
    claim: "poster WebP 3枚 (各0.02 MB)",
    artifacts: [1, 2, 3].map((page) => `${DEMO_DIR}/readme-slides-light-0${page}.webp`),
  },
];

/** Anything that looks like a stated size, so none can be added unpaired. */
const SIZE_PATTERN = /\d+\.\d+\s*MB/gu;

async function megabytes(path: string): Promise<number> {
  return (await stat(path)).size / 1_048_576;
}

/**
 * The movie's own length, read from the `mvhd` box — the artifact's fact,
 * not the timeline's intent, so a mis-encoded export is caught too.
 */
async function mp4Seconds(path: string): Promise<number> {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findBox = (start: number, end: number, wanted: string): number | null => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = view.getUint32(offset);
      const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
      if (type === wanted) {
        return offset;
      }
      if (type === "moov") {
        const inner = findBox(offset + 8, offset + (size === 0 ? end - offset : size), wanted);
        if (inner !== null) {
          return inner;
        }
      }
      if (size < 8) {
        return null;
      }
      offset += size;
    }
    return null;
  };
  const mvhd = findBox(0, bytes.byteLength, "mvhd");
  if (mvhd === null) {
    throw new Error(`${path} has no mvhd box`);
  }
  const version = view.getUint8(mvhd + 8);
  return version === 1
    ? Number(view.getBigUint64(mvhd + 28)) / view.getUint32(mvhd + 24)
    : view.getUint32(mvhd + 24) / view.getUint32(mvhd + 20);
}

describe("README figures", () => {
  it.each(SIZE_CLAIMS)("states $artifact at its real size", async ({ file, claim, artifact }) => {
    const source = await readFile(file, "utf8");
    expect(source, `${file} no longer contains "${claim}"`).toContain(claim);

    const stated = claim.match(/(\d+\.\d+)\s*MB/u)?.[1];
    expect(Number(stated).toFixed(2)).toBe((await megabytes(artifact)).toFixed(2));

    const seconds = claim.match(/(\d+\.\d+)\s*(?:seconds|秒)/u)?.[1];
    if (seconds !== undefined) {
      expect(Number(seconds).toFixed(1)).toBe((await mp4Seconds(artifact)).toFixed(1));
    }
  });

  it.each(RANGE_CLAIMS)("brackets $claim correctly", async ({ file, claim, artifacts }) => {
    const source = await readFile(file, "utf8");
    expect(source, `${file} no longer contains "${claim}"`).toContain(claim);

    const bounds = [...claim.matchAll(/(\d+\.\d+)/gu)].map((match) => Number(match[1]));
    const [low, high] = [Math.min(...bounds), Math.max(...bounds)];
    for (const artifact of artifacts) {
      const actual = Number((await megabytes(artifact)).toFixed(2));
      expect(actual, artifact).toBeGreaterThanOrEqual(low);
      expect(actual, artifact).toBeLessThanOrEqual(high);
    }
  });

  it.each(README_FILES)("pairs every size %s states with an artifact", async (file) => {
    const source = await readFile(file, "utf8");
    const paired = [...SIZE_CLAIMS, ...RANGE_CLAIMS]
      .filter((entry) => entry.file === file)
      .flatMap((entry) => [...entry.claim.matchAll(SIZE_PATTERN)].map((match) => match[0]));
    const stated = [...source.matchAll(SIZE_PATTERN)].map((match) => match[0]);

    // Every figure on the page is one this suite checks. A new demo whose
    // size is written by hand fails here until it is paired above.
    expect(stated.length).toBe(paired.length);
    expect([...stated].sort()).toEqual([...paired].sort());
  });
});
