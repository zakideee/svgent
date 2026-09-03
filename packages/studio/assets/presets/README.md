# Generated sample images

These four WebP files were generated for svgent with OpenAI image generation in Codex. No
third-party image or style reference was used.

They are intentionally subdued so the image cards stay secondary to the surrounding session UI.
The selected outputs were resized to 768×512 and encoded with `cwebp` at quality 72. Run
`pnpm assets:sync` after replacing an asset to refresh the embedded Data URLs used by the studio
and fixtures.

Three of them are additionally embedded as Data URLs in demo scripts and fixtures, which
`pnpm assets:sync` does not own:

| Asset                           | Script                                                                                                          | Slot                       |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `vectorconf-dawn-curves.webp`   | `examples/readme-en-app-zoom.json`                                                                              | reference attached by user |
| `generic-generated-result.webp` | `examples/readme-en-app-zoom.json`                                                                              | generated result           |
| `watercolor-traveler-dusk.webp` | `examples/readme-app-image.json`, `examples/readme-en-app-image.json`, `fixtures/scripts/image-generation.json` | generated result           |

After replacing one of those assets, re-embed it in each listed script and re-render the demos
listed in both READMEs.
