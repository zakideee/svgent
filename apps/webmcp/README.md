# svgent Agent Stage (`apps/webmcp`)

The svgent studio with WebMCP site tools on it: the agent in your browser writes and directs a fictional coding-agent session, you approve what matters, and the studio renders it.

Live: https://agent.svgent.zakideee.dev/

## Try it

Open the page in ChatGPT's desktop app (built-in browser, GPT-5.6 Sol or Terra, site tools enabled) or in Chromium with WebMCP enabled. The rail on the right reports **Site tools registered**. Then ask, for example:

> Using this page's site tools, write and load a short script where a user asks "What is WebMCP?" and the agent explains it in Markdown. Under 25 seconds, camera on.

The **Agent** tab lists prompts to try and everything the agent does; **Scripts** loads a showcase; **Words** shows the privacy setting and every word the stage can show.

## Tools

| Tool               | Does                                                                                  | Read-only |
| ------------------ | ------------------------------------------------------------------------------------- | --------- |
| `list_presets`     | The authoring guide, the staging guide, every preset id, the privacy rule             | yes       |
| `get_script`       | The script as the studio holds it, with an outline and how it is staged               | yes       |
| `inspect_timeline` | Per-page length, when each message starts/settles, the animation review               | yes       |
| `snapshot_frame`   | A PNG of the stage at a given second, returned as an image                            | yes       |
| `load_script`      | Replace the script; only rendering fields are accepted, the rest is dropped and named |           |
| `direct_scene`     | Surface, size, display and pacing presets, theme, backdrop, slides                    |           |
| `direct_camera`    | Follow camera on/off, zoom, style                                                     |           |
| `edit_message`     | Decision, options, voice input, highlight, language, page break                       |           |
| `apply_patch`      | Timing and appearance patches, applied at once with undo                              |           |
| `propose_patch`    | Rewrites, shown on a card the person approves                                         |           |
| `approve_proposal` | Registered only while a proposal is pending; waits for the person                     |           |
| `fit_duration`     | Land a page on a target length                                                        |           |
| `preview`          | Play, restart, seek                                                                   |           |
| `export`           | Poster, animation or transcript, after the person confirms                            |           |

Results are plain objects with an MCP-style `content` array. Registration prefers `document.modelContext` (ChatGPT, Codex) and falls back to `navigator.modelContext` (Chromium).

## What the agent may write

Unless the person says otherwise, the agent treats what it knows from the conversation as private: real names become stand-ins of the same shape; credentials never pass. The person relaxes this on the page (**As told**) or in the chat. A loaded script keeps only the fields that render.

## Layout

```
apps/webmcp/src
  App.tsx        the page: studio + agent rail
  tools.ts       the WebMCP tools
  direction.ts   scene and camera direction shared by tools and chips
  privacy.ts     the privacy default, the script allowlist, every word, sensitive hints
  showcase.ts    the showcase scripts
  ids.ts, dev-shim.ts, webmcp.d.ts   small helpers and the WebMCP typings
  scripts/       the seven showcase scripts, with their provenance in scripts/README.md
```

The studio itself is `@svgent/studio`; this app mounts it with the full chrome by default, `?chrome=stage` shows the stage alone, and the rail's toggle rewrites that query. The tools drive it through its `StudioHandle`.

## Develop

```
pnpm install
pnpm build:packages
pnpm --filter @svgent/webmcp-app dev      # http://localhost:5180/
pnpm --filter @svgent/webmcp-app build
pnpm --filter @svgent/webmcp-app deploy   # Cloudflare Workers, agent.svgent.zakideee.dev
```

Without WebMCP in the browser, development installs a console shim: `navigator.modelContext.executeTool("get_script", {})`.
