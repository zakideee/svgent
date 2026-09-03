/**
 * Devtool source view: a Prism-highlighted window into the generated SVG
 * markup, focused on the inspected node when there is one.
 */

import Prism from "prismjs";

/** Source excerpt sizes for the devtool view — full markup stays in Download. */
const SOURCE_LEAD_CHARS = 9_000;
const SOURCE_FOCUS_BEFORE = 1_500;
const SOURCE_FOCUS_AFTER = 5_500;

type SourceViewPart = { key: string; html: string; target?: boolean };

export type SourceView = { truncated: boolean; parts: SourceViewPart[] };

export function buildSourceView(previewSvg: string, inspectedNodeId: string | null): SourceView {
  // The viewer shows a window into the source, so a <style> block usually
  // has its closing tag outside the fragment and Prism's markup grammar
  // cannot see it. Locate the style content ranges up front and highlight
  // those stretches with the CSS grammar instead.
  const styleRanges: Array<[number, number]> = [];
  const styleOpen = /<style[^>]*>/g;
  for (let match = styleOpen.exec(previewSvg); match; match = styleOpen.exec(previewSvg)) {
    const contentStart = match.index + match[0].length;
    const close = previewSvg.indexOf("</style>", contentStart);
    styleRanges.push([contentStart, close === -1 ? previewSvg.length : close]);
    if (close === -1) {
      break;
    }
  }
  const highlightAt = (absStart: number, absEnd: number): string => {
    const fragment = previewSvg.slice(absStart, absEnd);
    let html = "";
    let cursor = 0;
    for (const [rangeStart, rangeEnd] of styleRanges) {
      const from = Math.max(0, rangeStart - absStart);
      const to = Math.min(fragment.length, rangeEnd - absStart);
      if (to <= 0 || from >= fragment.length || from >= to) {
        continue;
      }
      if (from > cursor) {
        html += Prism.highlight(
          fragment.slice(cursor, from),
          Prism.languages.markup as Prism.Grammar,
          "markup",
        );
      }
      html += Prism.highlight(
        fragment.slice(from, to),
        Prism.languages.css as Prism.Grammar,
        "css",
      );
      cursor = to;
    }
    if (cursor < fragment.length) {
      html += Prism.highlight(
        fragment.slice(cursor),
        Prism.languages.markup as Prism.Grammar,
        "markup",
      );
    }
    return html;
  };
  if (inspectedNodeId) {
    const marker = `data-boundsvg-node-id="${inspectedNodeId}"`;
    const markerIndex = previewSvg.indexOf(marker);
    if (markerIndex >= 0) {
      const tagStart = Math.max(0, previewSvg.lastIndexOf("<", markerIndex));
      const tagEnd = previewSvg.indexOf(">", markerIndex) + 1;
      const windowStart = Math.max(0, tagStart - SOURCE_FOCUS_BEFORE);
      const windowEnd = Math.min(previewSvg.length, tagEnd + SOURCE_FOCUS_AFTER);
      return {
        truncated: windowStart > 0 || windowEnd < previewSvg.length,
        parts: [
          { key: "before", html: highlightAt(windowStart, tagStart) },
          { key: "target", html: highlightAt(tagStart, tagEnd), target: true },
          { key: "after", html: highlightAt(tagEnd, windowEnd) },
        ],
      };
    }
  }
  const windowEnd = Math.min(previewSvg.length, SOURCE_LEAD_CHARS);
  return {
    truncated: windowEnd < previewSvg.length,
    parts: [{ key: "lead", html: highlightAt(0, windowEnd) }],
  };
}
