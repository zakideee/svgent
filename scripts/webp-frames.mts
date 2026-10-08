/** Read full WebP frames for decoder checks on runtimes without animated WebP demuxing. */

/** One independently decodable WebP frame and its display duration. */
export type WebpFrame = { bytes: Uint8Array; durationMs: number };

/** Extract frame bitstreams without changing their compressed pixels. */
export function webpFrames(bytes: Uint8Array): WebpFrame[] {
  const container = Buffer.from(bytes);
  if (
    container.toString("ascii", 0, 4) !== "RIFF" ||
    container.toString("ascii", 8, 12) !== "WEBP" ||
    container.readUInt32LE(4) + 8 !== container.length
  ) {
    throw new Error("Invalid WebP container");
  }
  const frames: WebpFrame[] = [];
  let offset = 12;
  while (offset + 8 <= container.length) {
    const size = container.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > container.length) {
      throw new Error("Truncated WebP chunk");
    }
    if (container.toString("ascii", offset, offset + 4) === "ANMF") {
      if (size < 16) {
        throw new Error("Truncated WebP frame");
      }
      const payload = container.subarray(offset + 8, end);
      const widthPx = payload.readUIntLE(6, 3) + 1;
      const heightPx = payload.readUIntLE(9, 3) + 1;
      const extended = Buffer.alloc(18);
      extended.write("VP8X", 0, "ascii");
      extended.writeUInt32LE(10, 4);
      extended[8] = 0x10;
      extended.writeUIntLE(widthPx - 1, 12, 3);
      extended.writeUIntLE(heightPx - 1, 15, 3);
      const pixels = payload.subarray(16);
      const content =
        pixels.toString("ascii", 0, 4) === "ALPH" ? Buffer.concat([extended, pixels]) : pixels;
      const header = Buffer.alloc(12);
      header.write("RIFF", 0, "ascii");
      header.writeUInt32LE(content.length + 4, 4);
      header.write("WEBP", 8, "ascii");
      frames.push({
        bytes: Buffer.concat([header, content]),
        durationMs: payload.readUIntLE(12, 3),
      });
    }
    offset = end + (size % 2);
  }
  if (offset !== container.length || frames.length === 0) {
    throw new Error("Missing or incomplete WebP animation");
  }
  return frames;
}
