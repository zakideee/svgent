/**
 * One studio's identity among however many share a page.
 *
 * A preview is an inline SVG, and an inline SVG's `<style>` belongs to the
 * whole HTML document rather than to the SVG. Everything a render names after
 * its prefix — the `@keyframes`, the generated classes, the `<defs>` a
 * `url(#…)` resolves — is therefore shared with every other drawing on the
 * page. Two studios naming theirs identically would let the later definition
 * drive both. React already tells one instance from another, so the caller is
 * asked for nothing.
 */
import { normalizeIdentifierNamespace } from "@svgent/render";
import { useId } from "react";

/**
 * `useId` returns a value with delimiters in it. What survives a class name
 * and a `url(#…)` is decided once, by the renderer, so this cannot answer the
 * question differently from the check a written-out namespace goes through.
 */
export function useInstanceIdentifier(): string {
  return normalizeIdentifierNamespace(useId());
}

/*
 * Each of these is read in one file and written in another. Spelled out at
 * both ends they drift silently: a rename in the markup leaves the lookup
 * searching for an element that no longer exists, and `?.click()` swallows
 * it — the upload button simply stops opening a file picker.
 */

/** The hidden file input a font slot's button opens. */
export function fontUploadId(instance: string, slot: string): string {
  return `font-upload-${instance}-${slot}`;
}

/** The datalist of Google font suggestions, and the field that reads it. */
export function googleFontListId(instance: string): string {
  return `google-font-suggestions-${instance}`;
}

/** The export dialog's motion-settings heading, and what it labels. */
export function exportMotionTitleId(instance: string): string {
  return `export-motion-options-title-${instance}`;
}
