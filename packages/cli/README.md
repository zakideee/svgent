# @svgent/cli

Create, inspect, edit, and render authored coding-agent conversations locally. Requires Node.js 20 or newer.

```sh
npx --yes --package @svgent/cli@0.1.0 svgent guide --json
npx --yes --package @svgent/cli@0.1.0 svgent render script.json --out out --formats poster-png,animated-svg --strict --json
```

The versioned `guide` describes the script schema, presets, commands, limits, and production workflow. Use `validate` and `inspect` before capturing a `snapshot`. Use `direct`, `patch`, or `fit` for requested edits, then `render` for final files.

`--json` returns one result on stdout; progress goes to stderr. Failed operations return `ok: false`, an error code, and a nonzero exit. Inspection returns deterministic message IDs and the input file's SHA-256. Edits save a new file by default; in-place edits require `--expect-source` and stop when the input has changed. Warnings stop edits.

Fonts, WASM, runtime files, and licenses are included. Rendering uses bundled or explicitly supplied local fonts. A Google Fonts request requires `--allow-font-fetch` and sends the script's characters to Google Fonts. MP4 requires a local ffmpeg; `FFMPEG_PATH` can select it.

Scripts are authored data. Tool commands are drawn as text. Every artifact retains simulated provenance and the script's declared basis.

Render can replace existing writable regular artifacts. Read-only or linked output paths and input-file collisions fail. Use separate output directories when multiple input filenames overlap.

To use the skill with an agent:

```sh
npx skills add zakideee/svgent --skill svgent
```

Installation uses the network. The skill installer controls its own telemetry. The agent uses the CLI and its image-reading tools to complete requested scripts, previews, revisions, and exports.
