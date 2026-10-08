/** Authoring guidance shipped with the version of the CLI that executes it. */
import { DIRECTION_CHOICES } from "@svgent/authoring";
import { RASTER_MAX_LONG_EDGE, RASTER_MAX_PIXELS } from "@svgent/render";
import {
  DEFAULT_PROJECT,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
  MAX_PROJECT_DURATION_MS,
  MESSAGE_ROLES,
  MESSAGE_TIMING_LIMITS,
} from "@svgent/scene";
import { CliError } from "./script-file.mjs";

/** Return the requested part of the installed authoring contract. */
export function authoringGuide(topic: string): Record<string, unknown> {
  if (!["all", "schema", "presets", "workflow"].includes(topic)) {
    throw new CliError("INVALID_ARGUMENT", "--topic expects all, schema, presets, or workflow.");
  }
  const schema = {
    version: 1,
    basis:
      "fictional by default. Use reenactment only when the user explicitly declares it for safely summarized material they supplied.",
    defaults: { ...DEFAULT_PROJECT, messages: [] },
    limits: {
      messages: MAX_MESSAGES,
      messageCharacters: MAX_MESSAGE_CHARS,
      pageDurationMs: MAX_PROJECT_DURATION_MS,
      messageTiming: MESSAGE_TIMING_LIMITS,
      imageBytes: 4 * 1024 * 1024,
      imagesPerMessage: 4,
      rasterLongEdgePx: RASTER_MAX_LONG_EDGE,
      rasterPixels: RASTER_MAX_PIXELS,
    },
    roles: MESSAGE_ROLES,
    messages: {
      required: ["role", "content"],
      id: "Optional string. inspect returns deterministic import IDs for unnamed messages; edits keep them. IDs must be unique.",
      content:
        "Text. Assistant supports Markdown headings, lists, tasks, quotes, fenced code, tables, and strikethrough. Tool commands are drawn as text and are never executed.",
      optional: {
        language: "Tool code-fence language, up to 20 characters",
        pageBreakBefore: "Boolean, for slides",
        timing: MESSAGE_TIMING_LIMITS,
        decision: ["allow", "allow-always", "deny"],
        inputMode: "voice, on user messages",
        highlight: "Boolean, on thinking messages",
        options: "Choice labels, at most 5, each up to 120 characters",
        chosenIndex: "Zero-based choice index",
        freeform: "Choice reply",
        afterSelection: "keep preserves the choice after selection",
        images:
          "At most 4 local Data URLs with mediaType, width, height, alt; optional fit cover|contain, focus top|center|bottom, size small|standard|large",
      },
      draftMarkup:
        "User IME: [[written|kana reading]], each conversion run at most 28 grapheme clusters. Completion: {{finished|typed prefix}}, for commands, paths, flags, or app /commands, @files, #references. Do not put completion markup on ordinary prose.",
    },
    project:
      "Set title, surface app|tui, modelLabel, workspaceLabel, branchLabel, appearance, chrome, timing, pagination, fonts, display, and camera as needed. See defaults for field names and presets for choices. Empty workspaceLabel/branchLabel hides those labels. Camera zoom is 1.2..2.5. Canvas width is 640..2560 and height 480..2560. Font scale is 0.8..5; chrome scale 0.8..3. Pagination is scroll|slides with 1..12 messages per page and scrollDistancePx 0..2400. Images use data:image/png|jpeg|webp;base64 URLs; external asset URLs are not fetched.",
    fonts:
      "Bundled Noto Sans JP subset and JetBrains Mono. English and Japanese are covered within the bundled glyph set. validate checks structure and timing; snapshot and render also check font availability and missing glyphs. Other characters can need local --sans-font/--mono-font files. Google font fetching needs explicit --allow-font-fetch and sends the script's characters to Google Fonts. No fonts are installed automatically.",
    themeColors:
      "A JSON theme selects its style while omitted background and accent inherit the project defaults. For its palette, copy background and accent from presets.themes, or direct a change of theme. Directing the current theme preserves existing colors.",
    example: {
      version: 1,
      basis: "fictional",
      title: "Parser update",
      surface: "app",
      modelLabel: "Example model",
      workspaceLabel: "example/parser",
      branchLabel: "feat/parser",
      appearance: { canvasWidth: 960, canvasHeight: 640 },
      messages: [
        { role: "user", content: "Add a parser test." },
        { role: "thinking", content: "Checking the parser" },
        { role: "tool", content: "pnpm test", language: "shell" },
        { role: "assistant", content: "The parser test passes." },
      ],
    },
  };
  const workflow = {
    scope:
      "Complete the user's requested creation, staging, local timing edits, and exports continuously. Propose content changes outside their request instead of applying them. File generation does not authorize upload or publication.",
    sourceMaterial:
      "Default to authored fiction. Only summarize session material the user explicitly supplied; remove secrets, private identifiers, internal instructions, hidden reasoning, raw file contents, command arguments, and incidental I/O. If sanitizing removes the meaning, ask for a fictional replacement. Thinking is short visible status copy. Keep svgent's own visual identity; no real-product logos or copied screens.",
    displayedCommands:
      "Script commands stay local (pnpm test, rg, git, project scripts). Do not show package-install/download commands, except a package svgent itself publishes. URLs in scripts use reserved example domains; omit emails, IPs, and credential-shaped strings.",
    creation: [
      "Write authored JSON in the requested local directory.",
      "validate script.json --strict --json; resolve warnings explicitly.",
      "inspect script.json --json; choose reveal, settled, camera/page transition times.",
      "snapshot script.json --page 1 --time MS --output preview.png --strict --json; read the PNG with the host's image tool.",
      "render script.json --out previews --formats animated-svg,gif --strict --json; provide the user file paths for playback.",
      "Make requested corrections with direct, patch, or fit, inspect again, and refresh affected previews and final exports.",
    ],
    edits: {
      identity:
        "Use IDs and source.sha256 from inspect. --expect-source SHA256 protects the input identity even when saving separately. The default edit output is INPUT.edited.json. Existing outputs fail. --in-place requires --expect-source and fails when the source changed. Warnings stop edits; no implicit acceptance flag.",
      timing:
        "Prefer message-local timing over set-project-timing. A local edit preserves other messages and project pacing. Durations are milliseconds; inspect times are local to the 1-based page.",
      patch:
        "patch script.json --operations patch.json --expect-source SHA256 --output edited.json --json",
      operations: [
        { op: "set-message-timing", messageId: "ID_FROM_INSPECT", changes: { durationMs: 1800 } },
        {
          op: "set-message-content",
          messageId: "ID_FROM_INSPECT",
          content: "Requested replacement.",
        },
        { op: "set-message-page-break", messageId: "ID_FROM_INSPECT", value: true },
        { op: "set-project-timing", changes: { agentTypingCps: 70 } },
        { op: "set-appearance", changes: { canvasWidth: 960, theme: "paper" } },
      ],
      operationsNote:
        "The operations file is a JSON array of 1..24 operations. Include only requested operations. null on a message timing field restores inheritance. Unknown IDs and unsupported fields fail.",
      direct:
        "direct script.json --settings direction.json --expect-source SHA256 --output staged.json --json",
      direction: {
        scene: {
          surface: "tui",
          sizePreset: DIRECTION_CHOICES.sizes[0]?.id,
          displayPreset: DIRECTION_CHOICES.displayPresets[0]?.id,
          pacingPreset: DIRECTION_CHOICES.pacing[0]?.id,
          flow: "slides",
          messagesPerPage: 3,
        },
        appearance: { canvasWidth: 960, canvasHeight: 640 },
        camera: { follow: true, zoom: 1.6, style: "sync", suppressBriefMoves: true },
        display: { composer: true },
      },
      directionNote:
        "All sections and fields are optional; pass only requested changes. Presets can change several related settings: review the changes list. Camera follows both surfaces.",
      fit: "fit script.json --page 1 --target-ms 10000 --preserve ID,ID --expect-source SHA256 --output fitted.json --json. Fit edits only local timing on that page; limits or preserved messages may prevent reaching the target. FIT_CONSTRAINED returns a proposal without writing it.",
    },
    formats: [
      "poster-svg",
      "poster-png",
      "poster-webp",
      "animated-svg",
      "animated-webp",
      "gif",
      "mp4",
      "transcript-svg",
      "transcript-png",
    ],
    export: `render script.json --out exports --formats poster-png,animated-svg --strict --json. --pages all|N selects slides. --scale 0.5..4 changes raster resolution within ${RASTER_MAX_LONG_EDGE}px / ${RASTER_MAX_PIXELS} pixel ceilings. --motion-quality economy|balanced|high controls sampling; --svg-play loop|once controls SVG repetition. Transcript shows the full conversation. Existing writable regular artifacts may be replaced; read-only or linked output paths are refused. Output collisions fail; render inputs to separate directories when filenames overlap. MP4 requires local ffmpeg (FFMPEG_PATH may select it); missing ffmpeg fails, with no automatic install.`,
    preview:
      "PNG is for the agent to read; animated SVG, GIF, or WebP files are for user playback. If the host cannot read images or play a format, report that limitation. No viewer or running server is required.",
    results:
      "--json writes one result to stdout. Progress goes to stderr. ok=false has error.code and a nonzero exit. Source SHA-256 is over file bytes, not normalized JSON. Render outputs include their source identity and artifact path, format, page, dimensions in px, and duration in ms. snapshot also returns its time in ms. Static artifacts have durationMs=0.",
  };
  return {
    ...(topic === "all" || topic === "schema" ? { schema } : {}),
    ...(topic === "all" || topic === "presets" ? { presets: DIRECTION_CHOICES } : {}),
    ...(topic === "all" || topic === "workflow" ? { workflow } : {}),
  };
}
