import { draftGraphemeCount } from "./graphemes.js";

export type SurfaceMode = "app" | "tui";
export type FlowMode = "scroll" | "slides";
export type MessageRole =
  | "user"
  | "thinking"
  | "tool"
  | "permission"
  | "assistant"
  | "image"
  | "choice";

export type AttachedImage = {
  dataUrl: string;
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  alt: string;
  /** "cover" crops to the card width; "contain" shows the whole image. */
  fit?: "cover" | "contain";
  /** Which band survives the "cover" crop. Defaults to "center". */
  focus?: "top" | "center" | "bottom";
  /** Banner height preset. Defaults to "standard". */
  size?: "small" | "standard" | "large";
};

/** Per-step pacing used by targeted authoring tools without disturbing the whole scene. */
export type MessageTimingOverride = {
  /** Exact active reveal / dwell time for this message. */
  durationMs?: number;
  /** Exact pause before this message, replacing the inferred conversational handoff. */
  pauseBeforeMs?: number;
  /** Exact settling transition after this message. */
  transitionMs?: number;
};

export const MESSAGE_TIMING_LIMITS = {
  durationMs: { min: 200, max: 30_000 },
  pauseBeforeMs: { min: 0, max: 8_000 },
  transitionMs: { min: 0, max: 3_000 },
} as const;

// ————————————————————————————————————————————————————————————————————————————
// Draft markup: the two ways text reaches a composer without being typed
// straight through, both written as a ruby-like span.
//
//   [[表記|よみ]]   IME conversion — the reading is keyed in kana, pauses,
//                   and is *replaced* by an unrelated written form.
//   {{確定形|入力}} completion — a few characters are typed and the rest
//                   *arrives* on one key: Tab in a terminal, or accepting a
//                   `/`, `@` or `#` reference in an app composer.
//
// The distinction is not decoration: conversion swaps the glyphs, completion
// extends what is already there, so a completion span requires its typed part
// to be a real prefix. That rule is what keeps an authored draft honest, and
// it doubles as the disambiguator — `{{name|upper}}` is a template filter, not
// a completion, and stays literal. Every display surface strips both and shows
// only the finished text.
// ————————————————————————————————————————————————————————————————————————————

/** Which affordance produced a span: an IME conversion, or a completion. */
export type DraftSpanKind = "ime" | "completion";

type DraftSegment = {
  text: string;
  /** What the fingers actually keyed; absent for text typed as-is. */
  typed?: string;
  kind?: DraftSpanKind;
};

// The reading must be pure kana — that is what an IME composes — so code
// like `x[[i|0]]` or wiki-style [[a|b]] text can never be misread as a span.
const IME_READING = /^[ぁ-ゖァ-ヶー]+$/u;
const IME_SPAN = /\[\[([^|\]]+)\|([ぁ-ゖァ-ヶー]+)\]\]/gu;
const COMPLETION_SPAN = /\{\{([^|{}\n\r]+)\|([^|{}\n\r]+)\}\}/gu;
/** Either span, tagged by which delimiter pair matched. */
const DRAFT_SPAN = new RegExp(`${IME_SPAN.source}|${COMPLETION_SPAN.source}`, "gu");
/** A deterministic readability bound for one authored conversion run. */
export const MAX_DRAFT_RUN_CLUSTERS = 28;

/** Build one validated IME conversion span for an authoring UI. */
export function createImeSpan(written: string, reading: string): string | null {
  const normalizedReading = reading.trim();
  if (
    written.length === 0 ||
    written.includes("[") ||
    written.includes("]") ||
    written.includes("|") ||
    written.includes("\n") ||
    written.includes("\r") ||
    !IME_READING.test(normalizedReading) ||
    draftGraphemeCount(normalizedReading) > MAX_DRAFT_RUN_CLUSTERS
  ) {
    return null;
  }
  return `[[${written}|${normalizedReading}]]`;
}

/**
 * Build one validated completion span for an authoring UI. The typed part has
 * to be a shorter prefix of the finished text, because that is what pressing
 * Tab does — anything else would animate a substitution nobody performed.
 */
export function createCompletionSpan(written: string, typed: string): string | null {
  if (
    written.length === 0 ||
    typed.length === 0 ||
    typed.length >= written.length ||
    !written.startsWith(typed) ||
    /[{}|\n\r]/u.test(written)
  ) {
    return null;
  }
  return `{{${written}|${typed}}}`;
}

/** Split content into as-typed runs and spans, in order. */
export function parseDraftSegments(content: string): DraftSegment[] {
  const segments: DraftSegment[] = [];
  let cursor = 0;
  for (const match of content.matchAll(DRAFT_SPAN)) {
    const index = match.index ?? 0;
    const [, imeText, reading, completed, typed] = match;
    // A completion whose typed part is not a prefix is somebody's template
    // syntax, not a span; leave it in the text exactly as written.
    if (completed !== undefined && !isTypedPrefix(completed, typed ?? "")) {
      continue;
    }
    if (index > cursor) {
      segments.push({ text: content.slice(cursor, index) });
    }
    segments.push(
      imeText !== undefined
        ? { text: imeText, typed: reading ?? "", kind: "ime" }
        : { text: completed ?? "", typed: typed ?? "", kind: "completion" },
    );
    cursor = index + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ text: content.slice(cursor) });
  }
  return segments;
}

function isTypedPrefix(written: string, typed: string): boolean {
  return typed.length > 0 && typed.length < written.length && written.startsWith(typed);
}

/** The finished text the transcript shows — markup removed. */
export function stripDraftMarkup(content: string): string {
  return parseDraftSegments(content)
    .map((segment) => segment.text)
    .join("");
}

/** Keystrokes the composer actually performs: spans shrink to what was keyed. */
export function draftTypedText(content: string): string {
  return parseDraftSegments(content)
    .map((segment) => segment.typed ?? segment.text)
    .join("");
}

/** Number of kana→kanji conversions the draft performs. */
export function imeConversionCount(content: string): number {
  return parseDraftSegments(content).filter((segment) => segment.kind === "ime").length;
}

/** Number of completions the draft accepts. */
export function completionCount(content: string): number {
  return parseDraftSegments(content).filter((segment) => segment.kind === "completion").length;
}

export type SessionMessage = {
  id: string;
  role: MessageRole;
  /**
   * For the "tool" role this is one invocation, however many lines it spans:
   * the spinner, the exit code and the duration all describe the whole of it,
   * the way a shell script has a single exit status. Lines are printed with a
   * prompt each because that is what a terminal shows, not because each is
   * separately timed — a sequence that finishes step by step is several tool
   * messages.
   */
  content: string;
  language?: string;
  /**
   * For slides: true forces a page boundary before this message, false
   * suppresses the automatic per-page count from breaking here. Absent
   * means the count decides.
   */
  pageBreakBefore?: boolean;
  /**
   * For "user": how the input reaches the composer. "voice" stages a
   * microphone capture — the App composer shows undulating level bars
   * instead of typed text, then the confirmed transcript sends as usual.
   * The TUI has no microphone affordance, so it renders voice input as
   * ordinary typed input; the divergence is deliberate.
   */
  inputMode?: "voice";
  /**
   * Attached images, rendered as stacked banners in App bubbles and as
   * stub lines in the TUI. The "image" role treats the first entry as
   * its generated result.
   */
  images?: AttachedImage[];
  /** For "permission": how the request resolves. Defaults to "allow". */
  decision?: "allow" | "allow-always" | "deny";
  /**
   * For "choice": the options the agent offers, one per line as
   * `label — hint`. The user picks one of them, or types a reply of their
   * own when `freeform` is set.
   */
  options?: string[];
  /** For "choice": index of the option the user picks. Defaults to 0. */
  chosenIndex?: number;
  /** For "choice": the user answers in their own words instead of picking. */
  freeform?: string;
  /**
   * For "choice" and "permission": what the transcript keeps once the
   * pick lands. The default, "collapse", retires the menu the way live
   * agent UIs do and leaves a one-line record; "keep" holds the full
   * option box on screen, for stills and slides where the menu itself is
   * the subject.
   */
  afterSelection?: "collapse" | "keep";
  /**
   * For "thinking" on the App surface: after the row settles, re-open its
   * status line as a held note below the row, keep it up long enough to
   * read, and fold it back. The replay pauses for the beat — the timeline
   * grows by it — so use it on the step the render is about, once or twice
   * per script. Inert on the TUI surface and in stills.
   */
  highlight?: boolean;
  /** Optional local pacing; absent fields inherit the project-wide timing. */
  timing?: MessageTimingOverride;
};

export type TimingSettings = {
  userTypingCps: number;
  agentTypingCps: number;
  /**
   * The beat before the agent takes the floor after a user action — the
   * "reading your message" pause. 0 plays as machine-instant response.
   * Scales with the transition setting like the other handoffs.
   */
  reactionMs: number;
  thinkingMs: number;
  toolRunMs: number;
  /** How long an "image" message spends in its generating state. */
  imageGenMs: number;
  permissionMs: number;
  transitionMs: number;
  finalHoldMs: number;
};

export type ThemeId = "ink" | "paper" | "nordic" | "phosphor" | "ember" | "synth";

export type ImageSkeletonId = "dots" | "sweep" | "tiles";
const IMAGE_SKELETONS: readonly ImageSkeletonId[] = ["dots", "sweep", "tiles"];

/**
 * Selecting a preset also seeds background/accent so one click restyles the
 * whole scene; both stay editable afterwards.
 */
export const THEME_PRESETS: Array<{
  id: ThemeId;
  label: string;
  background: string;
  accent: string;
  /**
   * User-bubble fill seeded on theme selection, editable afterwards. Each one
   * is its own theme's panel, one step lighter — the same colour family as
   * every surface around it, differing only in lightness, which is how real
   * chat surfaces separate the two speakers.
   *
   * Pulling toward a neutral grey instead looked warm: a grey with equal
   * channels reads yellow beside a UI whose panels and borders all lean cool,
   * and the residual purple put green lowest where the rest of the theme puts
   * it in the middle. Matching the family, not flattening the chroma, is what
   * makes the bubble stop shouting.
   */
  user: string;
}> = [
  { id: "ink", label: "Ink", background: "#090b10", accent: "#8b7cf6", user: "#2a2d34" },
  { id: "paper", label: "Paper", background: "#e9e7e1", accent: "#6a5ae0", user: "#f2f0ea" },
  { id: "nordic", label: "Nordic", background: "#0b1016", accent: "#88b4e7", user: "#2f363f" },
  { id: "phosphor", label: "Phosphor", background: "#010603", accent: "#33ff88", user: "#16241d" },
  { id: "ember", label: "Ember", background: "#070300", accent: "#ffab40", user: "#281f17" },
  { id: "synth", label: "Synth", background: "#0e0715", accent: "#ff7edb", user: "#2f253a" },
];

export type BackdropId = "plain" | "sky" | "peach" | "abyss" | "aurora" | "dawn";

export const BACKDROP_PRESETS: Array<{ id: BackdropId; label: string }> = [
  { id: "plain", label: "Plain" },
  { id: "sky", label: "Sky" },
  { id: "peach", label: "Peach" },
  { id: "abyss", label: "Abyss" },
  { id: "aurora", label: "Aurora" },
  { id: "dawn", label: "Dawn" },
];

/**
 * Canvas shapes, labelled by ratio and annotated with what the ratio is
 * conventionally for — the number alone does not tell an author which one
 * a link preview or a blog header wants.
 */
type SizePreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  hint: Record<"ja" | "en", string>;
};

export const SIZE_PRESETS: SizePreset[] = [
  {
    id: "wide",
    label: "16:9",
    width: 1920,
    height: 1080,
    hint: { ja: "スライド・動画", en: "Slides and video" },
  },
  {
    id: "og",
    label: "1.91:1",
    width: 1200,
    height: 630,
    hint: { ja: "OGP・リンクカード", en: "OGP and link cards" },
  },
  {
    id: "banner",
    label: "3:1",
    width: 1500,
    height: 500,
    hint: { ja: "ブログのヘッダー帯", en: "Blog header strip" },
  },
  {
    id: "square",
    label: "1:1",
    width: 1080,
    height: 1080,
    hint: { ja: "SNS投稿", en: "Social feed post" },
  },
  {
    id: "tall",
    label: "4:5",
    width: 1080,
    height: 1350,
    hint: { ja: "SNS縦長投稿", en: "Tall feed post" },
  },
  {
    id: "phone",
    label: "9:16",
    width: 1080,
    height: 1920,
    hint: { ja: "ストーリー・縦動画", en: "Stories and vertical video" },
  },
  {
    id: "classic",
    label: "4:3",
    width: 1600,
    height: 1200,
    hint: { ja: "資料・埋め込み", en: "Docs and embeds" },
  },
];

export type AppearanceSettings = {
  theme: ThemeId;
  canvasWidth: number;
  canvasHeight: number;
  transparentCanvas: boolean;
  terminalOpacity: number;
  background: string;
  accent: string;
  /** Decorative canvas backdrop behind the floating window. */
  backdrop: BackdropId;
  /** User-supplied image behind the window; overrides the backdrop preset. */
  backdropImage?: AttachedImage;
  /** Generating-state skeleton style for image messages. */
  imageSkeleton: ImageSkeletonId;
  /** Window drop-shadow strength, 0 (off) .. 1. */
  shadowStrength: number;
  /** Gap between the floating window and the canvas edge, px. */
  windowMargin: number;
  /**
   * Room between the window frame and the transcript inside it. The pair to
   * windowMargin: that one is the gap outside the window, this one the gap
   * within it. Split by axis because the two are not interchangeable — a
   * terminal wants more room at the sides than above, and the surfaces had
   * drifted to different values for each.
   *
   * A real terminal's padding is an emulator setting that does not follow the
   * font size; these do, so an enlarged transcript keeps its proportion.
   */
  windowPaddingX: number;
  windowPaddingY: number;
  /** User message bubble fill. Theme selection reseeds it. */
  userBubbleColor: string;
  /** Transcript text scale multiplier (1 = 13px TUI cells / 14px app prose). */
  fontScale: number;
  /**
   * Window chrome scale (header, footer, composer buttons, model label),
   * managed separately from fontScale so SNS-size transcripts can keep the
   * chrome legible too.
   */
  chromeScale: number;
  /**
   * Roominess of the transcript's own spacing — text to bubble edge, bubble to
   * window edge — as a multiplier on top of the size-derived baseline. Distinct
   * from windowMargin, which is the gap outside the window rather than inside
   * it. 1 is the tuned default at every font size.
   */
  spacingScale: number;
  /**
   * Where the transcript sits when it does not fill the viewport. "start" is
   * how a chat and a terminal actually fill — from the top — and stays the
   * default; "center" composes the frame instead, for artwork rather than a
   * simulated session.
   */
  contentAlign: ContentAlign;
  /**
   * Where a message card sits across its row. "role" is the chat convention
   * the app surface is built on — the user's own words hang right, the agent's
   * run from the left — and stays the default. "center" places every card in
   * the middle instead, for a frame composed as artwork rather than read as a
   * conversation. The terminal has no such divergence to correct: it prints
   * from column 0 whoever is speaking, so this does not apply there.
   */
  messageAlign: MessageAlign;
  /**
   * Whether an agent message sits on a surface of its own. Real agent UIs are
   * not agreed on this — some set the reply as plain text on the page and let
   * the user's bubble carry the whole distinction, others give it a quiet slab
   * — so it is a choice rather than a fidelity question. "card" keeps svgent's
   * own look and stays the default; "plain" reads closer to a chat, and gives
   * a composed frame one less box to fight with.
   */
  assistantSurface: AssistantSurface;
};

export type AssistantSurface = "card" | "plain";

export type ContentAlign = "start" | "center";
export type MessageAlign = "role" | "center";

export type FontSlot = "sans" | "mono";

/**
 * Scene nodes reference fonts by these fixed aliases, so swapping the
 * underlying binary restyles every scene without touching scene code.
 */
export const FONT_ALIAS: Record<FontSlot, string> = {
  sans: "NotoSansJP",
  mono: "JetBrainsMono",
};

/**
 * Aliases the bundled fonts are registered under in addition to whatever the
 * project chose. A Google subset only carries the characters that were asked
 * for and an uploaded font carries whatever it happens to carry, so every
 * text run ends its fallback chain at the fonts that ship with svgent rather
 * than at a tofu box.
 */
export const FALLBACK_FONT_ALIAS: Record<FontSlot, string> = {
  sans: "svgent-fallback-sans",
  mono: "svgent-fallback-mono",
};

type EngineFont = {
  alias: string;
  weight: number;
  style: "normal";
  data: Uint8Array;
};

/**
 * The bundled pair under the fallback aliases, which every engine must
 * register: the scene's fallback chains name them, and boundsvg rejects a
 * scene that references an alias no font was registered for. The caller
 * supplies the loader because the browser fetches these and Node reads them.
 */
export async function bundledFallbackFonts(
  load: (slot: FontSlot) => Promise<Uint8Array>,
): Promise<EngineFont[]> {
  const [sans, mono] = await Promise.all([load("sans"), load("mono")]);
  return [
    { alias: FALLBACK_FONT_ALIAS.sans, weight: 400, style: "normal", data: sans },
    { alias: FALLBACK_FONT_ALIAS.mono, weight: 400, style: "normal", data: mono },
  ];
}

export type FontChoice =
  | { source: "bundled" }
  | { source: "google"; family: string }
  | { source: "upload"; fileName: string };

export type FontsSettings = Record<FontSlot, FontChoice>;

/** User-editable status chrome baked into the scene. */
export type ChromeSettings = {
  /** Shown as "context N%" in the status line. */
  contextPercent: number;
  /** Session clock start, "H:MM" 24h. */
  clockTime: string;
};

export type PaginationSettings = {
  flow: FlowMode;
  messagesPerPage: number;
  scrollDistancePx: number;
};

/**
 * Deterministic camera work over the session window. The plan targets the
 * active message and is computed from the timeline before rendering, so
 * preview and every export share the exact same moves. Off by
 * default. Both surfaces honour it: svgent stages a simulation demo, not a
 * faithful terminal, so the TUI leans in the same way the App does.
 */
export type CameraSettings = {
  follow: boolean;
  /** How far the camera leans in while following. */
  zoom: number;
  /**
   * How the camera lands relative to its event. "sync" arrives with the
   * event (invisible camera work, the default), "anticipate" arrives
   * first like a staged lecture, "trail" chases it like a live recording.
   */
  style: CameraStyle;
  /**
   * Skip shots the camera could not hold this long — a lean-in on a
   * subject that yields the floor a beat later reads as a there-and-back
   * twitch, not a look. 0 (the default) keeps every shot; shots that ride
   * a streaming reveal are never skipped, because their motion is the
   * point.
   */
  minShotMs: number;
};

export type CameraStyle = "anticipate" | "sync" | "trail";

export const CAMERA_ZOOM_MIN = 1.2;
export const CAMERA_ZOOM_MAX = 2.5;

/**
 * The threshold the Studio's "suppress brief moves" toggle writes into
 * `camera.minShotMs`. One glide is 620ms: a shot that cannot hold about
 * twice that reads as a there-and-back twitch rather than a look. The
 * schema itself takes any 0–4000ms value; this is only the curated
 * one-switch setting.
 */
export const CAMERA_MIN_SHOT_PRESET_MS = 1_200;

/**
 * Which chrome elements the scene renders. The SIMULATED disclosure lives in
 * canvas metadata and is not affected by any of these — it always ships.
 * The header splits into icons and text so a window can keep its app-like
 * dressing (traffic lights / action buttons) while dropping the small print.
 */
export type DisplaySettings = {
  /**
   * The header region itself. Off removes the band, whatever is in it; the
   * two keys below choose what a shown band carries. Kept apart because a
   * region and its contents are different questions, and answering the
   * second one twice used to be the only way to ask the first.
   */
  header: boolean;
  /** Header action buttons (app) / traffic-light dots (tui). */
  headerIcons: boolean;
  /** Header title, workspace line, and clock (app) / title text (tui). */
  headerText: boolean;
  /** Composer (app) / prompt box with its status lines (tui). */
  composer: boolean;
  /** Bottom version/status line. */
  footer: boolean;
  /** Terminal geometry chip (`146×24`) in the TUI title bar. */
  tuiGeometry: boolean;
  /** Session title in the TUI title bar. */
  tuiTitle: boolean;
  /** Session clock at the TUI title bar's end. */
  tuiClock: boolean;
  /**
   * `? for shortcuts` in the TUI prompt's status row. Off by default:
   * current terminal agents don't show it, so the decoration reads as
   * dated unless a script asks for it. Terminal geometry stays a header
   * concern (tuiGeometry) and never repeats here.
   */
  tuiStatusHints: boolean;
  /** The product name (and version) wherever chrome prints it. */
  productMark: boolean;
  /** The version suffix on the product mark. */
  productVersion: boolean;
};

/**
 * What the script claims to be. "fictional" is an invented conversation;
 * "reenactment" is a sanitized summary of a session the author explicitly
 * supplied. The declaration is deliberate opt-in: undeclared scripts are
 * fictional, and only a declared reenactment may carry a real model name —
 * forcing a fictional label onto a faithful summary would itself be a
 * false label. Neither basis weakens the sanitization requirements, and
 * every artifact still records that it is an authored rendering.
 */
export type ScriptBasis = "fictional" | "reenactment";

export type SvgentProject = {
  version: 1;
  title: string;
  surface: SurfaceMode;
  basis: ScriptBasis;
  modelLabel: string;
  workspaceLabel: string;
  branchLabel: string;
  appearance: AppearanceSettings;
  chrome: ChromeSettings;
  display: DisplaySettings;
  fonts: FontsSettings;
  timing: TimingSettings;
  pagination: PaginationSettings;
  camera: CameraSettings;
  messages: SessionMessage[];
};

/**
 * At or above this user typing speed the composer renders the draft as a
 * paste — the whole text lands at once — because typewriter animation this
 * fast only ever looks fake.
 */
export const PASTE_TYPING_CPS = 40;

export const SIMULATION_BADGE = "SIMULATED SESSION · FICTIONAL CONVERSATION";
export const REENACTMENT_BADGE = "SIMULATED SESSION · AUTHORED REENACTMENT";
export const SAFE_MODEL_LABEL = "Bezier 4";

/**
 * Disclosure line stamped into every artifact. Both wordings assert the
 * same non-negotiable fact — the output is an authored rendering, never a
 * screen capture — while only claiming "fictional" when the script says so.
 */
export function disclosureFor(basis: ScriptBasis): string {
  return basis === "reenactment" ? REENACTMENT_BADGE : SIMULATION_BADGE;
}
export const MAX_MESSAGES = 12;
export const MAX_MESSAGE_CHARS = 2_400;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_IMAGES = 4;
/** Roles whose attached images actually render on a surface. */
export const IMAGE_ROLES: readonly MessageRole[] = ["user", "assistant", "image"];

export type ModelLabelIssueCode = "empty" | "too-long";

/**
 * Shape checks only. svgent deliberately does not police model names: a
 * denylist of real products is unbounded and permanently stale, and it
 * would only cover this one field anyway. The artifact's nature is
 * carried by provenance — `simulated=true` plus the `model-kind` basis
 * declaration — not by label lists.
 */
export function modelLabelIssue(modelLabel: string): ModelLabelIssueCode | null {
  const normalized = modelLabel.trim();
  if (normalized.length === 0) {
    return "empty";
  }
  if (normalized.length > 40) {
    return "too-long";
  }
  return null;
}

export function resolveSafeModelLabel(modelLabel: string): string {
  return modelLabelIssue(modelLabel) === null ? modelLabel.trim() : SAFE_MODEL_LABEL;
}

/** Random 8-character message-id token. */
export function messageIdToken(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function createMessage(
  role: MessageRole,
  index: number,
  lang: "ja" | "en" = "ja",
): SessionMessage {
  const labels: Record<"ja" | "en", Record<MessageRole, string>> = {
    ja: {
      user: "変更したい内容を入力",
      thinking: "関連する実装と制約を確認しています",
      tool: 'rg -n "target" src tests',
      permission: "対象ファイルを編集してテストを実行します",
      assistant: "実装内容を **Markdown** で説明します。",
      image: "夕暮れの海辺を歩く旅人の水彩イラスト",
      choice: "どの方針で進めますか?",
    },
    en: {
      user: "Describe the change you want",
      thinking: "Reviewing related code and constraints",
      tool: 'rg -n "target" src tests',
      permission: "Edit the target files and run the tests",
      assistant: "Explain the implementation in **Markdown**.",
      image: "A watercolor illustration of a traveler on a beach at dusk",
      choice: "How should I proceed?",
    },
  };
  const choiceSeed =
    role === "choice"
      ? {
          options:
            lang === "ja"
              ? ["このまま進める — 追加の変更なし", "先に確認する — 影響範囲を調べる"]
              : ["Go ahead — no extra changes", "Check first — look at the blast radius"],
          chosenIndex: 0,
        }
      : {};
  return {
    id: `message-${messageIdToken()}-${index}`,
    role,
    content: labels[lang][role],
    ...choiceSeed,
  };
}

/**
 * The blank-slate template script: placeholder marks (〇〇 topic, □□
 * target, △△ detail) across every element. Doubles as the first-visit
 * sample so a fresh studio opens ready to be replaced, not compared.
 */
// Preset scripts are translation pairs: Japanese is the source and English
// follows it, subject, title and labels included, so a drift between them is
// something you can see and fix. What only one language can demonstrate stays
// on that side — ruby and IME conversion in Japanese, long-word wrapping and
// English typesetting in English — and has no counterpart by design.

const TEMPLATE_MESSAGES: Array<Omit<SessionMessage, "id">> = [
  { role: "user", content: "〇〇を[[修正|しゅうせい]]して。△△も[[見て|みて]]おいて。" },
  { role: "thinking", content: "関連する実装と制約を確認しています" },
  { role: "tool", language: "bash", content: 'rg -n "〇〇" src/' },
  {
    role: "choice",
    content: "どの方針で進めますか?",
    options: ["〇〇で進める — △△が利点", "□□を先に確認する — △△を避けられる"],
    chosenIndex: 0,
  },
  { role: "permission", content: "□□ を編集してテストを実行します" },
  {
    role: "assistant",
    content: [
      "## 〇〇の結果",
      "",
      "- **〇〇**: △△でした",
      "- `□□` に △△ を追加",
      "",
      "```diff",
      "- 〇〇(古い記述)",
      "+ △△(新しい記述)",
      "```",
    ].join("\n"),
  },
  {
    role: "image",
    content: "〇〇のイメージ、△△な雰囲気",
  },
  {
    role: "assistant",
    content: ["> △△という注意点があります。", "", "次は**〇〇**もできます。"].join("\n"),
  },
];

// The English scaffold swaps the 〇〇/□□/△△ marks for word placeholders —
// fullwidth boxes read as mojibake to readers who never met them.
const TEMPLATE_MESSAGES_EN: Array<Omit<SessionMessage, "id">> = [
  { role: "user", content: "Fix TOPIC. While you're in there, check DETAIL too." },
  { role: "thinking", content: "Scanning the related code and constraints" },
  { role: "tool", language: "bash", content: 'rg -n "TOPIC" src/' },
  {
    role: "choice",
    content: "Which way should we go?",
    options: ["Go with TOPIC — DETAIL is the upside", "Check TARGET first — avoids DETAIL"],
    chosenIndex: 0,
  },
  { role: "permission", content: "Edit TARGET and run the tests" },
  {
    role: "assistant",
    content: [
      "## TOPIC results",
      "",
      "- **TOPIC**: turned out to be DETAIL",
      "- Added DETAIL to `TARGET`",
      "",
      "```diff",
      "- TOPIC (the old line)",
      "+ DETAIL (the new line)",
      "```",
    ].join("\n"),
  },
  {
    role: "image",
    content: "An image of TOPIC with a DETAIL mood",
  },
  {
    role: "assistant",
    content: ["> One caveat: DETAIL.", "", "Next we can take on **TOPIC** as well."].join("\n"),
  },
];

export const DEFAULT_PROJECT: SvgentProject = {
  version: 1,
  title: "〇〇のセッション",
  surface: "app",
  basis: "fictional",
  modelLabel: "Bezier 4",
  workspaceLabel: "you/〇〇",
  branchLabel: "feat/〇〇",
  appearance: {
    theme: "ink",
    canvasWidth: 1920,
    canvasHeight: 1080,
    transparentCanvas: false,
    terminalOpacity: 1,
    background: "#090b10",
    accent: "#8b7cf6",
    backdrop: "sky",
    imageSkeleton: "dots",
    shadowStrength: 0.6,
    windowMargin: 64,
    windowPaddingX: 20,
    windowPaddingY: 14,
    userBubbleColor: "#2a2d34",
    fontScale: 1.5,
    chromeScale: 1,
    spacingScale: 1,
    contentAlign: "start",
    messageAlign: "role",
    assistantSurface: "card",
  },
  chrome: {
    contextPercent: 18,
    clockTime: "10:00",
  },
  display: {
    header: true,
    headerIcons: true,
    headerText: true,
    composer: true,
    footer: true,
    tuiGeometry: true,
    tuiTitle: false,
    tuiClock: false,
    tuiStatusHints: false,
    productMark: true,
    productVersion: true,
  },
  fonts: {
    sans: { source: "bundled" },
    mono: { source: "bundled" },
  },
  timing: {
    userTypingCps: 10,
    agentTypingCps: 42,
    reactionMs: 750,
    thinkingMs: 1_800,
    toolRunMs: 1_250,
    imageGenMs: 2_800,
    permissionMs: 2_000,
    transitionMs: 260,
    finalHoldMs: 1_600,
  },
  pagination: {
    flow: "scroll",
    messagesPerPage: 4,
    scrollDistancePx: 0,
  },
  camera: {
    follow: false,
    zoom: 1.6,
    style: "sync",
    minShotMs: 0,
  },
  messages: TEMPLATE_MESSAGES.map((message, index) => ({
    id: `template-${index}`,
    ...message,
  })),
};

/**
 * First-visit project for a UI language. Each language opens on its own
 * authored scaffold, so the first conversation a visitor sees is in the
 * language their browser asked for.
 */
export function defaultProjectFor(lang: "ja" | "en"): SvgentProject {
  if (lang === "ja") {
    return DEFAULT_PROJECT;
  }
  return {
    ...DEFAULT_PROJECT,
    title: "TOPIC session",
    workspaceLabel: "you/TOPIC",
    branchLabel: "feat/TOPIC",
    messages: TEMPLATE_MESSAGES_EN.map((message, index) => ({
      id: `template-${index}`,
      ...message,
    })),
  };
}

// ————————————————————————————————————————————————————————————————————————————
// Display presets
// ————————————————————————————————————————————————————————————————————————————

/**
 * One-click bundles named after what they change, not where you might post
 * them. Sizing presets touch fontScale/chromeScale, element presets touch
 * only the display flags, and each declares exactly the fields it sets —
 * everything else (theme colors, canvas, timing) stays put and every knob
 * remains individually adjustable afterwards. "reset" restores the defaults.
 */
type DisplayPreset = {
  id:
    | "reset"
    | "huge-text"
    | "large-text"
    | "compact"
    | "frame-only"
    | "conversation-only"
    | "headline"
    | "one-exchange";
  label: Record<"ja" | "en", string>;
  description: Record<"ja" | "en", string>;
  apply: {
    fontScale?: number;
    chromeScale?: number;
    spacingScale?: number;
    contentAlign?: ContentAlign;
    messageAlign?: MessageAlign;
    assistantSurface?: AssistantSurface;
    display?: DisplaySettings;
  };
};

export const DISPLAY_PRESETS: DisplayPreset[] = [
  {
    id: "reset",
    label: { ja: "標準サイズ", en: "Default sizing" },
    description: {
      ja: "文字・UIサイズ・余白・配置と表示要素を既定値に戻します(色やフォントは対象外。すべて戻すにはタブ下部の「見た目を初期化」)",
      en: "Returns sizing, spacing, placement and visible elements to their defaults (colors and fonts are untouched — for everything, use Reset appearance at the foot of the tab)",
    },
    apply: {
      fontScale: DEFAULT_PROJECT.appearance.fontScale,
      chromeScale: DEFAULT_PROJECT.appearance.chromeScale,
      spacingScale: DEFAULT_PROJECT.appearance.spacingScale,
      contentAlign: DEFAULT_PROJECT.appearance.contentAlign,
      messageAlign: DEFAULT_PROJECT.appearance.messageAlign,
      assistantSurface: DEFAULT_PROJECT.appearance.assistantSurface,
      display: { ...DEFAULT_PROJECT.display },
    },
  },
  {
    id: "huge-text",
    label: { ja: "文字を特大に", en: "Huge text" },
    description: {
      ja: "タイムラインのサムネイル縮小でも読める特大サイズへ一括拡大。表示できる文字量は減ります。要素はすべて表示",
      en: "Scales everything up so even feed thumbnails stay readable; fits less text. All elements shown",
    },
    apply: {
      fontScale: 1.9,
      chromeScale: 1.9,
      display: {
        ...DEFAULT_PROJECT.display,
        headerIcons: true,
        headerText: true,
        composer: true,
        footer: true,
      },
    },
  },
  {
    id: "large-text",
    label: { ja: "文字を大きめに", en: "Larger text" },
    description: {
      ja: "スマホ縦画面でフル表示するSNS投稿向け。文字量を保ちながら一回り拡大します。要素はすべて表示",
      en: "For posts viewed full-screen in phone portrait: one notch larger while keeping more text on screen. All elements shown",
    },
    apply: {
      fontScale: 1.65,
      chromeScale: 1.5,
      display: {
        ...DEFAULT_PROJECT.display,
        headerIcons: true,
        headerText: true,
        composer: true,
        footer: true,
      },
    },
  },
  {
    id: "compact",
    label: { ja: "小さく詰める", en: "Compact" },
    description: {
      ja: "文字を小さめにし、入力欄とフッターを省いて会話を密に(READMEなど文書への貼り込み向け)",
      en: "Smaller type with the composer and footer dropped — dense enough to sit inside a doc",
    },
    apply: {
      fontScale: 1.2,
      chromeScale: 0.9,
      display: {
        ...DEFAULT_PROJECT.display,
        headerIcons: true,
        headerText: true,
        composer: false,
        footer: false,
      },
    },
  },
  {
    id: "frame-only",
    label: { ja: "枠とアイコンだけ", en: "Frame & icons" },
    description: {
      ja: "ウィンドウ枠とヘッダーのアイコンは残し、細かい文字・入力欄・フッターを非表示にします。サイズは変えません",
      en: "Keeps the window frame and header icons, hides the small print, composer, and footer. Sizes untouched",
    },
    apply: {
      display: {
        ...DEFAULT_PROJECT.display,
        headerIcons: true,
        headerText: false,
        composer: false,
        footer: false,
      },
    },
  },
  {
    id: "conversation-only",
    label: { ja: "会話だけ", en: "Conversation only" },
    description: {
      ja: "クロームをすべて外して会話だけを表示します(サイト埋め込みなど)。サイズは変えません",
      en: "Strips every chrome element so only the conversation remains (e.g. site embeds). Sizes untouched",
    },
    apply: {
      display: {
        ...DEFAULT_PROJECT.display,
        header: false,
        headerIcons: false,
        headerText: false,
        composer: false,
        footer: false,
      },
    },
  },
  // The two below treat the canvas as artwork rather than as a session
  // window: a header image is read at a glance and at a distance, so the
  // type carries the frame and the chrome would only be noise.
  {
    id: "headline",
    label: { ja: "見出し1行", en: "Headline" },
    description: {
      ja: "1メッセージを特大文字で見出しとして使う設定。クロームをすべて外します(ブログのヘッダー帯・OGP向け)",
      en: "One message set as an oversized headline with every chrome element removed (blog headers, OGP)",
    },
    apply: {
      fontScale: 4,
      chromeScale: 1,
      spacingScale: 1.2,
      contentAlign: "center",
      messageAlign: "center",
      display: {
        ...DEFAULT_PROJECT.display,
        header: false,
        headerIcons: false,
        headerText: false,
        composer: false,
        footer: false,
      },
    },
  },
  {
    id: "one-exchange",
    label: { ja: "1往復を大きく", en: "One exchange" },
    description: {
      ja: "ユーザー1・エージェント1程度を大きく見せる設定。ヘッダーだけ残します(記事のアイキャッチ向け)",
      en: "Sized for roughly one user and one agent message, keeping only the header (article hero images)",
    },
    apply: {
      fontScale: 2.6,
      chromeScale: 1.4,
      spacingScale: 1.1,
      contentAlign: "center",
      display: {
        ...DEFAULT_PROJECT.display,
        headerIcons: true,
        headerText: true,
        composer: false,
        footer: false,
      },
    },
  },
];

// ————————————————————————————————————————————————————————————————————————————
// Chat-assisted authoring. No LLM API is integrated — the user carries a
// prompt to their own chat tool and pastes the reply back; the importer's
// clamping/merging pipeline absorbs model sloppiness.
// ————————————————————————————————————————————————————————————————————————————

/** Prompt handed to an external chat model to write a script for a theme. */
export function buildScriptPrompt(theme: string, lang: "ja" | "en"): string {
  const topic = theme.trim();
  if (lang === "en") {
    return `Write a fictional coding-agent session script as JSON.

Topic: ${topic || "(pick an interesting, realistic coding task)"}

Rules:
- Output ONLY the JSON, as a single code block, no commentary
- roles: "user" (request), "thinking" (one short line), "tool" (a shell command), "permission" (the action being approved), "assistant" (Markdown allowed: headings, bullet lists, fenced code), "image" (an image-generation step; content = the generation prompt), "choice" (an option menu)
- One tool message is one invocation: its spinner, exit code and duration cover the whole of it. Use several lines ("\\n") only when they run as one script; to show commands finishing one after another, use several tool messages
- Per-message extras: "language" on a tool message names the code-fence language; "decision" on a permission message is "allow", "allow-always", or "deny"; "options" (up to 5, each "label — hint") plus "chosenIndex" or "freeform" on a choice message; "inputMode": "voice" on a user message stages it as dictated rather than typed; "highlight": true on a thinking message re-opens its status line as a held note below the row, then folds it back — one beat on the step the render is about, at most one or two per script
- Commands in a script are read and retyped by whoever sees the artifact, so never show one that fetches or runs code from a package registry: no \`npm i\`, \`npx\`, \`pnpm dlx\`, \`pip install\`, \`cargo install\`, \`brew install\`, or \`curl ... | sh\`, not even for a real and well-known package. Popularity is not safety — a compromised release arrives under the correct name. Local commands are fine (\`pnpm test\`, \`rg\`, \`git\`, project scripts). Use only reserved example domains (\`example.com\`), and no e-mail addresses, IP addresses or token-shaped strings
- Do NOT attach images. An image message renders a built-in placeholder, so content is the prompt alone
- Do NOT set appearance, timing, pagination, camera, display or basis — the app owns how it looks and how it is declared
- Keep user lines short and casual
- A user line may stage a completion with {{finished|typed}}: the typed part is keyed, the rest arrives on one key. The typed part MUST be a shorter prefix of the finished text. Use it only where a completer exists — a command, path or flag in the terminal (\`{{pnpm typecheck|pnpm ty}}\`), or a /command, @file or #reference in the app (\`{{@src/config.ts|@src/co}}\`). Never on ordinary prose words: no composer completes those. At most one or two per script
- 4-10 messages in a natural flow (user -> thinking -> tool -> ... -> assistant)
- Keep each message under 2400 characters and the whole script under 3000
- modelLabel must be a fictional model name (no real AI product names)
- For non-development topics, set workspaceLabel and branchLabel to "" (they are hidden when empty)

Characters — anything outside these renders as an empty box:
- No emoji or pictographs of any kind
- Latin letters, digits, ASCII punctuation, and accented Latin (é, ü, ñ) are safe
- Do not mix in other scripts: no Hangul, Cyrillic, Greek, Thai, Devanagari, or CJK beyond what a rule below allows
- Box-drawing and block characters are unnecessary; write shell output as plain text

Format:
{"version":1,"title":"...","surface":"app","modelLabel":"...","workspaceLabel":"owner/repo-like","branchLabel":"feat/...","messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
"surface" may be "app" (GUI chat) or "tui" (terminal).`;
  }
  return `創作のcoding-agentセッション台本をJSONで作成してください。

お題: ${topic || "(面白そうで現実的なコーディングタスクを1つ選ぶ)"}

ルール:
- 出力はJSONのみ。コードブロック1つで、前後の説明文は不要
- roles: "user"(依頼) / "thinking"(短い思考1行) / "tool"(シェルコマンド) / "permission"(承認する操作の説明) / "assistant"(Markdown可: 見出し・箇条書き・\`\`\`コード) / "image"(画像生成ステップ: contentは生成プロンプト) / "choice"(選択肢の提示)
- tool 1件 = 実行1回。スピナー・終了コード・所要時間はその全体に対して1組つく。複数行("\\n")は1つのスクリプトとしてまとめて走る場合だけにして、順に実行される様子を見せたいときは tool を複数件に分ける
- メッセージ単位の任意項目: toolには "language"(コードフェンス言語)、permissionには "decision"("allow" / "allow-always" / "deny")、choiceには "options"(「選択肢 — 補足」を最大5件)と "chosenIndex" または "freeform"、userには "inputMode": "voice"(音声入力として演出)、thinkingには "highlight": true(行の下に思考の一行をメモとして開いて保持し、畳んで戻す。見せ場の1手にだけ付け、台本あたり1〜2箇所まで)
- 台本のコマンドは、成果物を見た人が読んで打ち直す。**パッケージレジストリから取得・実行するコマンドは書かないこと** — \`npm i\` / \`npx\` / \`pnpm dlx\` / \`pip install\` / \`cargo install\` / \`brew install\` / \`curl ... | sh\` は、実在の著名パッケージであっても不可。有名であることは安全の保証にならず、侵害されたリリースは正しい名前で届く。ローカルで完結するコマンド(\`pnpm test\`、\`rg\`、\`git\`、リポジトリのスクリプト)は可。URLは予約ドメイン(\`example.com\`)のみ。メールアドレス・IPアドレス・トークン様の文字列も書かない
- 画像は添付しないこと。image ロールは同梱のプレースホルダで描画されるので、contentに生成プロンプトを書くだけでよい
- appearance / timing / pagination / camera / display / basis は書かないこと(見た目と宣言はアプリ側が持つ)
- userのcontentは短く口語で。漢字語には [[表記|よみ]] を1〜2箇所入れるとIME変換の入力演出になる(よみは仮名のみ。例: [[説明|せつめい]])
- {{確定形|入力}} は補完の演出。入力側を打ったところで残りが1キーで入る。**入力側は確定形の前方一致でなければならない**。補完器がある対象にだけ使う — ターミナルのコマンド・パス・フラグ(\`{{pnpm typecheck|pnpm ty}}\`)、アプリの /コマンド・@ファイル・#参照(\`{{@src/config.ts|@src/co}}\`)。普通の単語には使わない(そこを補完する入力欄は存在しない)。1台本に1〜2箇所まで
- messagesは4〜10件、自然な流れで(user → thinking → tool → … → assistant)
- 各メッセージ2400字以内、全体で3000字以内
- modelLabelは創作上のモデル名(実在のAI製品名は不可)
- 開発と関係ないお題ではworkspaceLabelとbranchLabelは""でよい(空なら非表示になる)

使える文字 — 以下から外れると空の四角(豆腐)で描画されます:
- 絵文字・アイコン類は一切使わない
- 漢字は常用漢字の範囲で。それ以外はひらがな・カタカナで書く
- ラテン文字・数字・ASCII記号、および全角の句読点や括弧は安全
- 他の文字体系を混ぜない(ハングル、キリル、ギリシャ、タイ、デーヴァナーガリー等)
- 罫線素片やブロック文字は不要。シェル出力はプレーンテキストで書く

形式:
{"version":1,"title":"...","surface":"app","modelLabel":"...","workspaceLabel":"owner/repo風","branchLabel":"feat/...","messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
"surface" は "app"(GUIチャット) か "tui"(ターミナル)。`;
}

/** The span from the first brace to the last, or null when there is none. */
function outermostBraces(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start < 0 || end <= start ? null : text.slice(start, end + 1);
}

/** Parses, and carries the one field that tells a script from any other JSON. */
function isScriptJson(json: string): boolean {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) && Array.isArray(parsed.messages);
  } catch {
    return false;
  }
}

/**
 * The balanced `{…}` starting at `start`, or null if it never closes.
 * Braces inside string literals do not count, so a command or a nested
 * code sample in the script's own text cannot end the span early.
 */
function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
    } else if (inString && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    } else if (!inString && char === "{") {
      depth += 1;
    } else if (!inString && char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

/**
 * Salvage the script JSON out of a chat reply.
 *
 * Fence matching cannot do this job: the prompt invites assistant messages
 * to carry fenced code, so the script's own text may contain ``` — which
 * makes "the first fenced block" land inside the payload and truncate it —
 * and a reply may legitimately hold other JSON that is part of the story.
 * So the reply is scanned for balanced objects instead, and a candidate
 * has to parse and carry a `messages` array to win.
 */
export function extractScriptJson(text: string): string | null {
  // Kept only for the error path: the longest well-formed object that is
  // not a script still gives the importer something specific to report.
  let fallback: string | null = null;
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    const span = balancedObjectAt(text, index);
    if (span === null) {
      continue;
    }
    if (isScriptJson(span)) {
      return span;
    }
    if (fallback === null || span.length > fallback.length) {
      fallback = span;
    }
  }
  return fallback ?? outermostBraces(text);
}

// ————————————————————————————————————————————————————————————————————————————
// Timing presets
// ————————————————————————————————————————————————————————————————————————————

/**
 * Pacing presets, split by concern so one choice never silently rewrites
 * another axis: how the user types, how the model behaves, and the
 * scene-wide tempo. Every slider stays adjustable afterwards.
 */
export type TimingPreset = {
  id: string;
  label: Record<"ja" | "en", string>;
  description: Record<"ja" | "en", string>;
  apply: Partial<TimingSettings>;
};

/** How the user's side of the conversation is entered. */
export const USER_INPUT_PRESETS: TimingPreset[] = [
  {
    id: "typed",
    label: { ja: "標準", en: "Standard" },
    description: {
      ja: "リアルな手入力速度(既定)。IME変換の [[表記|よみ]] とも好相性",
      en: "Realistic hand typing (default) — pairs well with IME [[表記|よみ]] spans",
    },
    apply: { userTypingCps: 10 },
  },
  {
    id: "typed-fast",
    label: { ja: "急いで手打ち", en: "Fast typing" },
    description: {
      ja: "タッチタイピングの速い人の手入力。IME変換もきびきび進む",
      en: "A quick touch-typist — IME conversions land briskly too",
    },
    apply: { userTypingCps: 25 },
  },
  {
    id: "typed-slow",
    label: { ja: "のんびり手打ち", en: "Slow typing" },
    description: {
      ja: "迷いながらゆっくり打つ体。長めの依頼文向け",
      en: "Hesitant, deliberate keystrokes — suits longer requests",
    },
    apply: { userTypingCps: 6 },
  },
  {
    id: "paste",
    label: { ja: "貼り付け", en: "Pasted" },
    description: {
      ja: "用意したプロンプトを貼り付けた体: 全文が一度に現れて送信",
      en: "A prepared prompt pasted in: the draft lands at once",
    },
    apply: { userTypingCps: 60 },
  },
];

/**
 * How the agent's side of the exchange runs: how fast it streams, how long
 * it thinks, how long its tools and image generation take. The dwell before
 * a permission or a choice is answered belongs to the person answering, not
 * to this, so it is not one of these — the card is the agent's to offer and
 * the decision is the reader's to make.
 */
export const AGENT_BEHAVIOR_PRESETS: TimingPreset[] = [
  {
    id: "standard",
    label: { ja: "標準", en: "Standard" },
    description: {
      ja: "思考・ツール・生成すべて中庸の既定バランス",
      en: "The default balance of thinking, tools, and generation",
    },
    apply: {
      agentTypingCps: 42,
      thinkingMs: 1_800,
      toolRunMs: 1_250,
      imageGenMs: 2_800,
    },
  },
  {
    id: "think-fast",
    label: { ja: "熟考して一気に", en: "Think long, answer fast" },
    description: {
      ja: "思考とツール実行は長め、生成は高速。最近の高速モデルのリアルな挙動",
      en: "Long thinking and tool runs, then rapid generation — how recent fast models feel",
    },
    apply: {
      agentTypingCps: 220,
      thinkingMs: 3_500,
      toolRunMs: 2_600,
      imageGenMs: 3_400,
    },
  },
  {
    id: "think-slow",
    label: { ja: "熟考してじっくり", en: "Think long, stream slow" },
    description: {
      ja: "思考も生成もゆっくり。ローカルモデルや初期LLMのリアルな挙動",
      en: "Slow thinking and slow streaming — local or early models",
    },
    apply: {
      agentTypingCps: 35,
      thinkingMs: 4_000,
      toolRunMs: 2_600,
      imageGenMs: 4_200,
    },
  },
  {
    id: "swift",
    label: { ja: "軽快", en: "Swift" },
    description: {
      ja: "思考もツール実行も短く、生成は高速。デモのテンポ作りに",
      en: "Short thinking and tool runs with rapid generation — good demo tempo",
    },
    apply: {
      agentTypingCps: 280,
      thinkingMs: 700,
      toolRunMs: 500,
      imageGenMs: 1_200,
    },
  },
];

/** Everything that is neither side of the conversation: scene tempo. */
export const SCENE_PACING_PRESETS: TimingPreset[] = [
  {
    id: "standard",
    label: { ja: "標準", en: "Standard" },
    description: {
      ja: "message間の間合いと最終ホールドの既定値",
      en: "Default gaps between messages and final hold",
    },
    apply: { transitionMs: 260, finalHoldMs: 1_600 },
  },
  {
    id: "tight",
    label: { ja: "テンポ重視", en: "Tight" },
    description: {
      ja: "間合いを詰めてSNS向けに全体を短く",
      en: "Tighter cuts for a short social clip",
    },
    apply: { transitionMs: 140, finalHoldMs: 900 },
  },
  {
    id: "calm",
    label: { ja: "ゆったり", en: "Calm" },
    description: {
      ja: "間合いを広げて読ませる。プレゼンや埋め込み向け",
      en: "Wider gaps that give time to read — talks and embeds",
    },
    apply: { transitionMs: 420, finalHoldMs: 2_400 },
  },
];

// ————————————————————————————————————————————————————————————————————————————
// Script file I/O. Import merges onto defaults so scripts written for older
// (or slightly newer) versions keep working; every repair is reported.
// ————————————————————————————————————————————————————————————————————————————

export const PROJECT_FILE_VERSION = 1;

type ImportStrings = {
  invalid: (label: string) => string;
  clamped: (label: string, min: number, max: number) => string;
  unsupported: (label: string, value: string, fallback: string) => string;
  badColor: (label: string) => string;
  badImage: (index: number) => string;
  tooManyImages: (index: number, max: number) => string;
  badBackdropImage: string;
  version: (version: number) => string;
  badModel: string;
  noMessages: string;
  badMessage: (index: number) => string;
  badRole: (index: number, role: string) => string;
  fontUpload: (slot: string) => string;
  tooMany: string;
  noValid: string;
  errParse: string;
  errShape: string;
};

const IMPORT_STRINGS: Record<"ja" | "en", ImportStrings> = {
  ja: {
    invalid: (label) => `${label} が不正なため既定値に戻しました。`,
    clamped: (label, min, max) => `${label} を ${min}〜${max} の範囲に丸めました。`,
    unsupported: (label, value, fallback) =>
      `${label}「${value}」は未対応のため「${fallback}」にしました。`,
    badColor: (label) => `${label} の色指定が不正なため既定値に戻しました。`,
    badImage: (index) => `${index}件目の画像が不正なため外しました。`,
    tooManyImages: (index, max) =>
      `${index}件目のmessageの画像が${max}枚を超えていたため先頭${max}枚だけ読み込みました。`,
    badBackdropImage: "背景画像が不正なため外しました。",
    version: (version) =>
      `version ${version} の台本を version ${PROJECT_FILE_VERSION} として読み込みました。未対応の設定は既定値で補完します。`,
    badModel: "モデル名が空か長すぎるため既定の名前に置き換えました。",
    noMessages: "messages がないため既定の台本を使います。",
    badMessage: (index) => `${index}件目のmessageが不正なためskipしました。`,
    badRole: (index, role) => `${index}件目のrole「${role}」は未対応のためskipしました。`,
    fontUpload: (slot) =>
      `アップロードしたフォント(${slot})はファイルに保存されないため、同梱フォントに戻しました。`,
    tooMany: `messageが${MAX_MESSAGES}件を超えていたため先頭${MAX_MESSAGES}件だけ読み込みました。`,
    noValid: "有効なmessageがなかったため既定の台本を使います。",
    errParse: "JSONとして読み込めませんでした。台本ファイルを確認してください。",
    errShape: "台本ファイルの形式が不正です(objectではありません)。",
  },
  en: {
    invalid: (label) => `${label} was invalid and reset to its default.`,
    clamped: (label, min, max) => `${label} was clamped to the ${min}–${max} range.`,
    unsupported: (label, value, fallback) =>
      `${label} "${value}" is not supported; using "${fallback}".`,
    badColor: (label) => `${label} had an invalid color and was reset to its default.`,
    badImage: (index) => `The image on message ${index} was invalid and removed.`,
    tooManyImages: (index, max) =>
      `Message ${index} carried more than ${max} images; only the first ${max} were loaded.`,
    badBackdropImage: "The backdrop image was invalid and removed.",
    version: (version) =>
      `A version ${version} script was loaded as version ${PROJECT_FILE_VERSION}. Unsupported settings fall back to defaults.`,
    badModel: "The model name was empty or too long and was replaced with the default name.",
    noMessages: "No messages found — using the default script.",
    badMessage: (index) => `Message ${index} was malformed and skipped.`,
    badRole: (index, role) => `Message ${index} has unsupported role "${role}" and was skipped.`,
    fontUpload: (slot) =>
      `Uploaded fonts (${slot}) are not stored in script files; reverted to the bundled font.`,
    tooMany: `More than ${MAX_MESSAGES} messages; only the first ${MAX_MESSAGES} were loaded.`,
    noValid: "No valid messages found — using the default script.",
    errParse: "Could not parse the file as JSON — check the script file.",
    errShape: "The script file has an invalid shape (not an object).",
  },
};

// Bound synchronously by deserializeProject; helpers read it during one parse.
// The initial value only covers a helper called before any parse, so it matches
// deserializeProject's own English default.
let activeImportStrings: ImportStrings = IMPORT_STRINGS.en;

/**
 * What each font slot actually resolved to when a script was written out. An
 * upload cannot travel — the bytes are tab-local and their licence is not ours
 * to redistribute — so it leaves a hash instead. That is enough for whoever
 * opens the file to be told they are looking at different metrics, which is
 * the whole failure this closes: wrapping and line counts are the first thing
 * a font changes, and a report about either does not reproduce without it.
 */
export type ScriptFontProvenance =
  | { source: "bundled" }
  | { source: "google"; family: string }
  | { source: "upload"; fileName: string; sha256: string };

/**
 * How a script file came to be. Not authored state: it describes the act of
 * writing the file, so it is never edited and never round-trips into the
 * project. A script alone cannot say which build drew it, which fonts it drew
 * with, or which moment a report is about — and those are exactly what a
 * "this bit looks wrong" hand-off needs.
 */
export type ScriptProvenance = {
  /** svgent that wrote the file. */
  app: string;
  /** Rendering engine it drew with. */
  engine: string;
  fonts: Record<FontSlot, ScriptFontProvenance>;
  /** Where the preview was parked, so a report can point at a moment. */
  capturedAtMs?: number;
  /** Which page that moment belongs to, when a script is split. */
  page?: number;
};

type ProjectImportResult = {
  project: SvgentProject;
  warnings: string[];
  /** Present only when the file carried one; never folded into the project. */
  provenance: ScriptProvenance | null;
};

export function serializeProject(project: SvgentProject, provenance?: ScriptProvenance): string {
  return JSON.stringify(
    { ...project, version: PROJECT_FILE_VERSION, ...(provenance ? { provenance } : {}) },
    null,
    2,
  );
}

/** The versions this build would stamp on anything it writes. */
export function currentToolVersions(
  appVersion: string,
  engineVersion: string,
): { app: string; engine: string } {
  return { app: appVersion, engine: engineVersion };
}

/**
 * Reads provenance back without trusting any of it. A file written by a newer
 * build, or by hand, must still open; anything unrecognisable is simply not
 * there rather than an import failure.
 */
function readProvenance(value: unknown): ScriptProvenance | null {
  if (!isRecord(value)) {
    return null;
  }
  const readFont = (slot: unknown): ScriptFontProvenance => {
    if (!isRecord(slot)) {
      return { source: "bundled" };
    }
    if (slot.source === "google" && typeof slot.family === "string") {
      return { source: "google", family: slot.family };
    }
    if (
      slot.source === "upload" &&
      typeof slot.fileName === "string" &&
      typeof slot.sha256 === "string"
    ) {
      return { source: "upload", fileName: slot.fileName, sha256: slot.sha256 };
    }
    return { source: "bundled" };
  };
  const fonts = isRecord(value.fonts) ? value.fonts : {};
  return {
    app: typeof value.app === "string" ? value.app : "",
    engine: typeof value.engine === "string" ? value.engine : "",
    fonts: { sans: readFont(fonts.sans), mono: readFont(fonts.mono) },
    ...(typeof value.capturedAtMs === "number" && Number.isFinite(value.capturedAtMs)
      ? { capturedAtMs: Math.max(0, value.capturedAtMs) }
      : {}),
    ...(typeof value.page === "number" && Number.isFinite(value.page)
      ? { page: Math.max(0, Math.floor(value.page)) }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ReadStringOptions = {
  fallback: string;
  maxLength: number;
  warnings: string[];
  label: string;
};

function readString(
  value: unknown,
  { fallback, maxLength, warnings, label }: ReadStringOptions,
): string {
  if (typeof value !== "string") {
    if (value !== undefined) {
      warnings.push(activeImportStrings.invalid(label));
    }
    return fallback;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

type ReadNumberOptions = {
  fallback: number;
  min: number;
  max: number;
  warnings: string[];
  label: string;
};

function readNumber(
  value: unknown,
  { fallback, min, max, warnings, label }: ReadNumberOptions,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (value !== undefined) {
      warnings.push(activeImportStrings.invalid(label));
    }
    return fallback;
  }
  if (value < min || value > max) {
    warnings.push(activeImportStrings.clamped(label, min, max));
    return Math.min(max, Math.max(min, value));
  }
  return value;
}

function readOptionalNumber(
  value: unknown,
  options: Omit<ReadNumberOptions, "fallback">,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    options.warnings.push(activeImportStrings.invalid(options.label));
    return undefined;
  }
  if (value < options.min || value > options.max) {
    options.warnings.push(activeImportStrings.clamped(options.label, options.min, options.max));
    return Math.min(options.max, Math.max(options.min, value));
  }
  return value;
}

function readMessageTiming(
  value: unknown,
  index: number,
  warnings: string[],
): MessageTimingOverride | undefined {
  const input = isRecord(value) ? value : {};
  const durationMs = readOptionalNumber(input.durationMs, {
    ...MESSAGE_TIMING_LIMITS.durationMs,
    warnings,
    label: `Message ${index + 1} duration`,
  });
  const pauseBeforeMs = readOptionalNumber(input.pauseBeforeMs, {
    ...MESSAGE_TIMING_LIMITS.pauseBeforeMs,
    warnings,
    label: `Message ${index + 1} pause`,
  });
  const transitionMs = readOptionalNumber(input.transitionMs, {
    ...MESSAGE_TIMING_LIMITS.transitionMs,
    warnings,
    label: `Message ${index + 1} transition`,
  });
  const timing = {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(pauseBeforeMs === undefined ? {} : { pauseBeforeMs }),
    ...(transitionMs === undefined ? {} : { transitionMs }),
  };
  return Object.keys(timing).length > 0 ? timing : undefined;
}

function readChoiceFields(entry: Record<string, unknown>): Partial<SessionMessage> {
  const options = Array.isArray(entry.options)
    ? entry.options
        .filter((option): option is string => typeof option === "string")
        .map((option) => option.slice(0, 120))
        .slice(0, 5)
    : [];
  const chosenIndex =
    typeof entry.chosenIndex === "number" && Number.isFinite(entry.chosenIndex)
      ? Math.max(0, Math.min(options.length - 1, Math.round(entry.chosenIndex)))
      : 0;
  const freeform =
    typeof entry.freeform === "string" && entry.freeform.trim().length > 0
      ? { freeform: entry.freeform.slice(0, MAX_MESSAGE_CHARS) }
      : {};
  // Only "keep" is worth storing: absence already means collapse, and an
  // explicit "collapse" would round-trip as noise.
  const afterSelection = entry.afterSelection === "keep" ? { afterSelection: "keep" as const } : {};
  return {
    ...(options.length > 0 ? { options, chosenIndex } : {}),
    ...freeform,
    ...afterSelection,
  };
}

function readMessageImages(
  entry: Record<string, unknown>,
  index: number,
  warnings: string[],
): AttachedImage[] {
  if (!Array.isArray(entry.images)) {
    if (entry.images !== undefined) {
      warnings.push(activeImportStrings.badImage(index + 1));
    }
    return [];
  }
  const images = entry.images
    .map((value) => readImage(value, () => warnings.push(activeImportStrings.badImage(index + 1))))
    .filter((image): image is AttachedImage => image !== undefined);
  if (images.length > MAX_MESSAGE_IMAGES) {
    warnings.push(activeImportStrings.tooManyImages(index + 1, MAX_MESSAGE_IMAGES));
  }
  return images.slice(0, MAX_MESSAGE_IMAGES);
}

function readMessageExtras(
  entry: Record<string, unknown>,
  index: number,
  warnings: string[],
): Partial<SessionMessage> {
  const images = readMessageImages(entry, index, warnings);
  const decision =
    entry.decision === "deny" || entry.decision === "allow-always"
      ? ({ decision: entry.decision } as const)
      : {};
  // Voice input is a user-side affordance; the flag is dropped elsewhere.
  const inputMode =
    entry.inputMode === "voice" && entry.role === "user" ? ({ inputMode: "voice" } as const) : {};
  // A highlight only means something on a thinking row; anywhere else it
  // would round-trip as noise.
  const highlight =
    entry.highlight === true && entry.role === "thinking" ? ({ highlight: true } as const) : {};
  return {
    ...(images.length > 0 ? { images } : {}),
    ...decision,
    ...inputMode,
    ...highlight,
    ...readChoiceFields(entry),
  };
}

type ReadEnumOptions<Value extends string> = {
  allowed: readonly Value[];
  fallback: Value;
  warnings: string[];
  label: string;
};

function readEnum<Value extends string>(
  value: unknown,
  { allowed, fallback, warnings, label }: ReadEnumOptions<Value>,
): Value {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as Value;
  }
  if (value !== undefined) {
    warnings.push(activeImportStrings.unsupported(label, String(value), fallback));
  }
  return fallback;
}

type ReadColorOptions = {
  fallback: string;
  warnings: string[];
  label: string;
};

function readColor(value: unknown, { fallback, warnings, label }: ReadColorOptions): string {
  if (typeof value === "string" && /^#[\da-f]{6}$/iu.test(value)) {
    return value;
  }
  if (value !== undefined) {
    warnings.push(activeImportStrings.badColor(label));
  }
  return fallback;
}

function readImage(value: unknown, warn: () => void): AttachedImage | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    warn();
    return undefined;
  }
  const dataUrl = value.dataUrl;
  const mediaType = value.mediaType;
  const width = value.width;
  const height = value.height;
  const validDataUrl =
    typeof dataUrl === "string" &&
    (dataUrl.startsWith("data:image/png;") ||
      dataUrl.startsWith("data:image/jpeg;") ||
      dataUrl.startsWith("data:image/webp;")) &&
    dataUrl.length <= MAX_IMAGE_BYTES * 1.6;
  const validDimensions =
    typeof width === "number" && width > 0 && typeof height === "number" && height > 0;
  if (
    !validDataUrl ||
    !validDimensions ||
    (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp")
  ) {
    warn();
    return undefined;
  }
  return {
    dataUrl,
    mediaType,
    width,
    height,
    alt: typeof value.alt === "string" ? value.alt.slice(0, 200) : "",
    fit: value.fit === "contain" ? "contain" : "cover",
    focus: value.focus === "top" || value.focus === "bottom" ? value.focus : "center",
    size: value.size === "small" || value.size === "large" ? value.size : "standard",
  };
}

const MESSAGE_ROLES: readonly MessageRole[] = [
  "user",
  "thinking",
  "tool",
  "permission",
  "assistant",
  "image",
  "choice",
];

/** Uploaded fonts live only in the tab that loaded them, so an import downgrades to bundled. */
function readFontChoice(
  fontsIn: Record<string, unknown>,
  slot: FontSlot,
  warnings: string[],
): FontChoice {
  const raw = fontsIn[slot];
  if (!isRecord(raw)) {
    return { source: "bundled" };
  }
  if (raw.source === "google" && typeof raw.family === "string" && raw.family.trim().length > 0) {
    return { source: "google", family: raw.family.trim().slice(0, 80) };
  }
  if (raw.source === "upload") {
    warnings.push(activeImportStrings.fontUpload(slot));
    return { source: "bundled" };
  }
  if (raw.source !== undefined && raw.source !== "bundled") {
    warnings.push(activeImportStrings.unsupported(`Font (${slot})`, String(raw.source), "bundled"));
  }
  return { source: "bundled" };
}

/**
 * An empty string is a valid choice: it hides the clock. Anything else that is
 * not H:MM falls back to the default with a warning.
 */
function readClockTime(chromeIn: Record<string, unknown>, warnings: string[]): string {
  const fallback = DEFAULT_PROJECT.chrome.clockTime;
  const raw = chromeIn.clockTime;
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw === "string" && (raw.trim().length === 0 || /^\d{1,2}:\d{2}$/u.test(raw))) {
    return raw.trim();
  }
  warnings.push(activeImportStrings.unsupported("Clock", String(raw), fallback));
  return fallback;
}

/**
 * Elements are visible unless the script explicitly turns them off, so a
 * partial script keeps the full chrome.
 */
function readDisplay(displayIn: Record<string, unknown>): DisplaySettings {
  return {
    // Scripts written before the region had a key of its own said "no header"
    // by turning both contents off, so that is what an absent key means.
    header:
      displayIn.header === undefined
        ? displayIn.headerIcons !== false || displayIn.headerText !== false
        : displayIn.header !== false,
    headerIcons: displayIn.headerIcons !== false,
    headerText: displayIn.headerText !== false,
    composer: displayIn.composer !== false,
    footer: displayIn.footer !== false,
    tuiGeometry: displayIn.tuiGeometry !== false,
    // Off by default: a terminal has no title bar meta of its own.
    tuiTitle: displayIn.tuiTitle === true,
    tuiClock: displayIn.tuiClock === true,
    tuiStatusHints: displayIn.tuiStatusHints === true,
    productMark: displayIn.productMark !== false,
    productVersion: displayIn.productVersion !== false,
  };
}

/**
 * Imports the message array, dropping entries the schema cannot place rather
 * than failing the whole script. `sourceCount` is how many entries the file
 * offered, so the caller can tell "no messages at all" from "none survived".
 */
/**
 * Suffix for a message the script left unnamed. Derived from the content, not
 * random: the id reaches the rendered SVG as `data-boundsvg-meta-edit`, so a
 * random one made every export of the same script differ byte-for-byte and
 * broke snapshot comparison. FNV-1a is enough — this only has to separate an
 * unnamed message from an explicit id that happens to look the same.
 */
function contentTag(content: string): string {
  let hash = 0x811c9dc5;
  for (const unit of content) {
    hash ^= unit.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(6, "0").slice(0, 6);
}

function readMessages(
  value: unknown,
  warnings: string[],
): { messages: SessionMessage[]; sourceCount: number } {
  const messagesIn = Array.isArray(value) ? value : [];
  if (!Array.isArray(value)) {
    warnings.push(activeImportStrings.noMessages);
  }
  const messages: SessionMessage[] = [];
  messagesIn.forEach((entry, index) => {
    if (messages.length >= MAX_MESSAGES) {
      return;
    }
    if (!isRecord(entry)) {
      warnings.push(activeImportStrings.badMessage(index + 1));
      return;
    }
    if (
      typeof entry.role !== "string" ||
      !(MESSAGE_ROLES as readonly string[]).includes(entry.role)
    ) {
      warnings.push(activeImportStrings.badRole(index + 1, String(entry.role)));
      return;
    }
    const content = typeof entry.content === "string" ? entry.content : "";
    const messageTiming = readMessageTiming(entry.timing, index, warnings);
    messages.push({
      id:
        typeof entry.id === "string" && entry.id.length > 0
          ? entry.id
          : `imported-${index}-${contentTag(content)}`,
      role: entry.role as MessageRole,
      content: content.slice(0, MAX_MESSAGE_CHARS),
      ...(typeof entry.language === "string" ? { language: entry.language.slice(0, 20) } : {}),
      ...(typeof entry.pageBreakBefore === "boolean"
        ? { pageBreakBefore: entry.pageBreakBefore }
        : {}),
      ...(messageTiming ? { timing: messageTiming } : {}),
      ...readMessageExtras(entry, index, warnings),
    });
  });
  if (messagesIn.length > MAX_MESSAGES) {
    warnings.push(activeImportStrings.tooMany);
  }
  return { messages, sourceCount: messagesIn.length };
}

function parseProjectRecord(source: string, warnings: string[]): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(activeImportStrings.errParse);
  }
  if (!isRecord(parsed)) {
    throw new Error(activeImportStrings.errShape);
  }
  const version = typeof parsed.version === "number" ? parsed.version : PROJECT_FILE_VERSION;
  if (version !== PROJECT_FILE_VERSION) {
    warnings.push(activeImportStrings.version(version));
  }
  return parsed;
}

export function deserializeProject(source: string, lang: "ja" | "en" = "en"): ProjectImportResult {
  activeImportStrings = IMPORT_STRINGS[lang];
  const warnings: string[] = [];
  const parsed = parseProjectRecord(source, warnings);

  const defaults = DEFAULT_PROJECT;
  const appearanceIn = isRecord(parsed.appearance) ? parsed.appearance : {};
  const themeId = readEnum(appearanceIn.theme, {
    allowed: THEME_PRESETS.map((preset) => preset.id),
    fallback: DEFAULT_PROJECT.appearance.theme,
    warnings,
    label: "Theme",
  });
  const chromeIn = isRecord(parsed.chrome) ? parsed.chrome : {};
  const displayIn = isRecord(parsed.display) ? parsed.display : {};
  const fontsIn = isRecord(parsed.fonts) ? parsed.fonts : {};
  const cameraIn = isRecord(parsed.camera) ? parsed.camera : {};

  const timingIn = isRecord(parsed.timing) ? parsed.timing : {};
  const paginationIn = isRecord(parsed.pagination) ? parsed.pagination : {};

  // Basis is read before the model label: a declared reenactment is the
  // one case where a real model name passes through unreplaced.
  const basis = readEnum(parsed.basis, {
    allowed: ["fictional", "reenactment"],
    fallback: defaults.basis,
    warnings,
    label: "Basis",
  });
  const modelLabel = readString(parsed.modelLabel, {
    fallback: defaults.modelLabel,
    maxLength: 40,
    warnings,
    label: "Model label",
  });
  if (modelLabelIssue(modelLabel)) {
    warnings.push(activeImportStrings.badModel);
  }

  const { messages, sourceCount: messageSourceCount } = readMessages(parsed.messages, warnings);

  const project: SvgentProject = {
    version: 1,
    title: readString(parsed.title, {
      fallback: defaults.title,
      maxLength: 80,
      warnings,
      label: "Title",
    }),
    surface: readEnum(parsed.surface, {
      allowed: ["app", "tui"],
      fallback: defaults.surface,
      warnings,
      label: "Surface",
    }),
    basis,
    modelLabel: modelLabelIssue(modelLabel) ? SAFE_MODEL_LABEL : modelLabel,
    workspaceLabel: readString(parsed.workspaceLabel, {
      fallback: defaults.workspaceLabel,
      maxLength: 70,
      warnings,
      label: "Workspace",
    }),
    branchLabel: readString(parsed.branchLabel, {
      fallback: defaults.branchLabel,
      maxLength: 70,
      warnings,
      label: "Branch",
    }),
    appearance: {
      theme: themeId,
      canvasWidth: readNumber(appearanceIn.canvasWidth, {
        fallback: defaults.appearance.canvasWidth,
        min: 640,
        max: 2560,
        warnings,
        label: "Width",
      }),
      canvasHeight: readNumber(appearanceIn.canvasHeight, {
        fallback: defaults.appearance.canvasHeight,
        min: 480,
        max: 2560,
        warnings,
        label: "Height",
      }),
      transparentCanvas: appearanceIn.transparentCanvas === true,
      terminalOpacity: readNumber(appearanceIn.terminalOpacity, {
        fallback: defaults.appearance.terminalOpacity,
        min: 0.45,
        max: 1,
        warnings,
        label: "Panel opacity",
      }),
      background: readColor(appearanceIn.background, {
        fallback: defaults.appearance.background,
        warnings,
        label: "Background",
      }),
      accent: readColor(appearanceIn.accent, {
        fallback: defaults.appearance.accent,
        warnings,
        label: "Accent",
      }),
      backdrop: readEnum(appearanceIn.backdrop, {
        allowed: BACKDROP_PRESETS.map((preset) => preset.id),
        fallback: defaults.appearance.backdrop,
        warnings,
        label: "Backdrop",
      }),
      imageSkeleton: readEnum(appearanceIn.imageSkeleton, {
        allowed: IMAGE_SKELETONS,
        fallback: defaults.appearance.imageSkeleton,
        warnings,
        label: "Image skeleton",
      }),
      ...((): { backdropImage?: AttachedImage } => {
        const image = readImage(appearanceIn.backdropImage, () =>
          warnings.push(activeImportStrings.badBackdropImage),
        );
        return image ? { backdropImage: image } : {};
      })(),
      shadowStrength: readNumber(appearanceIn.shadowStrength, {
        fallback: defaults.appearance.shadowStrength,
        min: 0,
        max: 1,
        warnings,
        label: "Shadow",
      }),
      userBubbleColor: readColor(appearanceIn.userBubbleColor, {
        fallback:
          THEME_PRESETS.find((preset) => preset.id === themeId)?.user ??
          defaults.appearance.userBubbleColor,
        warnings,
        label: "User bubble",
      }),
      windowPaddingX: readNumber(appearanceIn.windowPaddingX, {
        fallback: defaults.appearance.windowPaddingX,
        min: 0,
        max: 80,
        warnings,
        label: "Frame padding (horizontal)",
      }),
      windowPaddingY: readNumber(appearanceIn.windowPaddingY, {
        fallback: defaults.appearance.windowPaddingY,
        min: 0,
        max: 80,
        warnings,
        label: "Frame padding (vertical)",
      }),
      windowMargin: readNumber(appearanceIn.windowMargin, {
        fallback: defaults.appearance.windowMargin,
        min: 0,
        max: 140,
        warnings,
        label: "Window margin",
      }),
      fontScale: readNumber(appearanceIn.fontScale, {
        fallback: defaults.appearance.fontScale,
        min: 0.8,
        max: 5,
        warnings,
        label: "Font size",
      }),
      chromeScale: readNumber(appearanceIn.chromeScale, {
        fallback: defaults.appearance.chromeScale,
        min: 0.8,
        max: 3,
        warnings,
        label: "Chrome size",
      }),
      spacingScale: readNumber(appearanceIn.spacingScale, {
        fallback: defaults.appearance.spacingScale,
        min: 0.6,
        max: 1.6,
        warnings,
        label: "Spacing",
      }),
      contentAlign: readEnum(appearanceIn.contentAlign, {
        allowed: ["start", "center"],
        fallback: defaults.appearance.contentAlign,
        warnings,
        label: "Content alignment",
      }),
      messageAlign: readEnum(appearanceIn.messageAlign, {
        allowed: ["role", "center"],
        fallback: defaults.appearance.messageAlign,
        warnings,
        label: "Message alignment",
      }),
      assistantSurface: readEnum(appearanceIn.assistantSurface, {
        allowed: ["card", "plain"],
        fallback: defaults.appearance.assistantSurface,
        warnings,
        label: "Assistant surface",
      }),
    },
    chrome: {
      contextPercent: readNumber(chromeIn.contextPercent, {
        fallback: defaults.chrome.contextPercent,
        min: 0,
        max: 100,
        warnings,
        label: "Context %",
      }),
      clockTime: readClockTime(chromeIn, warnings),
    },
    display: readDisplay(displayIn),
    timing: {
      userTypingCps: readNumber(timingIn.userTypingCps, {
        fallback: defaults.timing.userTypingCps,
        min: 6,
        max: 60,
        warnings,
        label: "User typing",
      }),
      agentTypingCps: readNumber(timingIn.agentTypingCps, {
        fallback: defaults.timing.agentTypingCps,
        min: 8,
        max: 300,
        warnings,
        label: "Agent response",
      }),
      reactionMs: readNumber(timingIn.reactionMs ?? defaults.timing.reactionMs, {
        fallback: defaults.timing.reactionMs,
        min: 0,
        max: 3_000,
        warnings,
        label: "Reaction",
      }),
      thinkingMs: readNumber(timingIn.thinkingMs, {
        fallback: defaults.timing.thinkingMs,
        min: 400,
        max: 8_000,
        warnings,
        label: "Thinking",
      }),
      imageGenMs: readNumber(timingIn.imageGenMs, {
        fallback: defaults.timing.imageGenMs,
        min: 800,
        max: 20_000,
        warnings,
        label: "Image generation",
      }),
      toolRunMs: readNumber(timingIn.toolRunMs, {
        fallback: defaults.timing.toolRunMs,
        min: 300,
        max: 6_000,
        warnings,
        label: "Tool / render",
      }),
      permissionMs: readNumber(timingIn.permissionMs, {
        fallback: defaults.timing.permissionMs,
        min: 500,
        max: 6_000,
        warnings,
        label: "Permission dwell",
      }),
      transitionMs: readNumber(timingIn.transitionMs, {
        fallback: defaults.timing.transitionMs,
        min: 0,
        max: 2_000,
        warnings,
        label: "Transition",
      }),
      finalHoldMs: readNumber(timingIn.finalHoldMs, {
        fallback: defaults.timing.finalHoldMs,
        min: 500,
        max: 6_000,
        warnings,
        label: "Final hold",
      }),
    },
    pagination: {
      flow: readEnum(paginationIn.flow, {
        allowed: ["scroll", "slides"],
        fallback: defaults.pagination.flow,
        warnings,
        label: "Flow",
      }),
      messagesPerPage: readNumber(paginationIn.messagesPerPage, {
        fallback: defaults.pagination.messagesPerPage,
        min: 1,
        max: 6,
        warnings,
        label: "Messages / slide",
      }),
      scrollDistancePx: readNumber(paginationIn.scrollDistancePx, {
        fallback: defaults.pagination.scrollDistancePx,
        min: 0,
        max: 2_400,
        warnings,
        label: "Scroll limit",
      }),
    },
    camera: {
      follow: cameraIn.follow === true,
      zoom: readNumber(cameraIn.zoom ?? defaults.camera.zoom, {
        fallback: defaults.camera.zoom,
        min: CAMERA_ZOOM_MIN,
        max: CAMERA_ZOOM_MAX,
        warnings,
        label: "Camera zoom",
      }),
      style: readEnum(cameraIn.style ?? defaults.camera.style, {
        allowed: ["anticipate", "sync", "trail"],
        fallback: defaults.camera.style,
        warnings,
        label: "Camera style",
      }),
      minShotMs: readNumber(cameraIn.minShotMs ?? defaults.camera.minShotMs, {
        fallback: defaults.camera.minShotMs,
        min: 0,
        max: 4_000,
        warnings,
        label: "Camera minimum shot",
      }),
    },
    fonts: {
      sans: readFontChoice(fontsIn, "sans", warnings),
      mono: readFontChoice(fontsIn, "mono", warnings),
    },
    messages: messages.length > 0 ? messages : DEFAULT_PROJECT.messages,
  };
  if (messages.length === 0 && messageSourceCount > 0) {
    warnings.push(activeImportStrings.noValid);
  }

  return { project, warnings, provenance: readProvenance(parsed.provenance) };
}

// ————————————————————————————————————————————————————————————————————————————
// Font sourcing helpers (pure). Fetching lives in fonts.ts.
// ————————————————————————————————————————————————————————————————————————————

/**
 * Family names other tools would make you clean up by hand: specimen URLs,
 * css2 URLs, "+"-joined names, ":wght@…" suffixes. Anything URL-ish gets
 * normalized to the bare family name; plain typing passes through untouched
 * so mid-word spaces are not eaten.
 */
export function normalizeGoogleFontFamily(input: string): string {
  if (!/[/%+:&]|fonts\.google/iu.test(input)) {
    return input;
  }
  let value = input.trim();
  const isUrl = /^https?:\/\//iu.test(value);
  // Noto families live under /noto/specimen/…, so allow path segments
  // before "specimen".
  const specimen = /fonts\.google\.com\/(?:[\w-]+\/)*specimen\/([^/?#]+)/iu.exec(value);
  const familyParam = /[?&]family=([^&]+)/iu.exec(value);
  if (specimen?.[1]) {
    value = specimen[1];
  } else if (familyParam?.[1]) {
    value = familyParam[1];
  } else if (isUrl) {
    // An URL we cannot parse — better to leave it visible than to mangle
    // it into a fragment like "https".
    return value;
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    // Stray "%" from a partial paste — keep the raw text.
  }
  value = value.replace(/\+/gu, " ");
  value = value.split(":")[0] ?? value;
  value = value.split("&")[0] ?? value;
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Curated autocomplete list: popular Japanese families plus coding and UI
 * staples. Free-text input still accepts the full catalog.
 */
export const GOOGLE_FONT_SUGGESTIONS: readonly string[] = [
  "Noto Sans JP",
  "Noto Serif JP",
  "M PLUS 1p",
  "M PLUS Rounded 1c",
  "M PLUS 1 Code",
  "Zen Maru Gothic",
  "Zen Kaku Gothic New",
  "Zen Old Mincho",
  "BIZ UDGothic",
  "BIZ UDPGothic",
  "Shippori Mincho",
  "Kosugi Maru",
  "DotGothic16",
  "Yusei Magic",
  "Klee One",
  "Murecho",
  "Inter",
  "Roboto",
  "Poppins",
  "JetBrains Mono",
  "Fira Code",
  "IBM Plex Mono",
  "Source Code Pro",
  "Roboto Mono",
  "Ubuntu Mono",
  "Inconsolata",
  "Space Mono",
];

/**
 * css2 URL requesting one weight subset to exactly the given text — this is
 * what keeps CJK families to a single downloadable file instead of ~100
 * unicode-range slices.
 */
export function buildGoogleFontCssUrl(family: string, text: string): string {
  const familyParam = encodeURIComponent(family.trim()).replace(/%20/gu, "+");
  return `https://fonts.googleapis.com/css2?family=${familyParam}:wght@400&text=${encodeURIComponent(text)}&display=swap`;
}
