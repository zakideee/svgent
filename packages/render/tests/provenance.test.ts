import {
  type ArtifactProvenance,
  provenanceCommentText,
  provenanceFor,
  stampGifProvenance,
  stampMp4Provenance,
  stampPngProvenance,
  stampWebpProvenance,
} from "@svgent/render";
import { buildSvgentScene, DEFAULT_PROJECT } from "@svgent/scene";
import { describe, expect, it } from "vitest";
import {
  crc32,
  syntheticAlphaMismatchWebp,
  syntheticFaststartMp4,
  syntheticGif,
  syntheticPng,
  syntheticWebp,
  walkMp4,
  webpAlphaDeclarations,
} from "./container-fixtures.js";

const FICTIONAL: ArtifactProvenance = { modelKind: "fictional" };
const COMMENT_TEXT = '{"simulated":true,"model-kind":"fictional"}';
const TEST_GENERATOR = { name: "svgent-test", version: "0.0.0" } as const;

const decoder = new TextDecoder();

type PngChunk = { type: string; payload: Uint8Array; crcOk: boolean };

function walkPngChunks(bytes: Uint8Array): PngChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const declaredCrc = view.getUint32(offset + 8 + length);
    chunks.push({
      type,
      payload,
      crcOk: declaredCrc === crc32(bytes.subarray(offset + 4, offset + 8 + length)),
    });
    offset += 12 + length;
  }
  expect(offset).toBe(bytes.length);
  return chunks;
}

describe("provenanceFor", () => {
  it("reads the declared basis off the built scene", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { generator: TEST_GENERATOR });
    expect(provenanceFor(scene)).toEqual({ modelKind: "fictional" });
  });

  it("follows a reenactment basis declaration", () => {
    const scene = buildSvgentScene({ ...DEFAULT_PROJECT, basis: "reenactment" }, 0, {
      generator: TEST_GENERATOR,
    });
    const provenance = provenanceFor(scene);
    expect(provenance.modelKind).toBe("reenactment");
    expect(provenanceCommentText(provenance)).toBe('{"simulated":true,"model-kind":"reenactment"}');
  });

  it("refuses a scene whose canvas declares no provenance", () => {
    const scene = buildSvgentScene(DEFAULT_PROJECT, 0, { generator: TEST_GENERATOR });
    const bare = {
      ...scene,
      vnode: { ...(scene.vnode as object), props: {} } as typeof scene.vnode,
    };
    expect(() => provenanceFor(bare)).toThrow(/without provenance/u);
  });
});

describe("stampPngProvenance", () => {
  it("inserts a CRC-valid iTXt comment after IHDR", () => {
    const stamped = stampPngProvenance(syntheticPng(), FICTIONAL);
    const chunks = walkPngChunks(stamped);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "iTXt", "IDAT", "IEND"]);
    const comment = chunks[1];
    expect(comment?.crcOk).toBe(true);
    expect(decoder.decode(comment?.payload)).toBe(
      `Comment\u0000\u0000\u0000\u0000\u0000${COMMENT_TEXT}`,
    );
  });

  it("stamps once", () => {
    const stamped = stampPngProvenance(syntheticPng(), FICTIONAL);
    expect(stampPngProvenance(stamped, FICTIONAL)).toBe(stamped);
  });
});

describe("stampWebpProvenance", () => {
  it("repairs a VP8X alpha flag the VP8L stream contradicts", () => {
    const mismatch = syntheticAlphaMismatchWebp();
    expect(webpAlphaDeclarations(mismatch)).toEqual({ vp8xAlpha: false, vp8lAlpha: true });
    const stamped = stampWebpProvenance(mismatch, FICTIONAL);
    expect(webpAlphaDeclarations(stamped)).toEqual({ vp8xAlpha: true, vp8lAlpha: true });
    expect(stampWebpProvenance(stamped, FICTIONAL)).toBe(stamped);
  });

  it("extends the XMP chunk and keeps the RIFF sizes consistent", () => {
    const stamped = stampWebpProvenance(syntheticWebp(), FICTIONAL);
    const view = new DataView(stamped.buffer, stamped.byteOffset, stamped.byteLength);
    expect(view.getUint32(4, true)).toBe(stamped.length - 8);
    const payloadLength = view.getUint32(16, true);
    expect(20 + payloadLength + (payloadLength % 2)).toBe(stamped.length);
    const xmp = decoder.decode(stamped.subarray(20, 20 + payloadLength));
    expect(xmp).toContain("<svgent:simulated>true</svgent:simulated>");
    expect(xmp).toContain("<svgent:model-kind>fictional</svgent:model-kind>");
    expect(xmp.endsWith("</rdf:RDF></x:xmpmeta>")).toBe(true);
  });

  it("stamps once", () => {
    const stamped = stampWebpProvenance(syntheticWebp(), FICTIONAL);
    expect(stampWebpProvenance(stamped, FICTIONAL)).toBe(stamped);
  });
});

describe("stampGifProvenance", () => {
  it.each([
    false,
    true,
  ])("inserts a comment extension after the header (global color table: %s)", (withGlobalColorTable) => {
    const stamped = stampGifProvenance(syntheticGif(withGlobalColorTable), FICTIONAL);
    const insertAt = withGlobalColorTable ? 19 : 13;
    expect(stamped[insertAt]).toBe(0x21);
    expect(stamped[insertAt + 1]).toBe(0xfe);
    expect(stamped[insertAt + 2]).toBe(COMMENT_TEXT.length);
    expect(decoder.decode(stamped.subarray(insertAt + 3, insertAt + 3 + COMMENT_TEXT.length))).toBe(
      COMMENT_TEXT,
    );
    expect(stamped[insertAt + 3 + COMMENT_TEXT.length]).toBe(0x00);
    expect(stamped[stamped.length - 1]).toBe(0x3b);
  });

  it("stamps once", () => {
    const stamped = stampGifProvenance(syntheticGif(true), FICTIONAL);
    expect(stampGifProvenance(stamped, FICTIONAL)).toBe(stamped);
  });
});

describe("stampMp4Provenance", () => {
  it("appends a udta comment to moov and shifts the chunk offsets", () => {
    const { bytes, mdatPayloadAt } = syntheticFaststartMp4();
    const stamped = stampMp4Provenance(bytes, FICTIONAL);
    const topLevel = walkMp4(stamped, 0, stamped.length);
    expect(topLevel.map((node) => node.type)).toEqual(["ftyp", "moov", "mdat"]);

    const moov = topLevel[1];
    const udta = moov?.children.find((node) => node.type === "udta");
    const meta = udta?.children[0];
    expect(meta?.type).toBe("meta");
    // meta is a full box: its children start after the 4 version/flags bytes.
    const metaChildren = walkMp4(
      stamped,
      (meta?.start ?? 0) + 12,
      (meta?.start ?? 0) + (meta?.length ?? 0),
    );
    expect(metaChildren.map((node) => node.type)).toEqual(["hdlr", "ilst"]);
    const ilst = metaChildren[1];
    const comment = walkMp4(
      stamped,
      (ilst?.start ?? 0) + 8,
      (ilst?.start ?? 0) + (ilst?.length ?? 0),
    )[0];
    expect(comment?.type).toBe("©cmt");
    const data = walkMp4(
      stamped,
      (comment?.start ?? 0) + 8,
      (comment?.start ?? 0) + (comment?.length ?? 0),
    )[0];
    expect(data?.type).toBe("data");
    expect(
      decoder.decode(
        stamped.subarray((data?.start ?? 0) + 16, (data?.start ?? 0) + (data?.length ?? 0)),
      ),
    ).toBe(COMMENT_TEXT);

    // The grown moov pushed mdat back by exactly the udta length; the sample
    // offsets must follow it.
    const delta = udta?.length ?? 0;
    const stampedView = new DataView(stamped.buffer, stamped.byteOffset, stamped.byteLength);
    const stco = moov?.children[0]?.children[0]?.children[0]?.children[0]?.children[0];
    expect(stco?.type).toBe("stco");
    const entriesAt = (stco?.start ?? 0) + 16;
    expect(stampedView.getUint32(entriesAt)).toBe(mdatPayloadAt + delta);
    expect(stampedView.getUint32(entriesAt + 4)).toBe(mdatPayloadAt + 2 + delta);
  });

  it("stamps once", () => {
    const stamped = stampMp4Provenance(syntheticFaststartMp4().bytes, FICTIONAL);
    expect(stampMp4Provenance(stamped, FICTIONAL)).toBe(stamped);
  });
});
