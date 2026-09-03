# Share cards

The `/og/site-og-*.png` cards under `../public/og/` are assembled from the
renderer's own output; nothing in this directory is deployed. One fictional
script, drawn on both surfaces: the terminal sits behind-left, the app
front-right, and the copy takes a solid band cut on a slant. The chrome's
free fields carry svgent feature names, the session shows the app's own
moves (a two-line prompt, the choice box, a reply streaming svgent-flavoured
TSX), and the type is deliberately small — at share size the card should
read as atmosphere, not as content.

## Regenerate

1. Render the backgrounds and copy the posters here:

   ```bash
   pnpm render examples/site-og-en.json --out /tmp/og --formats poster-png --strict
   pnpm render examples/site-og.json --out /tmp/og --formats poster-png --strict
   pnpm render examples/site-og-tui-en.json --out /tmp/og --formats poster-png --strict
   pnpm render examples/site-og-tui.json --out /tmp/og --formats poster-png --strict
   cp /tmp/og/site-og-en-01.png apps/studio/og-src/bg-en.png
   cp /tmp/og/site-og-01.png apps/studio/og-src/bg-ja.png
   cp /tmp/og/site-og-tui-en-01.png apps/studio/og-src/bg-tui-en.png
   cp /tmp/og/site-og-tui-01.png apps/studio/og-src/bg-tui-ja.png
   ```

2. Open `card-en.html` / `card-ja.html` in a browser and capture the page as
   PNG into `../public/og/site-og-en.png` / `../public/og/site-og-ja.png`.
   The viewport must be exactly 1200×630 at device scale 1 — use DevTools
   device emulation (a bare `--window-size` flag sets the window, not the
   viewport). The cards set their headline in Inter; capture on a machine
   with Inter installed, or the CJK fallback reflows the band.

3. Stamp provenance onto the captures. The four rendered backgrounds carry
   it from the CLI already; a browser screenshot leaves without metadata:

   ```bash
   pnpm exec tsx scripts/stamp-og-provenance.mts \
     apps/studio/public/og/site-og-en.png apps/studio/public/og/site-og-ja.png
   ```

The `og:` metadata itself lives in the six indexable pages' heads.
