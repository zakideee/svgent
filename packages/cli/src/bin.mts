#!/usr/bin/env node
/** File-based authoring and rendering commands for svgent. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  applyScenePatch,
  fitSceneDuration,
  parseScenePatchOperations,
  reviewSceneAnimation,
} from "@svgent/authoring";
import {
  assertIdentifierNamespace,
  DEFAULT_MOTION_EXPORT_QUALITY,
  type MotionExportQuality,
} from "@svgent/render";
import {
  buildTimeline,
  deserializeProject,
  paginateMessages,
  serializeProject,
} from "@svgent/scene";
import { version as cliVersion } from "../package.json";
import { directScript } from "./direction.mjs";
import { authoringGuide } from "./guide.mjs";
import { ffmpegNotFoundMessage, probeFfmpeg, resolveFfmpegCommand } from "./mp4-ffmpeg.mjs";
import {
  CLI_FORMATS,
  type CliFormat,
  type CliOptions,
  renderScriptFile,
  snapshotScriptFile,
} from "./rendering.mjs";
import {
  assertScriptWarnings,
  CliError,
  readScriptFile,
  scriptTimelineWarnings,
  writeScriptFile,
} from "./script-file.mjs";

/** File-based command names. */
const COMMANDS = [
  "guide",
  "validate",
  "inspect",
  "snapshot",
  "direct",
  "patch",
  "fit",
  "render",
] as const;
type Command = (typeof COMMANDS)[number];
/** Shared machine-output and validation options. */
const COMMON_OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  lang: { type: "string", default: "en" },
  strict: { type: "boolean" },
} as const;
/** Controls that apply only to rendered artifacts. */
const RENDER_OPTIONS = {
  out: { type: "string", short: "o", default: "render-out" },
  formats: { type: "string", short: "f", default: "poster-svg,poster-png" },
  pages: { type: "string", default: "all" },
  scale: { type: "string", default: "1" },
  "motion-quality": { type: "string", default: DEFAULT_MOTION_EXPORT_QUALITY },
  "svg-play": { type: "string", default: "loop" },
  "id-namespace": { type: "string" },
  "sans-font": { type: "string" },
  "mono-font": { type: "string" },
  "allow-font-fetch": { type: "boolean" },
} as const;
/** Separate output and optimistic source identity for edits. */
const EDIT_OPTIONS = {
  output: { type: "string", short: "o" },
  "in-place": { type: "boolean" },
  "expect-source": { type: "string" },
} as const;
/** The installed version's command contract. */
const USAGE = `svgent ${cliVersion} — authored conversations to images and animations

Usage: svgent <command> [options]
  guide                         Authoring rules, schema, presets, and workflow
  validate <script.json>        Validate without changing the input
  inspect <script.json>         IDs, page durations, reveal/settled times, review
  snapshot <script.json>        PNG at --page N --time MS [--output frame.png]
  direct <script.json>          Stage the script with --settings direction.json
  patch <script.json>           Edit named messages with --operations patch.json
  fit <script.json>             Fit --page N --target-ms MS [--preserve ID,ID]
  render <script.json…>         --out DIR --formats ${CLI_FORMATS.join(",")}

All commands: --json (one stdout result), --help, --lang en|ja, --strict.
Edits: --output FILE (default: INPUT.edited.json, must be new), or
       --in-place --expect-source SHA256. Warnings stop edits.
Render/snapshot: --scale 0.5..4, --sans-font FILE, --mono-font FILE,
                 --allow-font-fetch (explicit Google Fonts network request).
Render: --pages all|N, --motion-quality economy|balanced|high,
        --svg-play loop|once, --id-namespace NAME. MP4 needs local ffmpeg.
Snapshot: --page N (default: 1), --time MS (required); page numbers are 1-based.
Guide: --topic all|schema|presets|workflow (default: all).
Examples:
  svgent guide --json
  svgent inspect script.json --json
  svgent patch script.json --operations patch.json --expect-source SHA256 --json
  svgent render script.json --out out --formats poster-png,animated-svg --strict --json
`;

type Options = Record<string, string | boolean | (string | boolean)[] | undefined>;
function optionString(options: Options, key: string): string | undefined {
  const candidate = options[key];
  return typeof candidate === "string" ? candidate : undefined;
}
function requiredString(options: Options, key: string): string {
  const candidate = optionString(options, key);
  if (candidate === undefined || candidate.length === 0) {
    throw new CliError("INVALID_ARGUMENT", `--${key} is required.`);
  }
  return candidate;
}
function numberOption(
  options: Options,
  key: string,
  range: { min: number; max: number; integer?: boolean; default?: number },
): number {
  const raw = optionString(options, key);
  const candidate = raw === undefined ? range.default : raw.trim() === "" ? undefined : Number(raw);
  if (
    candidate === undefined ||
    !Number.isFinite(candidate) ||
    candidate < range.min ||
    candidate > range.max ||
    (range.integer && !Number.isInteger(candidate))
  ) {
    throw new CliError(
      "INVALID_ARGUMENT",
      `--${key} expects ${range.integer ? "an integer" : "a number"} in ${range.min}..${range.max}.`,
    );
  }
  return candidate;
}
function language(options: Options): "en" | "ja" {
  const lang = optionString(options, "lang");
  if (lang !== "en" && lang !== "ja") {
    throw new CliError("INVALID_ARGUMENT", "--lang expects en or ja.");
  }
  return lang;
}
function renderOptions(options: Options): CliOptions {
  const formats = (optionString(options, "formats") ?? "poster-png")
    .split(",")
    .map((entry) => entry.trim());
  if (formats.some((format) => !CLI_FORMATS.includes(format as CliFormat))) {
    throw new CliError("INVALID_ARGUMENT", "Unknown artifact format.");
  }
  const pages =
    options.pages === "all" || options.pages === undefined
      ? "all"
      : numberOption(options, "pages", { min: 1, max: 12, integer: true });
  const quality = optionString(options, "motion-quality") ?? DEFAULT_MOTION_EXPORT_QUALITY;
  if (!["economy", "balanced", "high"].includes(quality)) {
    throw new CliError("INVALID_ARGUMENT", "Invalid --motion-quality.");
  }
  const svgPlay = optionString(options, "svg-play") ?? "loop";
  if (svgPlay !== "loop" && svgPlay !== "once") {
    throw new CliError("INVALID_ARGUMENT", "Invalid --svg-play.");
  }
  const idNamespace = optionString(options, "id-namespace");
  if (idNamespace !== undefined) {
    assertIdentifierNamespace(idNamespace);
  }
  let ffmpeg: string | undefined;
  if (formats.includes("mp4")) {
    ffmpeg = resolveFfmpegCommand();
    if (!probeFfmpeg(ffmpeg)) {
      throw new CliError("FFMPEG_UNAVAILABLE", ffmpegNotFoundMessage(ffmpeg));
    }
  }
  return {
    outDir: optionString(options, "out") ?? "render-out",
    formats: [...new Set(formats)] as CliFormat[],
    pages,
    lang: language(options),
    fontOverrides: {
      ...(optionString(options, "sans-font") ? { sans: optionString(options, "sans-font") } : {}),
      ...(optionString(options, "mono-font") ? { mono: optionString(options, "mono-font") } : {}),
    },
    strict: options.strict === true,
    allowFontFetch: options["allow-font-fetch"] === true,
    scale: numberOption(options, "scale", { min: 0.5, max: 4, default: 1 }),
    motionQuality: quality as MotionExportQuality,
    animatedSvgIterations: svgPlay === "loop" ? "infinite" : "once",
    idNamespace,
    warnings: [],
    ...(ffmpeg ? { ffmpeg } : {}),
  };
}
async function readRequest(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new CliError("INVALID_ARGUMENT", "Request file must contain JSON.");
    }
    throw cause;
  }
}

function assertRenderInputs(inputs: string[], options: Options): void {
  if (options["id-namespace"] !== undefined && inputs.length > 1) {
    throw new CliError("INVALID_ARGUMENT", "--id-namespace names one render; pass one input.");
  }
  const stems = inputs.map((input) => path.basename(input).replace(/\.json$/u, ""));
  const outputNames =
    process.platform === "win32" ? stems.map((stem) => stem.toLowerCase()) : stems;
  if (new Set(outputNames).size !== inputs.length) {
    throw new CliError(
      "OUTPUT_COLLISION",
      "Input names would produce the same artifacts. Render them into separate output directories.",
    );
  }
}

async function runCommand(
  command: Command,
  inputs: string[],
  options: Options,
): Promise<Record<string, unknown>> {
  if (command === "guide") {
    if (inputs.length > 0) {
      throw new CliError("INVALID_ARGUMENT", "guide takes no input file.");
    }
    return { guide: authoringGuide(optionString(options, "topic") ?? "all"), warnings: [] };
  }
  const validInputCount = command === "render" ? inputs.length > 0 : inputs.length === 1;
  if (!validInputCount) {
    throw new CliError(
      "INVALID_ARGUMENT",
      "Pass one script file (render also accepts multiple files).",
    );
  }
  if (command === "render") {
    assertRenderInputs(inputs, options);
    const scripts = [];
    const writtenArtifacts = new Set<string>();
    for (const input of inputs) {
      scripts.push(
        await renderScriptFile(input, renderOptions(options), {
          inputPaths: inputs,
          writtenArtifacts,
        }),
      );
    }
    return {
      scripts,
      warnings: scripts.flatMap((script) => script.warnings),
      artifacts: scripts.flatMap((script) => script.artifacts),
    };
  }
  const script = await readScriptFile(inputs[0] ?? "", language(options));
  const source = { path: script.path, sha256: script.sha256 };
  const base = { source, warnings: script.warnings };
  if (options.strict || ["direct", "patch", "fit"].includes(command)) {
    assertScriptWarnings(script);
  }
  if (command === "validate") {
    return {
      ...base,
      normalized: JSON.parse(
        serializeProject(script.project, script.provenance ?? undefined),
      ) as unknown,
    };
  }
  if (command === "inspect") {
    return {
      ...base,
      pages: paginateMessages(script.project).map((messages, index) => {
        const timeline = buildTimeline(script.project, messages);
        return {
          page: index + 1,
          durationMs: timeline.durationMs,
          messages: timeline.messages.map(({ message, startMs, revealEndMs, settledMs }) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            startMs,
            revealEndMs,
            settledMs,
          })),
        };
      }),
      review: reviewSceneAnimation(script.project),
    };
  }
  if (command === "snapshot") {
    const rendering = renderOptions(options);
    const artifact = await snapshotScriptFile(script, rendering, {
      page: numberOption(options, "page", { min: 1, max: 12, integer: true, default: 1 }),
      timeMs: numberOption(options, "time", { min: 0, max: 120000 }),
      outputPath:
        optionString(options, "output") ?? `${path.basename(script.path, ".json")}.snapshot.png`,
    });
    return { source, warnings: rendering.warnings, artifacts: [artifact] };
  }
  return editScript(command, script, options);
}

async function editScript(
  command: Command,
  script: Awaited<ReturnType<typeof readScriptFile>>,
  options: Options,
): Promise<Record<string, unknown>> {
  const base = { source: { path: script.path, sha256: script.sha256 }, warnings: script.warnings };
  const expectedSourceHash = optionString(options, "expect-source");
  if (expectedSourceHash !== undefined && !/^[a-f\d]{64}$/u.test(expectedSourceHash)) {
    throw new CliError("INVALID_ARGUMENT", "--expect-source requires a SHA-256 hex digest.");
  }
  if (expectedSourceHash !== undefined && expectedSourceHash !== script.sha256) {
    throw new CliError("STALE_SOURCE", "The input differs from the inspected source hash.");
  }
  let edited: ReturnType<typeof applyScenePatch> | ReturnType<typeof directScript>;
  let fit: ReturnType<typeof fitSceneDuration> | undefined;
  if (command === "direct") {
    edited = directScript(script.project, await readRequest(requiredString(options, "settings")));
  } else if (command === "patch") {
    edited = applyScenePatch(
      script.project,
      parseScenePatchOperations(await readRequest(requiredString(options, "operations"))),
    );
  } else {
    const page = numberOption(options, "page", { min: 1, max: 12, integer: true, default: 1 });
    const pageCount = paginateMessages(script.project).length;
    if (page > pageCount) {
      throw new CliError("INVALID_ARGUMENT", `Page ${page} requested but only ${pageCount} exist.`);
    }
    fit = fitSceneDuration(script.project, {
      pageIndex: page - 1,
      targetMs: numberOption(options, "target-ms", { min: 1000, max: 120000 }),
      preserveMessageIds: optionString(options, "preserve")?.split(","),
    });
    if (fit.constrained) {
      throw new CliError(
        "FIT_CONSTRAINED",
        "The target cannot be reached within the existing timing limits.",
        { fit },
      );
    }
    edited = applyScenePatch(script.project, fit.operations);
  }
  const outputText = serializeProject(edited.project, script.provenance ?? undefined);
  const checked = deserializeProject(outputText, language(options));
  const outputWarnings = [
    ...checked.warnings,
    ...scriptTimelineWarnings(checked.project, language(options)),
  ];
  if (outputWarnings.length > 0) {
    throw new CliError("WARNINGS", "The edit needs a correction. No output was saved.", {
      warnings: outputWarnings,
      changes: edited.changes,
    });
  }
  const output = await writeScriptFile(script, edited.project, {
    outputPath: optionString(options, "output"),
    inPlace: options["in-place"] === true,
    expectedSourceHash,
  });
  return {
    ...base,
    output,
    changes: edited.changes,
    ...(fit ? { fit } : {}),
    review: reviewSceneAnimation(edited.project),
  };
}

function optionsFor(command: Command): NonNullable<Parameters<typeof parseArgs>[0]>["options"] {
  switch (command) {
    case "guide":
      return { topic: { type: "string" } };
    case "render":
      return RENDER_OPTIONS;
    case "snapshot":
      return {
        scale: RENDER_OPTIONS.scale,
        "sans-font": RENDER_OPTIONS["sans-font"],
        "mono-font": RENDER_OPTIONS["mono-font"],
        "allow-font-fetch": RENDER_OPTIONS["allow-font-fetch"],
        page: { type: "string" },
        time: { type: "string" },
        output: { type: "string", short: "o" },
      };
    case "direct":
      return { ...EDIT_OPTIONS, settings: { type: "string" } };
    case "patch":
      return { ...EDIT_OPTIONS, operations: { type: "string" } };
    case "fit":
      return {
        ...EDIT_OPTIONS,
        page: { type: "string" },
        "target-ms": { type: "string" },
        preserve: { type: "string" },
      };
    default:
      return {};
  }
}

function failureCode(cause: unknown): string {
  if (cause instanceof CliError) {
    return cause.code;
  }
  const code = (cause as NodeJS.ErrnoException).code;
  if (code === "EEXIST") {
    return "OUTPUT_EXISTS";
  }
  if (typeof code !== "string") {
    return "INVALID_INPUT";
  }
  return code.startsWith("ERR_PARSE_ARGS") ? "INVALID_ARGUMENT" : "IO_ERROR";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commandName = argv.shift();
  const json = argv.includes("--json");
  try {
    if (commandName === "--version") {
      process.stdout.write(
        json ? `${JSON.stringify({ ok: true, cliVersion })}\n` : `${cliVersion}\n`,
      );
      return;
    }
    if (commandName === undefined || commandName === "--help" || commandName === "-h") {
      process.stdout.write(
        json ? `${JSON.stringify({ ok: true, cliVersion, help: USAGE })}\n` : USAGE,
      );
      return;
    }
    if (!COMMANDS.includes(commandName as Command)) {
      throw new CliError(
        "INVALID_ARGUMENT",
        `Unknown command "${commandName}". Use svgent --help.`,
      );
    }
    const command = commandName as Command;
    const specific = optionsFor(command);
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { ...COMMON_OPTIONS, ...specific },
    });
    if (values.help) {
      process.stdout.write(
        json ? `${JSON.stringify({ ok: true, cliVersion, command, help: USAGE })}\n` : USAGE,
      );
      return;
    }
    const outcome = {
      ok: true,
      cliVersion,
      command,
      ...(await runCommand(command, positionals, values)),
    };
    process.stdout.write(`${JSON.stringify(outcome, null, json ? undefined : 2)}\n`);
  } catch (cause) {
    const code = failureCode(cause);
    const message = cause instanceof Error ? cause.message : String(cause);
    const failure = {
      ok: false,
      cliVersion,
      command: commandName,
      error: { code, message },
      ...(cause instanceof CliError ? cause.details : {}),
    };
    if (json) {
      process.stdout.write(`${JSON.stringify(failure)}\n`);
    }
    console.error(`[svgent] ${code}: ${message}`);
    process.exitCode = 1;
  }
}
await main();
