/**
 * The WebMCP tool layer: every operation the studio already supports for a
 * person, described once for an agent. Tools read and write the mounted
 * studio through its `StudioHandle`, so the preview, undo and autosave see an
 * agent's edit exactly as they see a person's.
 *
 * Results carry the same JSON twice: as top-level fields, for a client that
 * takes a plain object, and as a text part for one that reads MCP-style
 * content. A frame snapshot adds an image part.
 */

import {
  applyScenePatch,
  fitSceneDuration,
  type PatchChange,
  parseScenePatchOperations,
  reviewSceneAnimation,
} from "@svgent/authoring";
import {
  buildScriptPrompt,
  buildTimeline,
  deserializeProject,
  draftTimelineIssues,
  paginateMessages,
  type SessionMessage,
  type SvgentProject,
  serializeProject,
} from "@svgent/scene";
import type { StudioExportResult, StudioHandle } from "@svgent/studio";
import {
  applyCameraDirection,
  applySceneDirection,
  CAMERA_STYLES,
  type CameraDirection,
  DIRECTION_CHOICES,
  FLOWS,
  type SceneDirection,
  SURFACES,
} from "./direction.js";
import { mintId } from "./ids.js";
import {
  PRIVACY_DEFAULT,
  type PrivacyMode,
  sanitizeIncomingScript,
  scanForSensitive,
} from "./privacy.js";
import type { WebMcpTool, WebMcpToolResult } from "./webmcp.js";

const EXPORT_KINDS = [
  "poster-svg",
  "animated-svg",
  "poster-png",
  "poster-webp",
  "animated-webp",
  "gif",
  "mp4",
  "transcript-svg",
  "transcript-png",
] as const satisfies readonly StudioExportResult["kind"][];

export type ExportKind = (typeof EXPORT_KINDS)[number];

/** A change the agent asked for that only the person may confirm. */
export type PendingRequest =
  | {
      kind: "proposal";
      handle: string;
      note: string;
      changes: PatchChange[];
      affectedMessageIds: string[];
      after: SvgentProject;
    }
  | {
      kind: "export";
      handle: string;
      exportKind: ExportKind;
      allPages: boolean;
    };

export type Decision = "approved" | "rejected";

export type ActivityEntry = {
  id: string;
  at: number;
  /** "agent" for a tool call, "you" for something the person did on the page. */
  actor: "agent" | "you";
  tool: string;
  summary: string;
  ok: boolean;
  affectedMessageIds?: string[];
  /** A frame the agent looked at, as a data URL, kept so the person can see it too. */
  frame?: string;
};

type ToolHost = {
  studio: () => StudioHandle | null;
  /** The page's current privacy setting, chosen by the person. */
  privacy: () => PrivacyMode;
  /** Show a request to the person and resolve with what they decide. */
  askPerson: (request: PendingRequest) => Promise<Decision>;
  /** Remember the script before an agent edit so the person can undo it. */
  rememberBefore: (project: SvgentProject) => void;
  /** One line in the activity strip. */
  record: (entry: Omit<ActivityEntry, "id" | "at" | "actor">) => void;
};

const SNAPSHOT_SCALE = 0.5;
const SNAPSHOT_MAX_BYTES = 900_000;

/**
 * One result, readable two ways: the fields at the top level for a client
 * that takes a plain object, and a `content` array for one that reads
 * MCP-style parts.
 */
function result(
  value: Record<string, unknown>,
  extra: WebMcpToolResult["content"] = [],
): WebMcpToolResult {
  return {
    ...value,
    content: [{ type: "text", text: JSON.stringify(value) }, ...extra],
  };
}

function mintHandle(prefix: string): string {
  return mintId(prefix);
}

function requireStudio(host: ToolHost): StudioHandle {
  const studio = host.studio();
  if (studio === null) {
    throw new Error("The studio is still mounting; try again in a moment.");
  }
  return studio;
}

function seconds(ms: number): number {
  return Math.round(ms / 100) / 10;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** The script without the parts an agent cannot use: attached image bytes. */
function scriptForAgent(project: SvgentProject): unknown {
  const serialized = JSON.parse(serializeProject(project)) as {
    messages?: Array<Record<string, unknown>>;
  };
  return {
    ...serialized,
    messages: (serialized.messages ?? []).map((message) => {
      const { images, ...rest } = message;
      return Array.isArray(images) && images.length > 0
        ? { ...rest, imageCount: images.length }
        : rest;
    }),
  };
}

function outline(project: SvgentProject) {
  return project.messages.map((message) => ({
    id: message.id,
    role: message.role,
    characters: Array.from(message.content).length,
    hasLocalTiming: message.timing !== undefined,
    pageBreakBefore: message.pageBreakBefore === true,
    ...(message.decision ? { decision: message.decision } : {}),
    ...(message.options ? { options: message.options.length } : {}),
    ...(message.inputMode ? { inputMode: message.inputMode } : {}),
    ...(message.highlight ? { highlight: true } : {}),
  }));
}

function stagingFacts(project: SvgentProject) {
  return {
    surface: project.surface,
    canvas: { width: project.appearance.canvasWidth, height: project.appearance.canvasHeight },
    theme: project.appearance.theme,
    backdrop: project.appearance.backdrop,
    fontScale: project.appearance.fontScale,
    flow: project.pagination.flow,
    messagesPerPage: project.pagination.messagesPerPage,
    camera: project.camera,
    timing: project.timing,
  };
}

function timelineFacts(project: SvgentProject) {
  const pages = paginateMessages(project).map((messages, pageIndex) => {
    const timeline = buildTimeline(project, messages);
    return {
      pageIndex,
      durationSeconds: seconds(timeline.durationMs),
      messages: timeline.messages.map((timing) => ({
        id: timing.message.id,
        role: timing.message.role,
        startsAtSeconds: seconds(timing.startMs),
        revealedBySeconds: seconds(timing.revealEndMs),
        settledBySeconds: seconds(timing.settledMs),
      })),
    };
  });
  const review = reviewSceneAnimation(project);
  return {
    totalSeconds: seconds(pages.reduce((sum, page) => sum + page.durationSeconds * 1000, 0)),
    pages,
    review: { score: review.score, issues: review.issues },
    draftIssues: draftTimelineIssues(project),
    staging: stagingFacts(project),
  };
}

function summarizeChanges(changes: readonly PatchChange[]): string {
  if (changes.length === 0) {
    return "no changes";
  }
  const shown = changes
    .slice(0, 3)
    .map((entry) => `${entry.path}: ${String(entry.before)} → ${String(entry.after)}`);
  return changes.length > 3 ? `${shown.join("; ")}; +${changes.length - 3} more` : shown.join("; ");
}

const PATCH_OPERATION_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 24,
  description:
    'Operations from the studio\'s patch vocabulary. Each is one of: {"op":"set-message-timing","messageId":string,"changes":{"durationMs"?:number|null,"pauseBeforeMs"?:number|null,"transitionMs"?:number|null}} · {"op":"set-message-content","messageId":string,"content":string} · {"op":"set-message-page-break","messageId":string,"value":boolean} · {"op":"set-project-timing","changes":{"userTypingCps"?,"agentTypingCps"?,"thinkingMs"?,"toolRunMs"?,"imageGenMs"?,"permissionMs"?,"transitionMs"?,"finalHoldMs"?}} · {"op":"set-appearance","changes":{"theme"?,"canvasWidth"?,"canvasHeight"?,"transparentCanvas"?,"background"?,"accent"?,"userBubbleColor"?,"backdrop"?,"fontScale"?,"chromeScale"?,"spacingScale"?,"contentAlign"?,"messageAlign"?,"assistantSurface"?}}. Call list_presets for the allowed enum values and ranges.',
  items: { type: "object" },
} as const;

const STAGING_GUIDE = `How a script is staged (all of this is yours to direct):
- Surfaces: "app" is a GUI chat window with bubbles, cards, a composer and image tiles; "tui" is a terminal with a prompt box, spinners and exit codes. The same script plays on both.
- Per-message extras give the scene its beats: a "choice" with options and chosenIndex (or freeform), a "permission" with decision "deny" followed by one that is allowed, a "thinking" with highlight:true (app only) that holds its note for a beat, a user line with inputMode "voice" (app shows a microphone capture), an "image" step that shows a generating skeleton before the placeholder lands.
- Inline markup in a user line: [[表記|よみ]] stages Japanese IME conversion (reading typed, then converted); {{finished|typed}} stages a completion where the typed prefix is keyed and the rest lands on one key.
- Camera: direct_camera turns on a deterministic follow camera that leans in on the active message, the typed draft and the option menu; "anticipate" arrives before the event, "sync" with it, "trail" after it.
- Pages: flow "slides" cuts the script into pages of messagesPerPage messages, each exported as its own image; "scroll" keeps one scrolling window.
- Sizes: 16:9 for video and slides, OGP 1200x630 for link cards, 3:1 banners, 1:1 for social feeds.
- Display presets hide chrome or scale text for the destination (headline, conversation-only, frame-only, compact, large-text, huge-text, one-exchange).
- Pacing presets: standard, tight (social clips), calm (talks and embeds). fit_duration then lands an exact length.
Typical direction: list_presets → load_script → direct_scene / direct_camera → inspect_timeline or snapshot_frame → fit_duration → export.`;

export function createStudioTools(host: ToolHost): WebMcpTool[] {
  const listPresets: WebMcpTool = {
    name: "list_presets",
    description:
      "Read this before writing or directing a script: the privacy default you write under, the rules a script must follow (roles, per-message extras, inline markup, character set, limits), how staging works (surfaces, camera, pages, sizes, display and pacing presets), and every preset id the studio accepts. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => {
      host.record({ tool: "list_presets", summary: "read the authoring guide", ok: true });
      return result({
        privacy: { rule: PRIVACY_DEFAULT, mode: host.privacy() },
        scriptRules: buildScriptPrompt("", "en"),
        stagingGuide: STAGING_GUIDE,
        presets: DIRECTION_CHOICES,
        timingRanges: {
          userTypingCps: [6, 60],
          agentTypingCps: [8, 300],
          thinkingMs: [400, 8000],
          toolRunMs: [300, 6000],
          imageGenMs: [800, 20000],
          permissionMs: [500, 6000],
          transitionMs: [0, 2000],
          finalHoldMs: [500, 6000],
        },
        appearanceRanges: {
          canvasWidth: [640, 2560],
          canvasHeight: [480, 2560],
          fontScale: [0.8, 5],
          chromeScale: [0.8, 3],
          spacingScale: [0.6, 1.6],
        },
      });
    },
  };

  const getScript: WebMcpTool = {
    name: "get_script",
    description:
      "Read the script the studio holds right now — including any edits the person made on the page since your last call — as JSON, with an outline (message ids, roles, lengths, extras) and how it is staged (surface, size, theme, camera, pages). Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const project = requireStudio(host).getProject();
      host.record({ tool: "get_script", summary: `read "${project.title}"`, ok: true });
      return result({
        title: project.title,
        privacyMode: host.privacy(),
        sensitiveHints: scanForSensitive(project),
        staging: stagingFacts(project),
        outline: outline(project),
        script: scriptForAgent(project),
      });
    },
  };

  const inspectTimeline: WebMcpTool = {
    name: "inspect_timeline",
    description:
      "Measure the current script the way the renderer will play it: per-page duration in seconds, when each message starts, is fully revealed and settles, the animation review (score and issues with suggestions), and composer issues. Use it to check a target length or to find what to shorten. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const project = requireStudio(host).getProject();
      const facts = timelineFacts(project);
      host.record({
        tool: "inspect_timeline",
        summary: `${facts.pages.length} page(s), ${facts.totalSeconds}s, review score ${facts.review.score}`,
        ok: true,
      });
      return result(facts);
    },
  };

  const snapshotFrame: WebMcpTool = {
    name: "snapshot_frame",
    description:
      "Look at the stage: render the frame at a given second (default: the end of the page) as a PNG and return it as an image, with the page length. Use it to check how a message wraps, whether the camera framed the right thing, or how a theme reads before exporting. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          minimum: 0,
          description: "Moment to render; default is the page's end.",
        },
        pageIndex: {
          type: "integer",
          minimum: 0,
          description: "Default: the page being previewed.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (args) => {
      const studio = requireStudio(host);
      const at =
        typeof args.seconds === "number"
          ? Math.round(args.seconds * 1000)
          : Number.POSITIVE_INFINITY;
      const frame = await studio.renderFrame({
        timeMs: at,
        page: typeof args.pageIndex === "number" ? args.pageIndex : undefined,
        scale: SNAPSHOT_SCALE,
      });
      if (frame.bytes.byteLength > SNAPSHOT_MAX_BYTES) {
        throw new Error("The frame is too large to return; try a smaller canvas size.");
      }
      const data = bytesToBase64(frame.bytes);
      const facts = {
        pageIndex: frame.page,
        seconds: seconds(frame.timeMs),
        pageSeconds: seconds(frame.durationMs),
        width: frame.width,
        height: frame.height,
      };
      host.record({
        tool: "snapshot_frame",
        summary: `looked at page ${frame.page + 1} at ${facts.seconds}s`,
        ok: true,
        frame: `data:image/png;base64,${data}`,
      });
      studio.seek(frame.timeMs, { page: frame.page });
      return result(facts, [{ type: "image", data, mimeType: "image/png" }]);
    },
  };

  const loadScript: WebMcpTool = {
    name: "load_script",
    description: `Replace the whole script with one you wrote, following the rules from list_presets. ${PRIVACY_DEFAULT} Pass the script as a JSON object (or a JSON string) with only the fields that render: title, surface, modelLabel, workspaceLabel, branchLabel and messages (role, content, language, decision, options, chosenIndex, freeform, afterSelection, inputMode, highlight, pageBreakBefore). Any other field is dropped and named in the result; appearance, fonts, images, camera and ids are directed through their own tools and are not read from a script. The studio validates it, previews it immediately, and returns warnings and sensitiveHints (credential-, address-, path- or internal-URL-like text) for the person to see too. Keeps the person's current look and pacing unless keepStyle is false. The previous script stays one undo away.`,
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        script: {
          description:
            'The script: {"version":1,"title":string,"surface":"app"|"tui","modelLabel":string,"workspaceLabel":string,"branchLabel":string,"messages":[{"role":...,"content":...}, ...]}',
          type: "object",
        },
        keepStyle: {
          type: "boolean",
          description: "Keep the current appearance, display, fonts and chrome (default true).",
        },
        basis: {
          type: "string",
          enum: ["fictional", "reenactment"],
          description:
            'Default "fictional". Pass "reenactment" only when the person explicitly said this re-enacts a session of their own; never declare it for them.',
        },
      },
      required: ["script"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const raw = typeof args.script === "string" ? JSON.parse(args.script) : args.script;
      const { script, dropped } = sanitizeIncomingScript(raw);
      if (args.basis === "reenactment") {
        script.basis = "reenactment";
      }
      const imported = deserializeProject(JSON.stringify(script), "en");
      const current = studio.getProject();
      // The look, the pacing, the fonts and the chrome always stay the
      // person's when keepStyle is on; with it off only the studio defaults
      // come in, since the script itself can no longer carry any of them.
      const keepStyle = args.keepStyle !== false;
      const next: SvgentProject = keepStyle
        ? {
            ...imported.project,
            appearance: current.appearance,
            display: current.display,
            fonts: current.fonts,
            chrome: current.chrome,
            camera: current.camera,
            timing: current.timing,
          }
        : { ...imported.project, fonts: current.fonts };
      host.rememberBefore(current);
      studio.replaceProject(next);
      studio.play({ restart: true });
      const sensitiveHints = scanForSensitive(next);
      const droppedNote = dropped.length > 0 ? `; dropped ${dropped.join(", ")}` : "";
      host.record({
        tool: "load_script",
        summary: `loaded "${next.title}" (${next.messages.length} messages, ${next.surface}${droppedNote})`,
        ok: true,
        affectedMessageIds: next.messages.map((message) => message.id),
      });
      return result({
        title: next.title,
        privacyMode: host.privacy(),
        warnings: [
          ...imported.warnings,
          ...dropped.map((field) => `Dropped "${field}": scripts carry only what renders.`),
        ],
        sensitiveHints,
        outline: outline(next),
        timeline: timelineFacts(next),
      });
    },
  };

  const directScene: WebMcpTool = {
    name: "direct_scene",
    description:
      "Stage the current script: switch the surface (app chat window or terminal), pick a canvas size preset, a display preset (what chrome shows, how big the text is), a pacing preset, a theme and backdrop, or cut it into slides. Any subset of fields; applied right away with undo. Returns what changed and the resulting timeline.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        surface: { type: "string", enum: [...SURFACES] },
        sizePreset: { type: "string", enum: DIRECTION_CHOICES.sizes.map((size) => size.id) },
        displayPreset: { type: "string", enum: DIRECTION_CHOICES.displayPresets.map((p) => p.id) },
        pacingPreset: { type: "string", enum: DIRECTION_CHOICES.pacing.map((p) => p.id) },
        theme: { type: "string", enum: DIRECTION_CHOICES.themes.map((theme) => theme.id) },
        backdrop: { type: "string", enum: DIRECTION_CHOICES.backdrops.map((b) => b.id) },
        fontScale: { type: "number", minimum: 0.8, maximum: 5 },
        transparentCanvas: { type: "boolean" },
        flow: { type: "string", enum: [...FLOWS] },
        messagesPerPage: { type: "integer", minimum: 1, maximum: 12 },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const current = studio.getProject();
      const directed = applySceneDirection(current, args as SceneDirection);
      host.rememberBefore(current);
      studio.applyPatch(() => directed.project);
      studio.play({ restart: true });
      host.record({ tool: "direct_scene", summary: summarizeChanges(directed.changes), ok: true });
      return result({ changes: directed.changes, timeline: timelineFacts(directed.project) });
    },
  };

  const directCamera: WebMcpTool = {
    name: "direct_camera",
    description:
      'Direct the follow camera: on or off, how far it leans in (zoom 1.2–2.5), and its style — "anticipate" arrives before each event like a staged lecture, "sync" with it, "trail" after it like a live recording. It aims itself at the active message, the typed draft and the option menu, so the moves stay in step with the timeline in every export. Applied right away with undo.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        follow: { type: "boolean" },
        zoom: { type: "number", minimum: 1.2, maximum: 2.5 },
        style: { type: "string", enum: [...CAMERA_STYLES] },
        suppressBriefMoves: {
          type: "boolean",
          description: "Skip shots the camera could not hold long enough to read.",
        },
      },
      required: ["follow"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const current = studio.getProject();
      const directed = applyCameraDirection(current, args as CameraDirection);
      host.rememberBefore(current);
      studio.applyPatch(() => directed.project);
      studio.play({ restart: true });
      host.record({ tool: "direct_camera", summary: summarizeChanges(directed.changes), ok: true });
      return result({ changes: directed.changes, camera: directed.project.camera });
    },
  };

  const editMessage: WebMcpTool = {
    name: "edit_message",
    description:
      "Change how one message plays without rewriting its text: a permission's decision (allow, allow-always, deny), a choice's options / chosenIndex / freeform answer, whether a menu stays on screen after the pick, a user line's inputMode (voice), a thinking line's highlight, a tool line's language, or a page break before it. Applied right away with undo. For the text itself use propose_patch.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        decision: { type: "string", enum: ["allow", "allow-always", "deny"] },
        options: {
          type: "array",
          items: { type: "string" },
          maxItems: 5,
          description: 'Each "label — hint".',
        },
        chosenIndex: { type: "integer", minimum: 0 },
        freeform: { type: "string" },
        afterSelection: { type: "string", enum: ["collapse", "keep"] },
        inputMode: { type: "string", enum: ["voice", "typed"] },
        highlight: { type: "boolean" },
        language: { type: "string" },
        pageBreakBefore: { type: "boolean" },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const current = studio.getProject();
      const messageId = String(args.messageId);
      const index = current.messages.findIndex((message) => message.id === messageId);
      if (index === -1) {
        throw new Error(`No message ${messageId}; call get_script for the ids.`);
      }
      const before = current.messages[index] as SessionMessage;
      const next: SessionMessage = { ...before };
      const changes: PatchChange[] = [];
      const set = <K extends keyof SessionMessage>(
        key: K,
        value: SessionMessage[K] | undefined,
      ) => {
        if (value === undefined || JSON.stringify(before[key]) === JSON.stringify(value)) {
          return;
        }
        changes.push({
          path: `messages.${messageId}.${key}`,
          before:
            typeof before[key] === "object"
              ? JSON.stringify(before[key])
              : ((before[key] as string | number | boolean | undefined) ?? null),
          after:
            typeof value === "object"
              ? JSON.stringify(value)
              : (value as string | number | boolean),
        });
        if (value === null) {
          delete next[key];
        } else {
          next[key] = value;
        }
      };
      if (args.decision !== undefined) {
        set("decision", args.decision as SessionMessage["decision"]);
      }
      if (Array.isArray(args.options)) {
        set("options", args.options.map(String));
      }
      if (typeof args.chosenIndex === "number") {
        set("chosenIndex", args.chosenIndex);
      }
      if (typeof args.freeform === "string") {
        set("freeform", args.freeform);
      }
      if (args.afterSelection !== undefined) {
        set("afterSelection", args.afterSelection as SessionMessage["afterSelection"]);
      }
      if (args.inputMode === "voice") {
        set("inputMode", "voice");
      } else if (args.inputMode === "typed" && before.inputMode !== undefined) {
        changes.push({ path: `messages.${messageId}.inputMode`, before: "voice", after: null });
        delete next.inputMode;
      }
      if (typeof args.highlight === "boolean") {
        set("highlight", args.highlight);
      }
      if (typeof args.language === "string") {
        set("language", args.language);
      }
      if (typeof args.pageBreakBefore === "boolean") {
        set("pageBreakBefore", args.pageBreakBefore);
      }
      if (changes.length === 0) {
        throw new Error("Nothing would change.");
      }
      const messages = current.messages.map((message, at) => (at === index ? next : message));
      const project: SvgentProject = { ...current, messages };
      host.rememberBefore(current);
      studio.applyPatch(() => project);
      host.record({
        tool: "edit_message",
        summary: summarizeChanges(changes),
        ok: true,
        affectedMessageIds: [messageId],
      });
      return result({
        changes,
        sensitiveHints: scanForSensitive(project),
        timeline: timelineFacts(project),
      });
    },
  };

  const applyPatch: WebMcpTool = {
    name: "apply_patch",
    description:
      "Apply fine-grained timing, page-break or appearance changes to the current script right away — per-message durations and pauses, project timing, colors, scales. The preview updates and the change is listed in the activity strip with an undo. Message text cannot be rewritten here — use propose_patch for set-message-content, which the person confirms.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { operations: PATCH_OPERATION_SCHEMA },
      required: ["operations"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const operations = parseScenePatchOperations(args.operations);
      if (operations.some((operation) => operation.op === "set-message-content")) {
        throw new Error(
          "set-message-content rewrites what a message says; send it through propose_patch so the person can confirm it.",
        );
      }
      const current = studio.getProject();
      const applied = applyScenePatch(current, operations);
      host.rememberBefore(current);
      studio.applyPatch(() => applied.project);
      host.record({
        tool: "apply_patch",
        summary: summarizeChanges(applied.changes),
        ok: true,
        affectedMessageIds: applied.affectedMessageIds,
      });
      return result({
        changes: applied.changes,
        affectedMessageIds: applied.affectedMessageIds,
        timeline: timelineFacts(applied.project),
      });
    },
  };

  const proposePatch: WebMcpTool = {
    name: "propose_patch",
    description: `Propose changes the person must confirm — rewriting message text, or any batch you want reviewed before it lands. ${PRIVACY_DEFAULT} The proposal appears as a card with the new text; nothing changes until they approve. Returns a proposalHandle and sensitiveHints for the text as it would read. The person may approve or reject on the page at any time; call approve_proposal to ask them explicitly and wait for their answer.`,
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        operations: PATCH_OPERATION_SCHEMA,
        note: {
          type: "string",
          description: "One sentence for the person: what this changes and why.",
        },
      },
      required: ["operations"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const operations = parseScenePatchOperations(args.operations);
      const current = studio.getProject();
      const applied = applyScenePatch(current, operations);
      if (applied.changes.length === 0) {
        throw new Error("Nothing would change: the script already reads that way.");
      }
      const handle = mintHandle("proposal");
      const note = typeof args.note === "string" ? args.note : "";
      host.record({
        tool: "propose_patch",
        summary: `proposed ${applied.changes.length} change(s): ${note || summarizeChanges(applied.changes)}`,
        ok: true,
        affectedMessageIds: applied.affectedMessageIds,
      });
      // Shown now; the decision arrives through approve_proposal or the card
      // itself. Not awaited here so the agent can keep working.
      void host.askPerson({
        kind: "proposal",
        handle,
        note,
        changes: applied.changes,
        affectedMessageIds: applied.affectedMessageIds,
        after: applied.project,
      });
      return result({
        proposalHandle: handle,
        status: "pending",
        changes: applied.changes,
        affectedMessageIds: applied.affectedMessageIds,
        sensitiveHints: scanForSensitive(applied.project),
      });
    },
  };

  const fitDuration: WebMcpTool = {
    name: "fit_duration",
    description:
      "Fit one page of the script to a target length in seconds by adjusting per-message timing, without touching the text. Returns what it changed and the before/after length; `constrained` means the limits stopped it short of the target. Applied right away, with undo.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        targetSeconds: { type: "number", minimum: 3, maximum: 120 },
        pageIndex: { type: "integer", minimum: 0, description: "Default 0." },
        preserveMessageIds: {
          type: "array",
          items: { type: "string" },
          description: "Messages whose timing must stay as authored.",
        },
      },
      required: ["targetSeconds"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const current = studio.getProject();
      const targetSeconds = Number(args.targetSeconds);
      const pageIndex = typeof args.pageIndex === "number" ? args.pageIndex : 0;
      const preserveMessageIds = Array.isArray(args.preserveMessageIds)
        ? args.preserveMessageIds.filter((id): id is string => typeof id === "string")
        : undefined;
      const fit = fitSceneDuration(current, {
        pageIndex,
        targetMs: Math.round(targetSeconds * 1000),
        preserveMessageIds,
      });
      const applied = applyScenePatch(current, fit.operations);
      host.rememberBefore(current);
      studio.applyPatch(() => applied.project);
      studio.play({ restart: true });
      host.record({
        tool: "fit_duration",
        summary: `page ${pageIndex + 1}: ${seconds(fit.beforeMs)}s → ${seconds(fit.afterMs)}s (target ${targetSeconds}s${fit.constrained ? ", constrained" : ""})`,
        ok: true,
        affectedMessageIds: applied.affectedMessageIds,
      });
      return result({
        pageIndex,
        targetSeconds,
        beforeSeconds: seconds(fit.beforeMs),
        afterSeconds: seconds(fit.afterMs),
        constrained: fit.constrained,
        changes: applied.changes,
      });
    },
  };

  const preview: WebMcpTool = {
    name: "preview",
    description:
      "Drive the preview the person is looking at: play from the start, resume, or pause at a moment (seconds, optionally on a given page) so you can point at what you mean.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["restart", "play", "seek"] },
        seconds: { type: "number", minimum: 0, description: "For seek." },
        pageIndex: { type: "integer", minimum: 0, description: "For seek; default current page." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const action = args.action;
      if (action === "seek") {
        const at = Number(args.seconds ?? 0);
        studio.seek(Math.round(at * 1000), {
          page: typeof args.pageIndex === "number" ? args.pageIndex : undefined,
        });
        host.record({ tool: "preview", summary: `paused at ${at}s`, ok: true });
        return result({ paused: true, seconds: at });
      }
      studio.play({ restart: action === "restart" });
      host.record({
        tool: "preview",
        summary: action === "restart" ? "restarted" : "playing",
        ok: true,
      });
      return result({ playing: true });
    },
  };

  const exportTool: WebMcpTool = {
    name: "export",
    description:
      "Ask the person to export the script as an artifact and download it: a poster (SVG/PNG/WebP), an animation (animated SVG with CSS keyframes and no JavaScript, animated WebP, GIF, MP4), or a full transcript. The person confirms on the page; resolves with the files once written, or with their refusal.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...EXPORT_KINDS] },
        allPages: {
          type: "boolean",
          description: "For scripts split into pages: every page (default) or the previewed one.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const studio = requireStudio(host);
      const kind = args.kind;
      if (typeof kind !== "string" || !(EXPORT_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`kind must be one of ${EXPORT_KINDS.join(", ")}`);
      }
      const exportKind = kind as ExportKind;
      const allPages = args.allPages !== false;
      host.record({ tool: "export", summary: `asked to export ${exportKind}`, ok: true });
      const decision = await host.askPerson({
        kind: "export",
        handle: mintHandle("export"),
        exportKind,
        allPages,
      });
      if (decision !== "approved") {
        host.record({ tool: "export", summary: `${exportKind} declined by you`, ok: false });
        return result({ status: "rejected", kind: exportKind });
      }
      const results = await studio.exportArtifact(exportKind, { allPages });
      host.record({
        tool: "export",
        summary: `${exportKind}: ${results.map((entry) => entry.fileName).join(", ") || "nothing written"}`,
        ok: results.length > 0,
      });
      return result({
        status: "exported",
        files: results.map((entry) => ({
          fileName: entry.fileName,
          kind: entry.kind,
          bytes: entry.blob.size,
        })),
      });
    },
  };

  return [
    listPresets,
    getScript,
    inspectTimeline,
    snapshotFrame,
    loadScript,
    directScene,
    directCamera,
    editMessage,
    applyPatch,
    proposePatch,
    fitDuration,
    preview,
    exportTool,
  ];
}

/**
 * Registered only while a proposal is pending, so an agent that lists the
 * page's tools sees whether there is anything to confirm.
 */
export function createApproveProposalTool(options: {
  handle: string;
  waitForDecision: () => Promise<Decision>;
  record: ToolHost["record"];
}): WebMcpTool {
  return {
    name: "approve_proposal",
    description: `Ask the person to decide on the pending proposal ${options.handle} now, and wait for their answer. The decision is theirs: this tool cannot approve on their behalf.`,
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: { proposalHandle: { type: "string" } },
      required: ["proposalHandle"],
      additionalProperties: false,
    },
    execute: async (args) => {
      if (args.proposalHandle !== options.handle) {
        throw new Error(
          `No pending proposal ${String(args.proposalHandle)}; the pending one is ${options.handle}.`,
        );
      }
      options.record({ tool: "approve_proposal", summary: "asked for a decision", ok: true });
      const decision = await options.waitForDecision();
      return result({ proposalHandle: options.handle, decision });
    },
  };
}
