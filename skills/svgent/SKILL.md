---
name: svgent
description: Create, stage, preview, revise, and export authored coding-agent conversations as images or animations with svgent. Use for svgent script and rendering requests; ordinary coding work or requests to record a live session are outside this skill.
---

Use svgent's local CLI to turn authored JSON into images and animations. The user can request the entire production in natural language; Studio is optional.

Use Node.js 20 or newer and keep `@svgent/cli@0.1.0` fixed for the production. Start by reading the installed version's guide:

```sh
npx --yes --package @svgent/cli@0.1.0 svgent guide --json
```

Use that same pinned prefix for later commands, or the npm-created `svgent` bin from an installation of that exact version. If the user explicitly supplies a packed candidate for evaluation before publication, install that tarball in the temporary workspace and use its bin; do not fetch an unpublished version from npm. Installation needs the network. The skill installer has its own telemetry behavior and settings; rendering with bundled or local fonts is local.

Read the guide's schema for new scripts, presets for staging, and workflow for editing and exports. Write the script in the requested local directory. Validate, inspect its IDs and page-local times, capture PNGs at relevant moments, and read them with the host's image tool. Render an animated SVG or GIF for the user's playback and provide its file path. Report image-reading or playback limitations when the host has them.

Complete requested creation, staging, local corrections, and exports continuously. Prefer message-local timing when only one beat needs changing. Use the IDs and source SHA-256 returned by `inspect` with `patch`, `direct`, or `fit`; save a new file by default. Existing-file edits require `--in-place --expect-source`. Resolve warnings explicitly and refresh the previews affected by an edit. Propose message-content changes outside the user's request; apply them only after approval. File generation does not authorize uploading or publishing.

Default to fiction. Use only safely summarized session material the user explicitly supplies, and set `reenactment` only on their explicit declaration. Keep short visible status text in thinking messages. Scripts draw command text; they do not run it. Keep the simulated provenance and svgent visual identity. Do not collect live sessions, host chat, repository or shell content for a script. MP4 needs an existing local ffmpeg; fonts and ffmpeg are not installed automatically.
