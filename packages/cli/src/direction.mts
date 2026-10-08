/** Decode file-based direction requests before passing them to shared authoring. */
import {
  applyCameraDirection,
  applySceneDirection,
  applyScenePatch,
  type CameraDirection,
  parseScenePatchOperations,
  type SceneDirection,
} from "@svgent/authoring";
import type { SvgentProject } from "@svgent/scene";
import { CliError } from "./script-file.mjs";

function record(candidate: unknown, label: string): Record<string, unknown> {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new CliError("INVALID_ARGUMENT", `${label} must be an object.`);
  }
  return candidate as Record<string, unknown>;
}

function assertFields(
  fields: Record<string, unknown>,
  types: Record<string, "string" | "number" | "boolean">,
  label: string,
): void {
  for (const [key, candidate] of Object.entries(fields)) {
    if (
      types[key] === undefined ||
      typeof candidate !== types[key] ||
      (typeof candidate === "number" && !Number.isFinite(candidate))
    ) {
      throw new CliError("INVALID_ARGUMENT", `Unsupported or invalid ${label}.${key}.`);
    }
  }
}

/** Apply only recognized scene, camera, appearance, and display settings. */
export function directScript(
  project: SvgentProject,
  candidate: unknown,
): ReturnType<typeof applySceneDirection> {
  const request = record(candidate, "settings");
  const allowed = ["scene", "camera", "appearance", "display"];
  if (
    Object.keys(request).length === 0 ||
    Object.keys(request).some((key) => !allowed.includes(key))
  ) {
    throw new CliError("INVALID_ARGUMENT", `Settings accepts ${allowed.join(", ")}.`);
  }
  let directed = { project, changes: [] as ReturnType<typeof applySceneDirection>["changes"] };
  if (request.scene !== undefined) {
    const scene = record(request.scene, "scene");
    assertFields(
      scene,
      {
        surface: "string",
        sizePreset: "string",
        displayPreset: "string",
        pacingPreset: "string",
        flow: "string",
        messagesPerPage: "number",
        theme: "string",
        backdrop: "string",
        fontScale: "number",
        transparentCanvas: "boolean",
      },
      "scene",
    );
    directed = applySceneDirection(directed.project, scene as SceneDirection);
  }
  if (request.appearance !== undefined) {
    const patched = applyScenePatch(
      directed.project,
      parseScenePatchOperations([{ op: "set-appearance", changes: request.appearance }]),
    );
    directed = { project: patched.project, changes: [...directed.changes, ...patched.changes] };
  }
  if (request.camera !== undefined) {
    const camera = record(request.camera, "camera");
    assertFields(
      camera,
      { follow: "boolean", zoom: "number", style: "string", suppressBriefMoves: "boolean" },
      "camera",
    );
    const changed = applyCameraDirection(directed.project, {
      ...camera,
      follow: camera.follow ?? directed.project.camera.follow,
    } as CameraDirection);
    directed = { project: changed.project, changes: [...directed.changes, ...changed.changes] };
  }
  if (request.display !== undefined) {
    const display = record(request.display, "display");
    const current = directed.project.display;
    assertFields(
      display,
      Object.fromEntries(Object.keys(current).map((key) => [key, "boolean" as const])),
      "display",
    );
    for (const [key, after] of Object.entries(display)) {
      const before = current[key as keyof typeof current];
      if (before !== after) {
        directed.changes.push({ path: `display.${key}`, before, after: after as boolean });
      }
    }
    directed.project = { ...directed.project, display: { ...current, ...display } };
  }
  return directed;
}
