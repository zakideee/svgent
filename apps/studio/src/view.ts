/**
 * Shows one exported SVG at the width of the screen.
 *
 * A tab opened on the file itself renders it at the size it was authored, so a
 * phone gets the top-left corner of a 1440-wide canvas. The same file inside a
 * document can be fitted — and the path stays on screen, linking to the raw
 * file, because seeing that it is an .svg is the reason for coming here.
 */

/** Only what this site exports; a src parameter is a stranger's text. */
const ALLOWED = ["/hero/", "/inputs/"];

/** The pages that can send someone here; anything else goes to the root. */
const ORIGINS = ["/", "/ja/"];

const back = document.querySelector(".viewer-back");
const from = new URLSearchParams(window.location.search).get("from") ?? "/";
if (back instanceof HTMLAnchorElement && ORIGINS.includes(from)) {
  back.href = from;
}

const media = document.querySelector(".viewer-media");
const file = document.querySelector(".viewer-file");
const src = new URLSearchParams(window.location.search).get("src") ?? "";
const allowed = ALLOWED.some((prefix) => src.startsWith(prefix)) && src.endsWith(".svg");

if (media instanceof HTMLImageElement && file instanceof HTMLAnchorElement) {
  if (allowed) {
    media.src = src;
    media.alt = src;
    file.href = src;
    const code = file.querySelector("code");
    if (code !== null) {
      code.textContent = src;
    }
  } else {
    file.remove();
    media.remove();
  }
}

export {};
