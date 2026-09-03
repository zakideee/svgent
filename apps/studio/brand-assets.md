# Brand assets

The SVGs are the originals. Every glyph is an outlined `<path>` — no `<text>`, so there is no font
to be missing, and nothing a Markdown renderer strips out of an SVG. The letterforms are shared
with the boundsvg logo family rather than set in a typeface, so the projects read as related.

| File                              | Used by                     |
| --------------------------------- | --------------------------- |
| `svgent-mark.svg`                 | Studio header, favicon      |
| `svgent-wordmark.svg`             | Studio header, light theme  |
| `svgent-wordmark-dark.svg`        | Studio header, dark theme   |
| `svgent-logo-readme.png`          | `README.md`, `README.ja.md` |
| `svgent-logo-horizontal.svg`      | original, light background  |
| `svgent-logo-horizontal-dark.svg` | original, dark background   |
| `svgent-logo-stacked.svg`         | original, vertical lockup   |

## Why the README uses a PNG

A `<picture>` that swaps a light and a dark SVG is correct on GitHub's web view and unreliable
everywhere else the READMEs are read — mobile apps and in-editor Markdown previews. So the READMEs
carry one opaque raster derived from the dark original, at twice its display width, referenced by a
single `<img>`.

It is derived, not drawn. Regenerate it rather than editing it (ImageMagick 7 —
the `magick` entry point):

```bash
magick -background '#071426' apps/studio/public/brand/svgent-logo-horizontal-dark.svg \
  -filter Lanczos -resize 960x -alpha remove -alpha off -colorspace sRGB -strip \
  PNG24:apps/studio/public/brand/svgent-logo-readme.png
```

Every flag earns its place, so do not trim them: `-alpha remove -alpha off` and `PNG24:` are what
make the file opaque RGB rather than RGBA, which is the part Markdown previews need; `-strip`
removes the metadata that would otherwise make two runs differ. 960 is the 480 the READMEs display
it at, doubled.

The result is byte-identical on a rerun, so a diff here means the original changed. Verified: this
command reproduces the committed file exactly.

`svgent-wordmark-dark.svg` is the light one with a single fill changed — `#3D4663` becomes
`#E9EDF7` so the ink survives a dark background. Every `d` is byte-identical between the two, which
is the rule this family is built on: glyphs are shared verbatim, and only position and colour move.
