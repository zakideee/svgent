import { Studio } from "@svgent/studio";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@svgent/studio/styles.css";
import "./studio-page.css";
import { STUDIO_PRODUCT_CONFIG } from "./app-config.js";

// iOS Safari auto-zooms the page when a sub-16px field takes focus, and
// stays zoomed after input. maximum-scale=1 turns exactly that off: Safari
// honours the cap for the focus auto-zoom but ignores it for user pinches
// (an accessibility carve-out), so manual zoom keeps working. Applied only
// on iOS — elsewhere the cap would disable pinch zoom for real. The
// MacIntel+touch pair is iPadOS, which masquerades as macOS.
const isIos =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (isIos) {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1");
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

// The path is the language (one static URL per language), so the
// studio opens in the language of the page that linked here — not in a
// stored or browser preference that may contradict the door the visitor
// just walked through. The in-app toggle keeps working and rewrites the
// URL to the matching door, so a reload stays in the chosen language.
const locale = window.location.pathname.startsWith("/ja/") ? "ja" : "en";
const localePath = (next: string): string => (next === "ja" ? "/ja/studio/" : "/studio/");

createRoot(root).render(
  <StrictMode>
    <Studio
      product={STUDIO_PRODUCT_CONFIG}
      locale={locale}
      onboarding
      // The studio paints its own box; the page behind it is this app's, and
      // it has to agree with the shell where an overscroll shows it.
      onThemeChange={(theme) => {
        document.documentElement.dataset.uiTheme = theme;
      }}
      onLocaleChange={(next) => {
        const path = localePath(next);
        if (window.location.pathname !== path) {
          window.history.replaceState(null, "", path);
        }
      }}
    />
  </StrictMode>,
);
