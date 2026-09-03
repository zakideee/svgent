import {
  type AppearanceSettings,
  type AssistantSurface,
  BACKDROP_PRESETS,
  type BackdropId,
  type ContentAlign,
  type ImageSkeletonId,
  MAX_MESSAGE_CHARS,
  MESSAGE_TIMING_LIMITS,
  type MessageAlign,
  type MessageTimingOverride,
  type SvgentProject,
  THEME_PRESETS,
  type ThemeId,
  type TimingSettings,
} from "@svgent/scene";

export type MessageTimingChange = {
  durationMs?: number | null;
  pauseBeforeMs?: number | null;
  transitionMs?: number | null;
};

export type ProjectTimingChange = Partial<TimingSettings>;

/**
 * The appearance fields a patch may touch. Bounded by one test — does a
 * bubble stay a bubble — and to enumerable scalars, so `backdropImage` is
 * excluded: images stay tab-local Data URLs no patch may carry.
 */
export type AppearanceChange = Partial<
  Pick<
    AppearanceSettings,
    | "theme"
    | "canvasWidth"
    | "canvasHeight"
    | "transparentCanvas"
    | "terminalOpacity"
    | "background"
    | "accent"
    | "userBubbleColor"
    | "backdrop"
    | "imageSkeleton"
    | "shadowStrength"
    | "windowMargin"
    | "windowPaddingX"
    | "windowPaddingY"
    | "fontScale"
    | "chromeScale"
    | "spacingScale"
    | "contentAlign"
    | "messageAlign"
    | "assistantSurface"
  >
>;

export type ScenePatchOperation =
  | {
      op: "set-message-timing";
      messageId: string;
      changes: MessageTimingChange;
    }
  | {
      op: "set-message-content";
      messageId: string;
      content: string;
    }
  | {
      op: "set-message-page-break";
      messageId: string;
      value: boolean;
    }
  | {
      op: "set-project-timing";
      changes: ProjectTimingChange;
    }
  | {
      op: "set-appearance";
      changes: AppearanceChange;
    };

export type PatchChange = {
  path: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
};

type AppliedScenePatch = {
  project: SvgentProject;
  changes: PatchChange[];
  affectedMessageIds: string[];
};

const MAX_PATCH_OPERATIONS = 24;

const PROJECT_TIMING_LIMITS: Record<keyof TimingSettings, { min: number; max: number }> = {
  userTypingCps: { min: 6, max: 60 },
  agentTypingCps: { min: 8, max: 300 },
  reactionMs: { min: 0, max: 3_000 },
  thinkingMs: { min: 400, max: 8_000 },
  toolRunMs: { min: 300, max: 6_000 },
  imageGenMs: { min: 800, max: 20_000 },
  permissionMs: { min: 500, max: 6_000 },
  transitionMs: { min: 0, max: 2_000 },
  finalHoldMs: { min: 500, max: 6_000 },
};

const MESSAGE_TIMING_KEYS = ["durationMs", "pauseBeforeMs", "transitionMs"] as const;
const PROJECT_TIMING_KEYS = [
  "userTypingCps",
  "agentTypingCps",
  "thinkingMs",
  "toolRunMs",
  "imageGenMs",
  "permissionMs",
  "transitionMs",
  "finalHoldMs",
] as const;

/** Mirrors the ranges the script importer clamps appearance values to. */
const APPEARANCE_NUMBER_LIMITS = {
  canvasWidth: { min: 640, max: 2_560 },
  canvasHeight: { min: 480, max: 2_560 },
  terminalOpacity: { min: 0.45, max: 1 },
  shadowStrength: { min: 0, max: 1 },
  windowMargin: { min: 0, max: 140 },
  windowPaddingX: { min: 0, max: 80 },
  windowPaddingY: { min: 0, max: 80 },
  fontScale: { min: 0.8, max: 5 },
  chromeScale: { min: 0.8, max: 3 },
  spacingScale: { min: 0.6, max: 1.6 },
} as const satisfies Partial<Record<keyof AppearanceChange, { min: number; max: number }>>;

const IMAGE_SKELETON_IDS: readonly ImageSkeletonId[] = ["dots", "sweep", "tiles"];
const CONTENT_ALIGNS: readonly ContentAlign[] = ["start", "center"];
const MESSAGE_ALIGNS: readonly MessageAlign[] = ["role", "center"];
const ASSISTANT_SURFACES: readonly AssistantSurface[] = ["card", "plain"];

const APPEARANCE_ENUMS = {
  theme: THEME_PRESETS.map((preset) => preset.id) as readonly ThemeId[],
  backdrop: BACKDROP_PRESETS.map((preset) => preset.id) as readonly BackdropId[],
  imageSkeleton: IMAGE_SKELETON_IDS,
  contentAlign: CONTENT_ALIGNS,
  messageAlign: MESSAGE_ALIGNS,
  assistantSurface: ASSISTANT_SURFACES,
} as const;

/** Also the colors a theme preset seeds, which is why picking one resets them. */
const APPEARANCE_COLOR_KEYS = ["background", "accent", "userBubbleColor"] as const;

const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

const APPEARANCE_KEYS = [
  "theme",
  "canvasWidth",
  "canvasHeight",
  "transparentCanvas",
  "terminalOpacity",
  "background",
  "accent",
  "userBubbleColor",
  "backdrop",
  "imageSkeleton",
  "shadowStrength",
  "windowMargin",
  "windowPaddingX",
  "windowPaddingY",
  "fontScale",
  "chromeScale",
  "spacingScale",
  "contentAlign",
  "messageAlign",
  "assistantSurface",
] as const satisfies readonly (keyof AppearanceChange)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertFiniteRange(
  value: unknown,
  options: { label: string; min: number; max: number },
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < options.min ||
    value > options.max
  ) {
    throw new Error(`${options.label} must be a finite number in ${options.min}..${options.max}`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${label} contains unsupported field "${key}"`);
    }
  }
}

function parseMessageTimingChanges(value: unknown): MessageTimingChange {
  if (!isRecord(value)) {
    throw new Error("set-message-timing changes must be an object");
  }
  assertOnlyKeys(value, MESSAGE_TIMING_KEYS, "set-message-timing changes");
  const parsed: MessageTimingChange = {};
  for (const key of MESSAGE_TIMING_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (candidate === null) {
      parsed[key] = null;
      continue;
    }
    const limits = MESSAGE_TIMING_LIMITS[key];
    parsed[key] = assertFiniteRange(candidate, { label: key, ...limits });
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("set-message-timing changes must not be empty");
  }
  return parsed;
}

function parseProjectTimingChanges(value: unknown): ProjectTimingChange {
  if (!isRecord(value)) {
    throw new Error("set-project-timing changes must be an object");
  }
  assertOnlyKeys(value, PROJECT_TIMING_KEYS, "set-project-timing changes");
  const parsed: ProjectTimingChange = {};
  for (const key of PROJECT_TIMING_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    const limits = PROJECT_TIMING_LIMITS[key];
    parsed[key] = assertFiniteRange(candidate, { label: key, ...limits });
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("set-project-timing changes must not be empty");
  }
  return parsed;
}

function parseAppearanceChanges(value: unknown): AppearanceChange {
  if (!isRecord(value)) {
    throw new Error("set-appearance changes must be an object");
  }
  assertOnlyKeys(value, APPEARANCE_KEYS, "set-appearance changes");
  const parsed: Record<string, unknown> = {};
  for (const [key, limits] of Object.entries(APPEARANCE_NUMBER_LIMITS)) {
    if (value[key] !== undefined) {
      parsed[key] = assertFiniteRange(value[key], { label: key, ...limits });
    }
  }
  for (const [key, allowed] of Object.entries(APPEARANCE_ENUMS)) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "string" || !(allowed as readonly string[]).includes(candidate)) {
      throw new Error(`${key} must be one of ${allowed.join(", ")}`);
    }
    parsed[key] = candidate;
  }
  for (const key of APPEARANCE_COLOR_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) {
      continue;
    }
    if (typeof candidate !== "string" || !HEX_COLOR_PATTERN.test(candidate)) {
      throw new Error(`${key} must be a #rgb or #rrggbb color`);
    }
    parsed[key] = candidate;
  }
  if (value.transparentCanvas !== undefined) {
    if (typeof value.transparentCanvas !== "boolean") {
      throw new Error("transparentCanvas must be boolean");
    }
    parsed.transparentCanvas = value.transparentCanvas;
  }
  if (Object.keys(parsed).length === 0) {
    throw new Error("set-appearance changes must not be empty");
  }
  return parsed as AppearanceChange;
}

function readMessageId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    throw new Error("messageId must be a non-empty string no longer than 160 characters");
  }
  return value;
}

function parsePatchOperation(value: unknown): ScenePatchOperation {
  if (!isRecord(value) || typeof value.op !== "string") {
    throw new Error("Every patch operation must be an object with an op field");
  }
  switch (value.op) {
    case "set-message-timing":
      return {
        op: value.op,
        messageId: readMessageId(value.messageId),
        changes: parseMessageTimingChanges(value.changes),
      };
    case "set-message-content": {
      const content = value.content;
      if (typeof content !== "string" || content.length > MAX_MESSAGE_CHARS) {
        throw new Error(`content must be a string no longer than ${MAX_MESSAGE_CHARS} characters`);
      }
      return { op: value.op, messageId: readMessageId(value.messageId), content };
    }
    case "set-message-page-break":
      if (typeof value.value !== "boolean") {
        throw new Error("set-message-page-break value must be boolean");
      }
      return {
        op: value.op,
        messageId: readMessageId(value.messageId),
        value: value.value,
      };
    case "set-project-timing":
      return { op: value.op, changes: parseProjectTimingChanges(value.changes) };
    case "set-appearance":
      return { op: value.op, changes: parseAppearanceChanges(value.changes) };
    default:
      throw new Error(`Unsupported patch operation "${value.op}"`);
  }
}

export function parseScenePatchOperations(value: unknown): ScenePatchOperation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATCH_OPERATIONS) {
    throw new Error(`operations must contain 1..${MAX_PATCH_OPERATIONS} entries`);
  }
  return value.map(parsePatchOperation);
}

function compactTiming(timing: MessageTimingOverride): MessageTimingOverride | undefined {
  return Object.keys(timing).length === 0 ? undefined : timing;
}

function timingValue(value: number | undefined): number | null {
  return value ?? null;
}

function applyMessageTiming(
  project: SvgentProject,
  operation: Extract<ScenePatchOperation, { op: "set-message-timing" }>,
): AppliedScenePatch {
  const messageIndex = project.messages.findIndex((message) => message.id === operation.messageId);
  const message = project.messages[messageIndex];
  if (!message) {
    throw new Error(`Unknown messageId "${operation.messageId}"`);
  }
  const timing: MessageTimingOverride = { ...message.timing };
  const changes: PatchChange[] = [];
  for (const key of MESSAGE_TIMING_KEYS) {
    const requested = operation.changes[key];
    if (requested === undefined) {
      continue;
    }
    const before = timingValue(timing[key]);
    if (requested === null) {
      delete timing[key];
    } else {
      timing[key] = requested;
    }
    const after = timingValue(timing[key]);
    if (before !== after) {
      changes.push({ path: `messages.${operation.messageId}.timing.${key}`, before, after });
    }
  }
  const messages = [...project.messages];
  const nextTiming = compactTiming(timing);
  messages[messageIndex] = {
    ...message,
    ...(nextTiming ? { timing: nextTiming } : {}),
  };
  if (!nextTiming) {
    delete messages[messageIndex]?.timing;
  }
  return {
    project: { ...project, messages },
    changes,
    affectedMessageIds: changes.length > 0 ? [operation.messageId] : [],
  };
}

function describeContent(value: string): string {
  return `${Array.from(value).length} chars`;
}

function applyMessageContent(
  project: SvgentProject,
  operation: Extract<ScenePatchOperation, { op: "set-message-content" }>,
): AppliedScenePatch {
  const messageIndex = project.messages.findIndex((message) => message.id === operation.messageId);
  const message = project.messages[messageIndex];
  if (!message) {
    throw new Error(`Unknown messageId "${operation.messageId}"`);
  }
  if (message.content === operation.content) {
    return { project, changes: [], affectedMessageIds: [] };
  }
  const messages = [...project.messages];
  messages[messageIndex] = { ...message, content: operation.content };
  return {
    project: { ...project, messages },
    changes: [
      {
        path: `messages.${operation.messageId}.content`,
        before: describeContent(message.content),
        after: describeContent(operation.content),
      },
    ],
    affectedMessageIds: [operation.messageId],
  };
}

function applyPageBreak(
  project: SvgentProject,
  operation: Extract<ScenePatchOperation, { op: "set-message-page-break" }>,
): AppliedScenePatch {
  if (operation.value && project.pagination.flow !== "slides") {
    throw new Error('pageBreakBefore can only be enabled when pagination.flow is "slides"');
  }
  const messageIndex = project.messages.findIndex((message) => message.id === operation.messageId);
  const message = project.messages[messageIndex];
  if (!message) {
    throw new Error(`Unknown messageId "${operation.messageId}"`);
  }
  const before = message.pageBreakBefore === true;
  if (before === operation.value) {
    return { project, changes: [], affectedMessageIds: [] };
  }
  const messages = [...project.messages];
  messages[messageIndex] = {
    ...message,
    ...(operation.value ? { pageBreakBefore: true } : {}),
  };
  if (!operation.value) {
    delete messages[messageIndex]?.pageBreakBefore;
  }
  return {
    project: { ...project, messages },
    changes: [
      {
        path: `messages.${operation.messageId}.pageBreakBefore`,
        before,
        after: operation.value,
      },
    ],
    affectedMessageIds: [operation.messageId],
  };
}

function applyProjectTiming(
  project: SvgentProject,
  operation: Extract<ScenePatchOperation, { op: "set-project-timing" }>,
): AppliedScenePatch {
  const timing = { ...project.timing, ...operation.changes };
  const changes = PROJECT_TIMING_KEYS.flatMap((key): PatchChange[] => {
    const after = operation.changes[key];
    return after !== undefined && after !== project.timing[key]
      ? [{ path: `timing.${key}`, before: project.timing[key], after }]
      : [];
  });
  return {
    project: changes.length > 0 ? { ...project, timing } : project,
    changes,
    affectedMessageIds: changes.length > 0 ? project.messages.map((message) => message.id) : [],
  };
}

function applyAppearance(
  project: SvgentProject,
  operation: Extract<ScenePatchOperation, { op: "set-appearance" }>,
): AppliedScenePatch {
  const requested: AppearanceChange = { ...operation.changes };
  // Picking a theme reseeds its colors, the same way selecting one in the
  // Studio does. A color named in the same operation still wins, so an author
  // can switch theme and override one of its seeds at once.
  const preset =
    requested.theme !== undefined && requested.theme !== project.appearance.theme
      ? THEME_PRESETS.find((entry) => entry.id === requested.theme)
      : undefined;
  if (preset) {
    requested.background ??= preset.background;
    requested.accent ??= preset.accent;
    requested.userBubbleColor ??= preset.user;
  }

  const appearance: AppearanceSettings = { ...project.appearance, ...requested };
  const changes = APPEARANCE_KEYS.flatMap((key): PatchChange[] => {
    const before = project.appearance[key];
    const after = appearance[key];
    return before === after ? [] : [{ path: `appearance.${key}`, before, after }];
  });
  return {
    project: changes.length > 0 ? { ...project, appearance } : project,
    changes,
    // Appearance is global, so every message's rendering moves with it.
    affectedMessageIds: changes.length > 0 ? project.messages.map((message) => message.id) : [],
  };
}

function applyOperation(project: SvgentProject, operation: ScenePatchOperation): AppliedScenePatch {
  switch (operation.op) {
    case "set-message-timing":
      return applyMessageTiming(project, operation);
    case "set-message-content":
      return applyMessageContent(project, operation);
    case "set-message-page-break":
      return applyPageBreak(project, operation);
    case "set-project-timing":
      return applyProjectTiming(project, operation);
    case "set-appearance":
      return applyAppearance(project, operation);
  }
}

export function applyScenePatch(
  project: SvgentProject,
  operations: readonly ScenePatchOperation[],
): AppliedScenePatch {
  let current = project;
  const changes: PatchChange[] = [];
  const affectedMessageIds = new Set<string>();
  for (const operation of operations) {
    const applied = applyOperation(current, operation);
    current = applied.project;
    changes.push(...applied.changes);
    for (const messageId of applied.affectedMessageIds) {
      affectedMessageIds.add(messageId);
    }
  }
  return { project: current, changes, affectedMessageIds: [...affectedMessageIds] };
}
