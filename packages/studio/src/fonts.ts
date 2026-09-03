import { preloadFonts, type ResolvedBrowserFont } from "@boundsvg/browser";
import { BUNDLED_FONT_FILES } from "@svgent/assets";
import {
  buildGoogleFontCssUrl,
  FALLBACK_FONT_ALIAS,
  FONT_ALIAS,
  type FontChoice,
  type FontSlot,
  type FontsSettings,
  type ScriptFontProvenance,
} from "@svgent/scene";
import type { UiStrings } from "./i18n.js";

export type UploadedFont = {
  fileName: string;
  data: Uint8Array;
  /**
   * Content hash of the bytes. The bytes themselves stay in this tab — a font
   * licence is not ours to redistribute inside a script — so this is what a
   * written-out script carries, and it is enough to tell whoever opens it that
   * they are looking at different metrics.
   */
  sha256: string;
};

export type UploadedFonts = Partial<Record<FontSlot, UploadedFont>>;

function bundledSource(slot: FontSlot, resolveAssetUrl: (assetPath: string) => string): string {
  return resolveAssetUrl(`fonts/${BUNDLED_FONT_FILES[slot]}`);
}

/** family + subset text → fetched binary, so retyping doesn't refetch. */
const googleFontCache = new Map<string, Promise<Uint8Array>>();

/**
 * Every typing pause that changes the character subset mints a new cache
 * key holding a multi-hundred-KB binary, so the cache is a small LRU
 * rather than append-only; two slots (sans + mono) fit with room to spare.
 */
const GOOGLE_FONT_CACHE_MAX = 8;

const MAX_FONT_BYTES = 12 * 1024 * 1024;

/**
 * css2 answers errors (unknown family, bad axis) WITHOUT CORS headers, so in
 * a browser they surface as an opaque "Failed to fetch" — indistinguishable
 * from being offline or ad-blocked. Probe a family that always exists to
 * tell the two apart and report something actionable.
 */
async function explainCssFetchFailure(family: string, t: UiStrings): Promise<Error> {
  try {
    const probe = await fetch(buildGoogleFontCssUrl("Roboto", "a"), {
      headers: { Accept: "text/css,*/*;q=0.1" },
    });
    if (probe.ok) {
      return new Error(t.errorGoogleFontNotFound(family));
    }
  } catch {
    // Probe also failed — the endpoint itself is unreachable.
  }
  return new Error(t.errorGoogleFontUnreachable);
}

async function fetchGoogleFontBinary(
  family: string,
  text: string,
  t: UiStrings,
): Promise<Uint8Array> {
  // Tuple-JSON key: families contain spaces, so a plain join is ambiguous.
  const cacheKey = JSON.stringify([family, text]);
  const cached = googleFontCache.get(cacheKey);
  if (cached) {
    // Refresh recency so the active slots never evict each other.
    googleFontCache.delete(cacheKey);
    googleFontCache.set(cacheKey, cached);
    return cached;
  }
  const promise = (async () => {
    const cssUrl = buildGoogleFontCssUrl(family, text);
    let cssResponse: Response;
    try {
      cssResponse = await fetch(cssUrl, { headers: { Accept: "text/css,*/*;q=0.1" } });
    } catch {
      throw await explainCssFetchFailure(family, t);
    }
    if (!cssResponse.ok) {
      throw new Error(t.errorGoogleFontCssStatus(cssResponse.status, cssUrl));
    }
    const css = await cssResponse.text();
    const match = /src:\s*url\((https:[^)]+)\)/u.exec(css);
    if (!match?.[1]) {
      throw new Error(t.errorGoogleFontNoUrl(family));
    }
    let fontResponse: Response;
    try {
      fontResponse = await fetch(match[1]);
    } catch {
      throw new Error(t.errorGoogleFontBinaryUnreachable(match[1]));
    }
    if (!fontResponse.ok) {
      throw new Error(t.errorGoogleFontBinaryStatus(fontResponse.status));
    }
    return new Uint8Array(await fontResponse.arrayBuffer());
  })();
  googleFontCache.set(cacheKey, promise);
  promise.catch(() => googleFontCache.delete(cacheKey));
  while (googleFontCache.size > GOOGLE_FONT_CACHE_MAX) {
    const oldestKey = googleFontCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    googleFontCache.delete(oldestKey);
  }
  return promise;
}

type ResolveFontChoiceInput = {
  slot: FontSlot;
  choice: FontChoice;
  uploads: UploadedFonts;
  subsetText: string;
  t: UiStrings;
  resolveAssetUrl: (assetPath: string) => string;
};

async function resolveFontChoice({
  slot,
  choice,
  uploads,
  subsetText,
  t,
  resolveAssetUrl,
}: ResolveFontChoiceInput): Promise<ResolvedBrowserFont> {
  const alias = FONT_ALIAS[slot];
  switch (choice.source) {
    case "bundled": {
      const [font] = await preloadFonts([
        { alias, weight: 400, style: "normal", source: bundledSource(slot, resolveAssetUrl) },
      ]);
      if (!font) {
        throw new Error(t.errorFontBundledFailed(slot));
      }
      return font;
    }
    case "upload": {
      const uploaded = uploads[slot];
      if (!uploaded) {
        throw new Error(t.errorFontNotSelected(slot));
      }
      return { alias, weight: 400, style: "normal", data: uploaded.data };
    }
    case "google": {
      const data = await fetchGoogleFontBinary(choice.family, subsetText, t);
      return { alias, weight: 400, style: "normal", data };
    }
  }
}

type ResolveFontsInput = {
  settings: FontsSettings;
  uploads: UploadedFonts;
  subsetText: string;
  t: UiStrings;
  resolveAssetUrl: (assetPath: string) => string;
};

/**
 * Resolve both slots into engine-ready fonts, plus the bundled pair under the
 * fallback aliases. A Google subset only carries what was requested and an
 * upload carries whatever it carries, so the bundled fonts ride along to close
 * every fallback chain (see FALLBACK_FONT_ALIAS).
 */
export async function resolveFonts({
  settings,
  uploads,
  subsetText,
  t,
  resolveAssetUrl,
}: ResolveFontsInput): Promise<ResolvedBrowserFont[]> {
  const [chosen, fallbacks] = await Promise.all([
    Promise.all([
      resolveFontChoice({
        slot: "sans",
        choice: settings.sans,
        uploads,
        subsetText,
        t,
        resolveAssetUrl,
      }),
      resolveFontChoice({
        slot: "mono",
        choice: settings.mono,
        uploads,
        subsetText,
        t,
        resolveAssetUrl,
      }),
    ]),
    preloadFonts([
      {
        alias: FALLBACK_FONT_ALIAS.sans,
        weight: 400,
        style: "normal",
        source: bundledSource("sans", resolveAssetUrl),
      },
      {
        alias: FALLBACK_FONT_ALIAS.mono,
        weight: 400,
        style: "normal",
        source: bundledSource("mono", resolveAssetUrl),
      },
    ]),
  ]);
  return [...chosen, ...fallbacks];
}

export async function readUploadedFont(file: File, t: UiStrings): Promise<UploadedFont> {
  if (file.size > MAX_FONT_BYTES) {
    throw new Error(t.errorFontTooLarge(MAX_FONT_BYTES / 1024 / 1024));
  }
  const data = new Uint8Array(await file.arrayBuffer());
  return { fileName: file.name, data, sha256: await hashFontBytes(data) };
}

/** Hashed once on upload: an export must not have to await the crypto API. */
async function hashFontBytes(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** What each slot resolved to, in the form a written-out script records. */
export function fontProvenance(
  settings: FontsSettings,
  uploads: UploadedFonts,
): Record<FontSlot, ScriptFontProvenance> {
  const forSlot = (slot: FontSlot): ScriptFontProvenance => {
    const choice = settings[slot];
    if (choice.source === "google") {
      return { source: "google", family: choice.family };
    }
    if (choice.source === "upload") {
      const uploaded = uploads[slot];
      return {
        source: "upload",
        fileName: choice.fileName,
        sha256: uploaded?.sha256 ?? "",
      };
    }
    return { source: "bundled" };
  };
  return { sans: forSlot("sans"), mono: forSlot("mono") };
}

/**
 * Slots whose recorded font this tab cannot reproduce. An upload is the case
 * that matters: the file names can match while the bytes do not, and nothing
 * about the rendering says so — the text simply wraps somewhere else.
 */
export function unresolvableFontSlots(
  recorded: Record<FontSlot, ScriptFontProvenance>,
  settings: FontsSettings,
  uploads: UploadedFonts,
): FontSlot[] {
  const here = fontProvenance(settings, uploads);
  return (["sans", "mono"] as const).filter((slot) => {
    const was = recorded[slot];
    const now = here[slot];
    if (was.source !== now.source) {
      return true;
    }
    if (was.source === "google" && now.source === "google") {
      return was.family !== now.family;
    }
    if (was.source === "upload" && now.source === "upload") {
      return was.sha256 !== now.sha256;
    }
    return false;
  });
}
