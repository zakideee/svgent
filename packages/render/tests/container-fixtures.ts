/**
 * Hand-built minimal container files. The provenance stamp parses the bytes
 * it rewrites, so a mocked encoder has to return something structurally
 * valid — one chunk each is enough.
 */
import { expect } from "vitest";

const encoder = new TextEncoder();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    let value = (crc ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crc = value ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + payload.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length);
  chunk.set(encoder.encode(type), 4);
  chunk.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));
  return chunk;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

export function syntheticPng(): Uint8Array {
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", new Uint8Array(13)),
    pngChunk("IDAT", new Uint8Array([1, 2, 3])),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** WebP container holding only the engine-style XMP chunk. */
export function syntheticWebp(): Uint8Array {
  const xmp = encoder.encode(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>',
  );
  const padding = xmp.length % 2;
  const bytes = new Uint8Array(20 + xmp.length + padding);
  bytes.set(encoder.encode("RIFF"), 0);
  bytes.set(encoder.encode("WEBP"), 8);
  bytes.set(encoder.encode("XMP "), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, xmp.length, true);
  bytes.set(xmp, 20);
  return bytes;
}

export function syntheticGif(withGlobalColorTable: boolean): Uint8Array {
  const tableLength = withGlobalColorTable ? 6 : 0;
  const bytes = new Uint8Array(14 + tableLength);
  bytes.set(encoder.encode("GIF89a"), 0);
  bytes[6] = 1;
  bytes[8] = 1;
  // Global color table flag plus size bits 000 → a 2-entry, 6-byte table.
  bytes[10] = withGlobalColorTable ? 0x80 : 0x00;
  bytes[13 + tableLength] = 0x3b;
  return bytes;
}

function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set(encoder.encode(type), 4);
  bytes.set(payload, 8);
  return bytes;
}

function stcoPayload(offsets: number[]): Uint8Array {
  const payload = new Uint8Array(8 + offsets.length * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(4, offsets.length);
  offsets.forEach((offset, index) => {
    view.setUint32(8 + index * 4, offset);
  });
  return payload;
}

/** Faststart layout: moov ahead of mdat, chunk offsets pointing into mdat. */
export function syntheticFaststartMp4(): { bytes: Uint8Array; mdatPayloadAt: number } {
  const ftyp = mp4Box("ftyp", encoder.encode("isom0000"));
  const buildMoov = (offsets: number[]): Uint8Array =>
    mp4Box(
      "moov",
      mp4Box(
        "trak",
        mp4Box("mdia", mp4Box("minf", mp4Box("stbl", mp4Box("stco", stcoPayload(offsets))))),
      ),
    );
  const mdatPayloadAt = ftyp.length + buildMoov([0, 0]).length + 8;
  const moov = buildMoov([mdatPayloadAt, mdatPayloadAt + 2]);
  const mdat = mp4Box("mdat", new Uint8Array([9, 9, 9, 9]));
  return { bytes: concatBytes([ftyp, moov, mdat]), mdatPayloadAt };
}

type Mp4Node = { type: string; start: number; length: number; children: Mp4Node[] };

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta"]);

// MP4 atom types are classic Mac four-character codes ("©cmt"), not UTF-8.
const latin1 = new TextDecoder("latin1");

export function walkMp4(bytes: Uint8Array, start: number, end: number): Mp4Node[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodes: Mp4Node[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const length = view.getUint32(offset);
    const type = latin1.decode(bytes.subarray(offset + 4, offset + 8));
    nodes.push({
      type,
      start: offset,
      length,
      children: MP4_CONTAINERS.has(type) ? walkMp4(bytes, offset + 8, offset + length) : [],
    });
    offset += length;
  }
  expect(offset).toBe(end);
  return nodes;
}

/** VP8X + VP8L WebP whose alpha declarations disagree, engine-style. */
export function syntheticAlphaMismatchWebp(): Uint8Array {
  const xmp = encoder.encode(
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF></x:xmpmeta>',
  );
  const xmpPadding = xmp.length % 2;
  const vp8x = new Uint8Array(10);
  const vp8l = new Uint8Array([0x2f, 0x00, 0x00, 0x00, 0x10, 0x00]);
  const bytes = new Uint8Array(
    12 + 8 + vp8x.length + 8 + vp8l.length + 8 + xmp.length + xmpPadding,
  );
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode("RIFF"), 0);
  view.setUint32(4, bytes.length - 8, true);
  bytes.set(encoder.encode("WEBP"), 8);
  bytes.set(encoder.encode("VP8X"), 12);
  view.setUint32(16, vp8x.length, true);
  bytes.set(vp8x, 20);
  bytes.set(encoder.encode("VP8L"), 30);
  view.setUint32(34, vp8l.length, true);
  bytes.set(vp8l, 38);
  bytes.set(encoder.encode("XMP "), 44);
  view.setUint32(48, xmp.length, true);
  bytes.set(xmp, 52);
  return bytes;
}

/** Alpha declarations read back off a WebP container, null when absent. */
export function webpAlphaDeclarations(bytes: Uint8Array): {
  vp8xAlpha: boolean | null;
  vp8lAlpha: boolean | null;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const latin = new TextDecoder("latin1");
  let vp8xAlpha: boolean | null = null;
  let vp8lAlpha: boolean | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourCc = latin.decode(bytes.subarray(offset, offset + 4));
    const payloadLength = view.getUint32(offset + 4, true);
    if (fourCc === "VP8X") {
      vp8xAlpha = (view.getUint8(offset + 8) & 0x10) !== 0;
    } else if (fourCc === "VP8L" && payloadLength >= 5) {
      vp8lAlpha = ((view.getUint32(offset + 9, true) >>> 28) & 1) === 1;
    }
    offset += 8 + payloadLength + (payloadLength % 2);
  }
  return { vp8xAlpha, vp8lAlpha };
}
