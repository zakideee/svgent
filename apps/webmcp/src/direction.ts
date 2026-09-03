/**
 * Scene direction: the choices that decide how a script is staged rather
 * than what it says. Shared by the agent's tools and the person's chips so
 * both apply a direction the same way and describe it with the same words.
 */

import { applyScenePatch, type PatchChange, type ScenePatchOperation } from "@svgent/authoring";
import {
  BACKDROP_PRESETS,
  type BackdropId,
  buildTimeline,
  CAMERA_MIN_SHOT_PRESET_MS,
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_MIN,
  type CameraStyle,
  DISPLAY_PRESETS,
  type FlowMode,
  paginateMessages,
  SCENE_PACING_PRESETS,
  SIZE_PRESETS,
  type SurfaceMode,
  type SvgentProject,
  THEME_PRESETS,
  type ThemeId,
} from "@svgent/scene";

export const SURFACES: readonly SurfaceMode[] = ["app", "tui"];
export const FLOWS: readonly FlowMode[] = ["scroll", "slides"];
export const CAMERA_STYLES: readonly CameraStyle[] = ["anticipate", "sync", "trail"];

export type SceneDirection = {
  surface?: SurfaceMode;
  sizePreset?: string;
  displayPreset?: string;
  pacingPreset?: string;
  flow?: FlowMode;
  messagesPerPage?: number;
  theme?: ThemeId;
  backdrop?: BackdropId;
  fontScale?: number;
  transparentCanvas?: boolean;
};

export type CameraDirection = {
  follow: boolean;
  zoom?: number;
  style?: CameraStyle;
  suppressBriefMoves?: boolean;
};

type Directed = { project: SvgentProject; changes: PatchChange[] };

function change(path: string, before: unknown, after: unknown): PatchChange {
  const scalar = (value: unknown): PatchChange["before"] =>
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? value
      : value === null || value === undefined
        ? null
        : JSON.stringify(value);
  return { path, before: scalar(before), after: scalar(after) };
}

function presetOrThrow<T extends { id: string }>(
  presets: readonly T[],
  id: string,
  what: string,
): T {
  const found = presets.find((preset) => preset.id === id);
  if (found === undefined) {
    throw new Error(`Unknown ${what} "${id}"; one of ${presets.map((p) => p.id).join(", ")}`);
  }
  return found;
}

export function applySceneDirection(project: SvgentProject, direction: SceneDirection): Directed {
  let current = project;
  const changes: PatchChange[] = [];

  if (direction.surface !== undefined) {
    if (!SURFACES.includes(direction.surface)) {
      throw new Error(`surface must be one of ${SURFACES.join(", ")}`);
    }
    if (current.surface !== direction.surface) {
      changes.push(change("surface", current.surface, direction.surface));
      current = { ...current, surface: direction.surface };
    }
  }

  const appearance: Record<string, unknown> = {};
  if (direction.theme !== undefined) {
    presetOrThrow(THEME_PRESETS, direction.theme, "theme");
    appearance.theme = direction.theme;
  }
  if (direction.backdrop !== undefined) {
    presetOrThrow(BACKDROP_PRESETS, direction.backdrop, "backdrop");
    appearance.backdrop = direction.backdrop;
  }
  if (direction.fontScale !== undefined) {
    appearance.fontScale = direction.fontScale;
  }
  if (direction.transparentCanvas !== undefined) {
    appearance.transparentCanvas = direction.transparentCanvas;
  }
  if (direction.sizePreset !== undefined) {
    const size = presetOrThrow(SIZE_PRESETS, direction.sizePreset, "size preset");
    appearance.canvasWidth = size.width;
    appearance.canvasHeight = size.height;
  }
  const operations: ScenePatchOperation[] = [];
  if (Object.keys(appearance).length > 0) {
    operations.push({ op: "set-appearance", changes: appearance });
  }
  if (direction.pacingPreset !== undefined) {
    const pacing = presetOrThrow(SCENE_PACING_PRESETS, direction.pacingPreset, "pacing preset");
    operations.push({ op: "set-project-timing", changes: pacing.apply });
  }
  if (operations.length > 0) {
    const applied = applyScenePatch(current, operations);
    current = applied.project;
    changes.push(...applied.changes);
  }

  if (direction.displayPreset !== undefined) {
    const preset = presetOrThrow(DISPLAY_PRESETS, direction.displayPreset, "display preset");
    const { display, ...rest } = preset.apply;
    const next: SvgentProject = {
      ...current,
      appearance: { ...current.appearance, ...rest },
      ...(display ? { display: { ...display } } : {}),
    };
    changes.push(change("displayPreset", null, preset.id));
    current = next;
  }

  if (direction.flow !== undefined || direction.messagesPerPage !== undefined) {
    const flow = direction.flow ?? current.pagination.flow;
    if (!FLOWS.includes(flow)) {
      throw new Error(`flow must be one of ${FLOWS.join(", ")}`);
    }
    const perPage = direction.messagesPerPage ?? current.pagination.messagesPerPage;
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 12) {
      throw new Error("messagesPerPage must be an integer in 1..12");
    }
    if (flow !== current.pagination.flow) {
      changes.push(change("pagination.flow", current.pagination.flow, flow));
    }
    if (perPage !== current.pagination.messagesPerPage) {
      changes.push(
        change("pagination.messagesPerPage", current.pagination.messagesPerPage, perPage),
      );
    }
    current = { ...current, pagination: { ...current.pagination, flow, messagesPerPage: perPage } };
  }

  return { project: current, changes };
}

export function applyCameraDirection(project: SvgentProject, direction: CameraDirection): Directed {
  const zoom = direction.zoom ?? project.camera.zoom;
  if (!Number.isFinite(zoom) || zoom < CAMERA_ZOOM_MIN || zoom > CAMERA_ZOOM_MAX) {
    throw new Error(`zoom must be in ${CAMERA_ZOOM_MIN}..${CAMERA_ZOOM_MAX}`);
  }
  const style = direction.style ?? project.camera.style;
  if (!CAMERA_STYLES.includes(style)) {
    throw new Error(`style must be one of ${CAMERA_STYLES.join(", ")}`);
  }
  const minShotMs =
    direction.suppressBriefMoves === undefined
      ? project.camera.minShotMs
      : direction.suppressBriefMoves
        ? CAMERA_MIN_SHOT_PRESET_MS
        : 0;
  const next = { follow: direction.follow, zoom, style, minShotMs };
  const changes: PatchChange[] = [];
  for (const key of ["follow", "zoom", "style", "minShotMs"] as const) {
    if (project.camera[key] !== next[key]) {
      changes.push(change(`camera.${key}`, project.camera[key], next[key]));
    }
  }
  return { project: { ...project, camera: next }, changes };
}

/** Where a message lives: its page, when it starts, and when it has fully landed. */
export function locateMessage(
  project: SvgentProject,
  messageId: string,
): { page: number; startMs: number; settledMs: number } | null {
  const pages = paginateMessages(project);
  for (const [page, messages] of pages.entries()) {
    if (!messages.some((message) => message.id === messageId)) {
      continue;
    }
    const timing = buildTimeline(project, messages).messages.find(
      (entry) => entry.message.id === messageId,
    );
    return timing === undefined
      ? null
      : { page, startMs: timing.startMs, settledMs: timing.settledMs };
  }
  return null;
}

export const DIRECTION_CHOICES = {
  themes: THEME_PRESETS.map(({ id, label, background, accent }) => ({
    id,
    label,
    background,
    accent,
  })),
  backdrops: BACKDROP_PRESETS.map(({ id, label }) => ({ id, label })),
  sizes: SIZE_PRESETS.map(({ id, label, width, height, hint }) => ({
    id,
    label,
    width,
    height,
    hint: hint.en,
  })),
  displayPresets: DISPLAY_PRESETS.map(({ id, label, description }) => ({
    id,
    label: label.en,
    description: description.en,
  })),
  pacing: SCENE_PACING_PRESETS.map(({ id, label, description, apply }) => ({
    id,
    label: label.en,
    description: description.en,
    timing: apply,
  })),
  cameraStyles: CAMERA_STYLES,
  cameraZoom: [CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX],
};
