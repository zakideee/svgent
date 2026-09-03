import { type AttachedImage, MAX_IMAGE_BYTES } from "@svgent/scene";
import type { UiStrings } from "./i18n.js";

// Re-encode bounds: the largest canvas is 1920px wide, so 2048 on the long
// edge loses nothing on screen, and WebP at this quality typically turns a
// multi-megabyte photo into a few hundred kilobytes — which is what keeps
// script JSON portable and per-keystroke scene rebuilds cheap.
const REENCODE_EDGE_MAX_PX = 2048;
const REENCODE_QUALITY = 0.85;

function readAsDataUrl(blob: Blob, t: UiStrings): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error(t.errorImageDataUrl));
        return;
      }
      resolve(reader.result);
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error(t.errorImageRead)));
    reader.readAsDataURL(blob);
  });
}

/** Draw the bitmap at the target size and encode it as WebP, if the browser can. */
async function encodeWebp(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", REENCODE_QUALITY),
  );
  return blob && blob.type === "image/webp" ? blob : null;
}

/** The file-picker filter, kept beside the type check it has to mirror. */
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

export async function readAttachedImage(file: File, t: UiStrings): Promise<AttachedImage> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(t.errorImageTooLarge(MAX_IMAGE_BYTES / 1024 / 1024));
  }
  if (file.type !== "image/png" && file.type !== "image/jpeg" && file.type !== "image/webp") {
    throw new Error(t.errorImageUnsupportedType);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // A corrupt file with a correct MIME type lands here; the raw
    // DOMException would reach the UI untranslated.
    throw new Error(t.errorImageRead);
  }
  try {
    const scale = Math.min(1, REENCODE_EDGE_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const encoded = await encodeWebp(bitmap, width, height);
    // The original survives only when it is already smaller at full size;
    // anything downscaled must take the re-encode, or the shrink is lost.
    const useEncoded = encoded !== null && (scale < 1 || encoded.size < file.size);
    // The alt is a display string that reaches exports (the TUI prints
    // it); a filename is not that — screenshots auto-name themselves with
    // dates and titles nobody meant to publish.
    return useEncoded
      ? {
          dataUrl: await readAsDataUrl(encoded, t),
          mediaType: "image/webp",
          width,
          height,
          alt: "image",
        }
      : {
          dataUrl: await readAsDataUrl(file, t),
          mediaType: file.type,
          width: bitmap.width,
          height: bitmap.height,
          alt: "image",
        };
  } finally {
    bitmap.close();
  }
}
