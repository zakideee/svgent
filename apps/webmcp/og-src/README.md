# Share card

The `/og/agent-og-en.png` card under `../public/og/` is assembled from the
renderer's own output; nothing in this directory is deployed. Two showcase
scripts, one per surface: the terminal (`../scripts/deny-repro.json`) sits
behind-left, the app (`../scripts/share-safely.json`) front-right, and the
copy takes a solid band cut on a slant.

## Regenerate

1. Render the backgrounds on a transparent canvas and copy the posters here.
   Copy each script and set `appearance.transparentCanvas` to `true` first;
   the card supplies the gradient itself:

   ```bash
   pnpm render /tmp/og/share-safely.json --out /tmp/og --formats poster-png --strict
   pnpm render /tmp/og/deny-repro.json --out /tmp/og --formats poster-png --strict
   cp /tmp/og/share-safely-01.png apps/webmcp/og-src/bg-app.png
   cp /tmp/og/deny-repro-01.png apps/webmcp/og-src/bg-tui.png
   ```

2. Open `card-en.html` in a browser and capture the page as PNG into
   `../public/og/agent-og-en.png`. The viewport must be exactly 1200×630 at
   device scale 1; headless Chromium does this in one step:

   ```bash
   chromium --headless=new --hide-scrollbars --force-device-scale-factor=1 \
     --window-size=1200,630 --screenshot=apps/webmcp/public/og/agent-og-en.png \
     file://$PWD/apps/webmcp/og-src/card-en.html
   ```

   The card sets its headline in Inter; capture on a machine with Inter
   installed, or the CJK fallback reflows the band.

3. Stamp provenance onto the capture. The rendered backgrounds carry it
   from the CLI already; a browser screenshot leaves without metadata:

   ```bash
   pnpm exec tsx scripts/stamp-og-provenance.mts apps/webmcp/public/og/agent-og-en.png
   ```

The `og:` metadata itself lives in `../index.html`.
