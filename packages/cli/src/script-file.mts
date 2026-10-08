/** Source identity and file writes for commands that edit authored scripts. */
import { createHash } from "node:crypto";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  deserializeProject,
  draftTimelineIssues,
  MAX_DRAFT_RUN_CLUSTERS,
  MAX_PROJECT_DURATION_MS,
  type SvgentProject,
  serializeProject,
} from "@svgent/scene";

/** A command failure with a stable machine-readable code. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** Input bytes and the project derived from them, without writing the input. */
export type LoadedScript = {
  path: string;
  sha256: string;
  text: string;
  project: SvgentProject;
  provenance: ReturnType<typeof deserializeProject>["provenance"];
  warnings: string[];
};

/** Hash the exact file bytes, including whitespace. */
function sourceHash(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function normalizationIssues(authored: unknown, normalized: unknown, field = "script"): string[] {
  if (Array.isArray(authored) && Array.isArray(normalized)) {
    return [
      ...(authored.length === normalized.length ? [] : [`${field}: array length was normalized.`]),
      ...authored.flatMap((entry, index) =>
        normalizationIssues(entry, normalized[index], `${field}.${index}`),
      ),
    ];
  }
  if (
    authored !== null &&
    typeof authored === "object" &&
    !Array.isArray(authored) &&
    normalized !== null &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
  ) {
    const fields = normalized as Record<string, unknown>;
    return Object.entries(authored).flatMap(([key, entry]) =>
      normalizationIssues(entry, fields[key], `${field}.${key}`),
    );
  }
  return authored === normalized ? [] : [`${field}: supplied value was normalized or omitted.`];
}

/** Keep timeline diagnostics in the requested command language. */
export function scriptTimelineWarnings(project: SvgentProject, lang: "en" | "ja"): string[] {
  return draftTimelineIssues(project).map((issue) => {
    if (lang === "en") {
      return issue.detail;
    }
    switch (issue.code) {
      case "ime-run-too-long":
        return `${(issue.messageIndex ?? 0) + 1}件目のIME読みは1回の変換につき${MAX_DRAFT_RUN_CLUSTERS}文字以下に分けてください。`;
      case "duration-too-short":
        return `${(issue.messageIndex ?? 0) + 1}件目の表示時間ではIME変換・確定・補完を完了できません。`;
      case "project-too-long":
        return `アニメーションの総尺は${MAX_PROJECT_DURATION_MS / 1000}秒以下にしてください。`;
      default:
        return issue.detail;
    }
  });
}

/** Import a file and report every supplied value changed by normalization. */
export async function readScriptFile(
  inputPath: string,
  lang: "en" | "ja" = "en",
): Promise<LoadedScript> {
  const bytes = await readFile(inputPath);
  const text = bytes.toString("utf8");
  let imported: ReturnType<typeof deserializeProject>;
  try {
    imported = deserializeProject(text, lang);
  } catch (cause) {
    throw new CliError("INVALID_INPUT", cause instanceof Error ? cause.message : String(cause));
  }
  const ids = new Set<string>();
  for (const message of imported.project.messages) {
    if (ids.has(message.id)) {
      throw new CliError("DUPLICATE_ID", `Duplicate message ID "${message.id}".`);
    }
    ids.add(message.id);
  }
  // The importer omits message defaults; their explicit spelling is lossless.
  const normalized = {
    ...(JSON.parse(serializeProject(imported.project, imported.provenance ?? undefined)) as Record<
      string,
      unknown
    >),
    messages: imported.project.messages.map((message) => ({
      images: [],
      timing: {},
      pageBreakBefore: false,
      ...(message.role === "permission" ? { decision: "allow" } : {}),
      ...(message.role === "thinking" ? { highlight: false } : {}),
      ...(message.role === "choice"
        ? { options: [], chosenIndex: 0, freeform: "", afterSelection: "collapse" }
        : {}),
      ...message,
    })),
  };
  const warnings = [
    ...new Set([
      ...imported.warnings,
      ...normalizationIssues(JSON.parse(text) as unknown, normalized),
      ...scriptTimelineWarnings(imported.project, lang),
    ]),
  ];
  return { path: path.resolve(inputPath), sha256: sourceHash(bytes), text, ...imported, warnings };
}

/** Refuse to silently commit an import correction or an unfinished timeline. */
export function assertScriptWarnings(script: LoadedScript): void {
  if (script.warnings.length > 0) {
    throw new CliError("WARNINGS", "Resolve input warnings before this operation.", {
      warnings: script.warnings,
      source: { path: script.path, sha256: script.sha256 },
    });
  }
}

/** Save a separate file by default; in-place updates require the inspected hash. */
export async function writeScriptFile(
  script: LoadedScript,
  project: SvgentProject,
  request: { outputPath?: string; inPlace: boolean; expectedSourceHash?: string },
): Promise<{ path: string; sha256: string }> {
  if (request.expectedSourceHash !== undefined && request.expectedSourceHash !== script.sha256) {
    throw new CliError("STALE_SOURCE", "The input differs from the expected source hash.");
  }
  if (request.inPlace && request.outputPath !== undefined) {
    throw new CliError("INVALID_ARGUMENT", "Choose --output or --in-place.");
  }
  if (request.inPlace && request.expectedSourceHash === undefined) {
    throw new CliError(
      "EXPECTED_HASH_REQUIRED",
      "--in-place requires --expect-source from inspect.",
    );
  }
  const outputPath = request.inPlace
    ? script.path
    : path.resolve(request.outputPath ?? script.path.replace(/(?:\.json)?$/u, ".edited.json"));
  const text = `${serializeProject(project, script.provenance ?? undefined)}\n`;
  if (!request.inPlace) {
    try {
      await writeFile(outputPath, text, { flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CliError("OUTPUT_EXISTS", "The output exists. Choose a new --output path.");
      }
      throw cause;
    }
    return { path: outputPath, sha256: sourceHash(text) };
  }
  await writeInPlace(script, text);
  return { path: outputPath, sha256: sourceHash(text) };
}

async function writeInPlace(script: LoadedScript, text: string): Promise<void> {
  if ((await lstat(script.path)).isSymbolicLink()) {
    throw new CliError("INVALID_ARGUMENT", "In-place edits require a regular input path.");
  }
  const lockPath = `${script.path}.svgent-lock`;
  let lock: Awaited<ReturnType<typeof open>>;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliError(
        "SOURCE_BUSY",
        "Another edit holds the source lock. After a crash, confirm no edit is active before removing stale .svgent-lock files, then inspect the source again.",
      );
    }
    throw cause;
  }
  const temporaryPath = `${lockPath}.json`;
  let temporaryCreated = false;
  try {
    const sourceStat = await lstat(script.path);
    if (!sourceStat.isFile() || sourceStat.nlink !== 1) {
      throw new CliError(
        "INVALID_ARGUMENT",
        "In-place edits require a regular file with one link.",
      );
    }
    await writeFile(temporaryPath, text, { flag: "wx", mode: sourceStat.mode });
    temporaryCreated = true;
    if (sourceHash(await readFile(script.path)) !== script.sha256) {
      throw new CliError("STALE_SOURCE", "The input changed before the edit could be saved.");
    }
    await rename(temporaryPath, script.path);
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    await lock.close();
    await unlink(lockPath);
  }
}
