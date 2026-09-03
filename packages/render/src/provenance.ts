import type { BuiltScene } from "@svgent/scene";

/**
 * Provenance carried by every exported artifact: the file is an authored
 * rendering, never a screen capture, and the declared script basis rides
 * along as `model-kind`. The engine embeds only its generator identity, so
 * raster and video containers get these facts stamped here, after encoding.
 */
export type ArtifactProvenance = {
  /** Declared script basis recorded as `model-kind`. */
  modelKind: string;
};

const XMP_PROVENANCE_NS = "https://github.com/zakideee/svgent/ns/provenance/1.0/";

/** Provenance a scene's root canvas meta declares for its exports. */
export function provenanceFor(scene: BuiltScene): ArtifactProvenance {
  const meta = (scene.vnode as { props?: { meta?: Record<string, unknown> } }).props?.meta;
  const simulated = meta?.simulated;
  const modelKind = meta?.["model-kind"];
  if (simulated !== "true" || typeof modelKind !== "string" || modelKind.length === 0) {
    // Same contract as renderArtifact's missing-generator refusal: an export
    // without provenance must not exist.
    throw new Error(
      "Refusing to export a scene without provenance meta: the root canvas must carry simulated=true and a model-kind basis",
    );
  }
  return { modelKind };
}

/** One canonical text payload shared by the PNG, GIF, and MP4 containers. */
export function provenanceCommentText(provenance: ArtifactProvenance): string {
  return `{"simulated":true,"model-kind":${JSON.stringify(provenance.modelKind)}}`;
}

function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

function alreadyStamped(bytes: Uint8Array, marker: string): boolean {
  return hasBytes(bytes, new TextEncoder().encode(marker));
}

const CRC32_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE_LENGTH = 8;

/**
 * Insert an iTXt `Comment` chunk right after IHDR. The engine's own iTXt
 * (`Software`) follows unchanged; text chunks may appear anywhere between
 * IHDR and IEND.
 */
export function stampPngProvenance(bytes: Uint8Array, provenance: ArtifactProvenance): Uint8Array {
  const text = provenanceCommentText(provenance);
  if (alreadyStamped(bytes, text)) {
    return bytes;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLength = view.getUint32(PNG_SIGNATURE_LENGTH);
  const insertAt = PNG_SIGNATURE_LENGTH + 12 + ihdrLength;
  const encoder = new TextEncoder();
  // iTXt layout: keyword NUL compression-flag compression-method NUL(language)
  // NUL(translated keyword) text.
  const body = encoder.encode(`Comment\u0000\u0000\u0000\u0000\u0000${text}`);
  const chunk = new Uint8Array(12 + body.length);
  const chunkView = new DataView(chunk.buffer);
  chunkView.setUint32(0, body.length);
  chunk.set(encoder.encode("iTXt"), 4);
  chunk.set(body, 8);
  chunkView.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
  const stamped = new Uint8Array(bytes.length + chunk.length);
  stamped.set(bytes.subarray(0, insertAt), 0);
  stamped.set(chunk, insertAt);
  stamped.set(bytes.subarray(insertAt), insertAt + chunk.length);
  return stamped;
}

const VP8X_ALPHA_FLAG = 0x10;

/**
 * Set the VP8X alpha flag when the VP8L stream declares alpha. The engine
 * writes the two inconsistently for still lossless output, which `webpinfo`
 * reports as an invalid file; every decoder tested renders it, but an
 * artifact that fails its own format's validator must not ship.
 */
function normalizeWebpAlphaFlag(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let vp8xFlagsAt: number | null = null;
  let vp8lDeclaresAlpha = false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourCc = decoder.decode(bytes.subarray(offset, offset + 4));
    const payloadLength = view.getUint32(offset + 4, true);
    if (fourCc === "VP8X") {
      vp8xFlagsAt = offset + 8;
    } else if (fourCc === "VP8L" && payloadLength >= 5 && view.getUint8(offset + 8) === 0x2f) {
      // VP8L header after the signature byte: 14-bit width, 14-bit height,
      // then the alpha_is_used bit.
      vp8lDeclaresAlpha = ((view.getUint32(offset + 9, true) >>> 28) & 1) === 1;
    }
    offset += 8 + payloadLength + (payloadLength % 2);
  }
  if (
    vp8xFlagsAt === null ||
    !vp8lDeclaresAlpha ||
    (view.getUint8(vp8xFlagsAt) & VP8X_ALPHA_FLAG) !== 0
  ) {
    return bytes;
  }
  const normalized = bytes.slice();
  normalized[vp8xFlagsAt] = view.getUint8(vp8xFlagsAt) | VP8X_ALPHA_FLAG;
  return normalized;
}

/**
 * Extend the engine's XMP chunk with an `rdf:Description` under svgent's own
 * namespace. Static and animated WebP share the RIFF layout, so one rewrite
 * covers both.
 */
export function stampWebpProvenance(
  rendered: Uint8Array,
  provenance: ArtifactProvenance,
): Uint8Array {
  const bytes = normalizeWebpAlphaFlag(rendered);
  if (alreadyStamped(bytes, XMP_PROVENANCE_NS)) {
    return bytes;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourCc = decoder.decode(bytes.subarray(offset, offset + 4));
    const payloadLength = view.getUint32(offset + 4, true);
    if (fourCc === "XMP ") {
      const payload = decoder.decode(bytes.subarray(offset + 8, offset + 8 + payloadLength));
      const closeTag = "</rdf:RDF>";
      const closeAt = payload.lastIndexOf(closeTag);
      if (closeAt === -1) {
        throw new Error("WebP XMP chunk carries no rdf:RDF element to extend");
      }
      const description =
        `<rdf:Description rdf:about="" xmlns:svgent="${XMP_PROVENANCE_NS}">` +
        `<svgent:simulated>true</svgent:simulated>` +
        `<svgent:model-kind>${provenance.modelKind}</svgent:model-kind>` +
        `</rdf:Description>`;
      const encoder = new TextEncoder();
      const stampedPayload = encoder.encode(
        payload.slice(0, closeAt) + description + payload.slice(closeAt),
      );
      const padded = stampedPayload.length % 2 === 1;
      const chunkLength = 8 + stampedPayload.length + (padded ? 1 : 0);
      const before = bytes.subarray(0, offset);
      const after = bytes.subarray(offset + 8 + payloadLength + (payloadLength % 2));
      const stamped = new Uint8Array(before.length + chunkLength + after.length);
      stamped.set(before, 0);
      stamped.set(encoder.encode("XMP "), offset);
      new DataView(stamped.buffer).setUint32(offset + 4, stampedPayload.length, true);
      stamped.set(stampedPayload, offset + 8);
      stamped.set(after, before.length + chunkLength);
      new DataView(stamped.buffer).setUint32(4, stamped.length - 8, true);
      return stamped;
    }
    offset += 8 + payloadLength + (payloadLength % 2);
  }
  throw new Error(
    "WebP output carries no XMP chunk to extend; the engine embeds one whenever a generator identity is set",
  );
}

/**
 * Insert a GIF Comment Extension between the header (with its global color
 * table) and the first data block.
 */
export function stampGifProvenance(bytes: Uint8Array, provenance: ArtifactProvenance): Uint8Array {
  const text = provenanceCommentText(provenance);
  if (alreadyStamped(bytes, text)) {
    return bytes;
  }
  const packed = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(10);
  const globalColorTableLength = (packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 0x07) + 1);
  const insertAt = 13 + globalColorTableLength;
  const body = new TextEncoder().encode(text);
  if (body.length > 255) {
    throw new Error("GIF comment payload exceeds one sub-block");
  }
  const extension = new Uint8Array(4 + body.length);
  extension[0] = 0x21;
  extension[1] = 0xfe;
  extension[2] = body.length;
  extension.set(body, 3);
  extension[3 + body.length] = 0x00;
  const stamped = new Uint8Array(bytes.length + extension.length);
  stamped.set(bytes.subarray(0, insertAt), 0);
  stamped.set(extension, insertAt);
  stamped.set(bytes.subarray(insertAt), insertAt + extension.length);
  return stamped;
}

type Mp4Box = {
  type: string;
  start: number;
  headerLength: number;
  length: number;
};

function readMp4Boxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const boxes: Mp4Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    const declared = view.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    let headerLength = 8;
    let length = declared;
    if (declared === 1) {
      length = Number(view.getBigUint64(offset + 8));
      headerLength = 16;
    } else if (declared === 0) {
      length = end - offset;
    }
    if (length < headerLength || offset + length > end) {
      throw new Error(`MP4 box "${type}" at ${offset} declares an out-of-range size`);
    }
    boxes.push({ type, start: offset, headerLength, length });
    offset += length;
  }
  return boxes;
}

// Atom types are classic Mac four-character codes; "©" is the single byte
// 0xa9 there, where UTF-8 would write two.
const COMMENT_ATOM_TYPE = new Uint8Array([0xa9, 0x63, 0x6d, 0x74]);

function buildMp4Box(type: string | Uint8Array, payload: Uint8Array): Uint8Array {
  const typeBytes = typeof type === "string" ? new TextEncoder().encode(type) : type;
  const box = new Uint8Array(8 + payload.length);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set(typeBytes, 4);
  box.set(payload, 8);
  return box;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** iTunes-style `udta/meta/ilst` comment carrying the canonical payload. */
function buildProvenanceUdta(provenance: ArtifactProvenance): Uint8Array {
  const encoder = new TextEncoder();
  const text = encoder.encode(provenanceCommentText(provenance));
  const dataPayload = new Uint8Array(8 + text.length);
  // Well-known data-atom header: type 1 (UTF-8 text) and a zero locale.
  new DataView(dataPayload.buffer).setUint32(0, 1);
  dataPayload.set(text, 8);
  const commentItem = buildMp4Box(COMMENT_ATOM_TYPE, buildMp4Box("data", dataPayload));
  const ilst = buildMp4Box("ilst", commentItem);
  const handlerPayload = new Uint8Array(25);
  handlerPayload.set(encoder.encode("mdir"), 8);
  handlerPayload.set(encoder.encode("appl"), 12);
  const hdlr = buildMp4Box("hdlr", handlerPayload);
  const metaPayload = concatBytes([new Uint8Array(4), hdlr, ilst]);
  return buildMp4Box("udta", buildMp4Box("meta", metaPayload));
}

const MP4_CONTAINER_BOX_TYPES = new Set(["moov", "trak", "mdia", "minf", "stbl"]);

type Mp4OffsetShift = {
  /** Absolute file position from which sample data moved. */
  movedFrom: number;
  /** How many bytes the data past `movedFrom` moved back. */
  delta: number;
};

/**
 * Add the shift's `delta` to every stco/co64 chunk offset at or past its
 * `movedFrom`. Offsets are absolute file positions, so growing the moov box
 * shifts every sample that used to live after it.
 */
function shiftMp4ChunkOffsets(bytes: Uint8Array, boxes: Mp4Box[], shift: Mp4OffsetShift): void {
  const { movedFrom, delta } = shift;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const box of boxes) {
    if (MP4_CONTAINER_BOX_TYPES.has(box.type)) {
      shiftMp4ChunkOffsets(
        bytes,
        readMp4Boxes(bytes, box.start + box.headerLength, box.start + box.length),
        shift,
      );
      continue;
    }
    if (box.type !== "stco" && box.type !== "co64") {
      continue;
    }
    const entryCount = view.getUint32(box.start + box.headerLength + 4);
    const entriesAt = box.start + box.headerLength + 8;
    for (let index = 0; index < entryCount; index += 1) {
      if (box.type === "stco") {
        const entryAt = entriesAt + index * 4;
        const value = view.getUint32(entryAt);
        if (value >= movedFrom) {
          view.setUint32(entryAt, value + delta);
        }
      } else {
        const entryAt = entriesAt + index * 8;
        const value = view.getBigUint64(entryAt);
        if (value >= BigInt(movedFrom)) {
          view.setBigUint64(entryAt, value + BigInt(delta));
        }
      }
    }
  }
}

/**
 * Append a provenance comment to the moov box of a finished MP4. Works on
 * both faststart (moov before mdat) and trailing-moov layouts: chunk offsets
 * pointing past the grown moov are shifted by the growth.
 */
export function stampMp4Provenance(bytes: Uint8Array, provenance: ArtifactProvenance): Uint8Array {
  const text = provenanceCommentText(provenance);
  if (alreadyStamped(bytes, text)) {
    return bytes;
  }
  const topLevel = readMp4Boxes(bytes, 0, bytes.length);
  const moov = topLevel.find((box) => box.type === "moov");
  if (moov === undefined) {
    throw new Error("MP4 output carries no moov box");
  }
  if (moov.headerLength !== 8) {
    throw new Error("MP4 moov box uses a 64-bit size; refusing to rewrite it");
  }
  const udta = buildProvenanceUdta(provenance);
  const moovEnd = moov.start + moov.length;
  const stamped = new Uint8Array(bytes.length + udta.length);
  stamped.set(bytes.subarray(0, moovEnd), 0);
  stamped.set(udta, moovEnd);
  stamped.set(bytes.subarray(moovEnd), moovEnd + udta.length);
  new DataView(stamped.buffer).setUint32(moov.start, moov.length + udta.length);
  const stampedTopLevel = readMp4Boxes(stamped, 0, stamped.length);
  shiftMp4ChunkOffsets(stamped, stampedTopLevel, { movedFrom: moovEnd, delta: udta.length });
  return stamped;
}
