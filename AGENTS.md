# AGENTS.md — svgent

svgent is a client-only Studio plus a local-only CLI that renders authored, fictional
coding-agent sessions to SVG, PNG, WebP, GIF, and MP4. It never connects authored scenes to a model
API, shell, repository, or live session.

## Documentation

- `README.md` — English product documentation
- `README.ja.md` — Japanese product documentation
- `RESPONSIBLE-USE.md` — English privacy, labeling, and publishing guidance
- `RESPONSIBLE-USE.ja.md` — Japanese privacy, labeling, and publishing guidance
- `packages/studio/assets/presets/README.md` — provenance and refresh instructions for generated sample images
- `apps/webmcp/README.md` — the Agent Stage: WebMCP tools, privacy default, showcase scripts
- `apps/webmcp/scripts/README.md` — provenance of the showcase scripts
- `apps/studio/brand-assets.md` and `apps/studio/og-src/README.md` — brand and social-card assets

## Build & Test

```bash
pnpm install                     # install dependencies and prek Git hooks
pnpm dev                         # Studio UI (Vite)
pnpm render <script.json>        # headless artifact rendering
pnpm build                       # workspace packages + both deployed apps
pnpm check                       # complete build, contract, deploy, and test gate
pnpm lint:fix                    # apply Biome fixes
pnpm format                      # format supported repository files
```

Pre-commit runs Biome, Prettier, typecheck, and knip. Pre-push runs Vitest. These hooks are installed
by `pnpm install` through prek.

## Architecture

```text
Authored JSON → Validate → Timeline → Declarative boundsvg Scene → SVG → Raster / Video
```

- **One scene source**: Studio and CLI share scene construction and artifact rendering.
- **Deterministic timeline**: Static samples, animations, and frame capture use the same fixed scene.
- **Two physical surfaces**: App and TUI share content primitives but intentionally differ in typing,
  entrances, spinners, cursors, and scrolling behavior.
- **Workspace boundaries**: the deployed app, reusable Studio API, scene/render core, and CLI build
  independently while sharing one lockfile and validation gate.

## Module Boundaries

- `apps/studio/` — deployed browser shell, language URLs, branding, Vite, and Cloudflare config.
- `packages/scene/` — schema, validation, timeline, Markdown, measurement, and App/TUI scenes.
- `packages/render/` — cross-runtime scene-to-artifact rendering.
- `packages/authoring/` — patch vocabulary, draft state, duration fit, review, and publication checks.
- `packages/studio/` — public React composition surface and browser-only Studio implementation.
- `packages/cli/` — Node CLI, filesystem/font adapters, and ffmpeg MP4 encoding.
- `apps/webmcp/` — the Studio with WebMCP site tools and an agent rail, deployed on its own hostname.
- `packages/assets/` — shared bundled fonts, Node rendering runtime, generated samples, and licenses.

Package manifests and `tests/integration/import-boundaries.test.ts` enforce the dependency graph. Never import
another workspace's `src/` tree or move shared scene/render logic into a runtime adapter.

## Product Boundary (Mandatory)

- Conversations are authored scripts. Do not add live-session ingestion, background recording,
  hooks, host-chat access, repository access, shell access, or streaming model connections.
- When a user explicitly supplies session material for reconstruction, retain only the corrected
  conversational flow and high-level tool activity needed to understand it. Remove secrets,
  personal/private identifiers, internal prompts, hidden reasoning, raw file contents, command
  arguments, and incidental input/output before authoring a script.
- If safe sanitization would remove the meaning, stop and ask for a fictional replacement. Never
  infer missing private content.
- Keep `thinking` messages to short visible status copy. Do not reconstruct chain-of-thought.
- Scripts declare a `basis`: `fictional` (the default) or `reenactment` (a sanitized summary of
  session material the user explicitly supplied). svgent does not police model-name text — an
  exhaustive denylist of real products cannot be maintained — so the declared basis recorded in
  provenance, not a label list, carries the distinction. Never declare `reenactment` on the user's
  behalf.
- Every output retains `simulated=true` — the artifact is an authored rendering, never a screen
  capture — and records `model-kind` as the declared basis. Never weaken or bypass this provenance
  stamping.
- Keep svgent's own visual identity: never reproduce a real product's pixels, trade dress, or
  logos on either surface. Model-name text is the only real-product reference an
  output may contain.
- Images remain tab-local Data URLs. Do not add uploads, accounts, server storage, or external asset
  fetching.
- WebMCP (`apps/webmcp/`) runs in the one direction this boundary allows: the page exposes tools, and
  the browser's agent calls them. The page never connects to a model API and never reads the host
  chat. Scripts an agent loads stay authored and fictional, keep only the fields that render, and
  carry the same provenance as any other.

## Generating Session Artifacts

`examples/logo-motion.json` is a complete working script. `fixtures/scripts/` covers the supported
input matrix: Markdown, diffs, emoji, multilingual content, font extremes, slides, images, invalid
range clamping, and more.

```bash
pnpm render examples/logo-motion.json --out render-out \
  --formats poster-svg,poster-png --strict
```

Supported formats are `poster-svg`, `animated-svg`, `poster-png`, `poster-webp`, `animated-webp`,
`gif`, `mp4`, `transcript-svg`, and `transcript-png`. MP4 requires local ffmpeg; `FFMPEG_PATH` may
override PATH lookup. Prefer `--strict` for unattended rendering.

Use only authored fictional scripts or already-sanitized material. Never persist raw source excerpts
in scratch files, terminal output, fixtures, or generated artifacts.

A command shown in a script is a command someone retypes off the artifact, so a script never shows
one that fetches or runs code from a package registry — `npm i`, `npx`, `pnpm dlx`, `pip install`,
`cargo install`, `brew install`, `curl … | sh` — not for an invented name, which anyone can register,
and not for a real and well-known one either, because a compromised release arrives under the correct
name. The only exception is a package this project publishes. Commands that stay local (`pnpm test`,
`rg`, `git`, repository scripts) are unrestricted. URLs use the reserved example domains; no e-mail
addresses, IP addresses, or token-shaped strings.

## Verifying a Scene Change

Most scene defects are timing defects, and a timing defect is invisible in a serialized scene: the
node is present the whole time, and what is wrong is which copy paints, and when. Ask the engine
instead of reading the tree.

- `inspectScene(engine, vnode, { timeMs })` resolves the animation at an instant and returns each
  node's composed `visualBBox` plus the opacity it paints at. Use it to assert what is on screen
  (`packages/scene/tests/freeform-answer.test.ts`, `inspection-invariants.test.ts`).
- `engine.renderToLayoutTree` answers allocation questions — canvas growth, whether the tail still
  fits inside the clipped band (`layout-invariants.test.ts`, `highlight.test.ts`).
- A new assertion is only worth committing if it fails on the old behavior. Break the fix
  deliberately, watch the test go red, then restore.

What those cannot reach, and has to be looked at after the change:

- **Studio UI.** Only the stylesheet's tokens and the exported surface are checked. Field placement,
  wrapping, truncated labels, and whether a control is reachable at a narrow width need the running
  app (`pnpm dev`) — and the Studio is consumed as its built `dist`, so run
  `pnpm --filter @svgent/studio build` before looking.
- **Whether a scene reads well.** Tests pin that the answer is keyed and not pasted; they cannot say
  the pace feels right. Watch the artifact.
- **Encoder output.** Sizes and MP4 lengths are pinned against the committed artifacts by
  `tests/integration/readme-figures.test.ts`, but nothing checks that a frame decodes as intended.
- **Both copies of a mirrored sample.** Scripts exist in `examples/` and `fixtures/scripts/`, and a
  behavioral fix usually applies to both. Grep a distinctive string from the edit before finishing.

When a change alters how long a script runs, the committed artifacts and the figures quoting them
both go stale: run `pnpm exec tsx scripts/regenerate-demos.mts`, then the README figure test.

## Coding Conventions

- TypeScript strict mode; do not introduce `any`.
- Keep deterministic scene/timeline logic free of browser-only and host-dependent behavior.
- Use explicit named exports and preserve import boundaries.
- Prefer message-local timing overrides over project-wide pacing changes.
- Add a fixture when introducing a new script input pattern or rendering edge case.
- Keep UI and CLI on the same scene/artifact path; verify both when changing shared rendering.

## Style Enforcement (Automated — Reference Only)

- Run `pnpm lint:fix` and `pnpm format` only on intended files before proposing changes.
- Run `pnpm check` for the complete local gate.

## Language

English is the working language of the public record: commit messages, PR titles and bodies,
code comments, and documentation. A squash merge turns the PR body into a commit message, so
PR bodies are public history.

## Commit Conventions

Use Conventional Commits. A PR title is the intended squash-merge commit message.

```text
<type>(<scope>): <summary>
```

Types: `feat`, `fix`, `refactor`, `test`, `perf`, `docs`, `chore`, `ci`.

Scopes: `scene`, `render`, `authoring`, `studio`, `cli`, `webmcp`, `tools`, `testing`, `docs`.

Changes spanning multiple areas use comma-joined scopes, most-affected first.

## Behavioral Constraints

- Do not push directly to `main`; use a feature branch, PR, and squash merge.
- Do not run version bumps, tagging, or publication automatically.
- Update tests when modifying behavior covered by existing tests.

## Forbidden

- Connecting authored scenes to a real agent/model API or live session
- Automatic collection of session, repository, shell, file, or host-chat content
- Auto-applying redaction, publication, or content-rewrite proposals
- Removing simulated/provenance metadata, or recording a `model-kind` basis the script did not
  declare
