/**
 * What the agent may put into a script, and how the person reads it back:
 * the privacy default the tools describe, the allowlist a loaded script
 * passes through, every string the stage can show, and the sensitive-shape
 * hints listed beside them.
 */

import { type SessionMessage, type SvgentProject, stripDraftMarkup } from "@svgent/scene";

export type PrivacyMode = "fictionalized" | "as-told";

export const PRIVACY_DEFAULT =
  'Privacy default: unless the person says otherwise, treat what you know from the conversation as private. Replace real names of people, companies, products, repositories, hosts, file paths, keys, tickets and internal URLs with fictional stand-ins of the same shape; keep the meaning and the flow. The person relaxes this by saying so ("use the real names", "keep the repo name") or by switching the page to "As told" — then keep exactly what they named and still leave out credentials. Never widen it on your own.';

export const PRIVACY_MODE_TEXT: Record<PrivacyMode, string> = {
  fictionalized: "Fictionalized — real names become stand-ins unless you say otherwise.",
  "as-told": "As told — names and details stay as you gave them; credentials are still left out.",
};

/** Top-level fields of a script that render on the stage. */
const SCRIPT_FIELDS = [
  "version",
  "title",
  "surface",
  "modelLabel",
  "workspaceLabel",
  "branchLabel",
  "messages",
] as const;

/** Per-message fields that render or change how a message plays. */
const MESSAGE_FIELDS = [
  "role",
  "content",
  "language",
  "decision",
  "options",
  "chosenIndex",
  "freeform",
  "afterSelection",
  "inputMode",
  "highlight",
  "pageBreakBefore",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep only what renders. Anything else — appearance, fonts, images, chrome,
 * camera, basis, ids, unknown keys — is dropped and named in the result.
 */
export function sanitizeIncomingScript(raw: unknown): {
  script: Record<string, unknown>;
  dropped: string[];
} {
  if (!isRecord(raw)) {
    throw new Error("script must be a JSON object");
  }
  const dropped: string[] = [];
  const script: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if ((SCRIPT_FIELDS as readonly string[]).includes(key)) {
      script[key] = raw[key];
    } else {
      dropped.push(key);
    }
  }
  if (Array.isArray(raw.messages)) {
    script.messages = raw.messages.map((entry, index) => {
      if (!isRecord(entry)) {
        return entry;
      }
      const message: Record<string, unknown> = {};
      for (const key of Object.keys(entry)) {
        if ((MESSAGE_FIELDS as readonly string[]).includes(key)) {
          message[key] = entry[key];
        } else {
          dropped.push(`messages[${index}].${key}`);
        }
      }
      return message;
    });
  }
  return { script, dropped };
}

type RenderedText = {
  /** Where on the stage this text belongs. */
  where: string;
  text: string;
  messageId?: string;
  /**
   * Why someone watching the preview could miss it: a menu that collapses
   * after the pick, a note that folds back, or a later page.
   */
  hiddenBy?: "collapses after the pick" | "folds back after a beat" | `page ${number}`;
};

function pageOf(project: SvgentProject, index: number): number {
  if (project.pagination.flow !== "slides") {
    return 1;
  }
  let page = 1;
  for (let at = 1; at <= index; at += 1) {
    const message = project.messages[at];
    const forced = message?.pageBreakBefore;
    const automatic = at % Math.max(1, project.pagination.messagesPerPage) === 0;
    if (forced === true || (forced === undefined && automatic)) {
      page += 1;
    }
  }
  return page;
}

/** Every string the stage can show, in reading order. */
export function collectRenderedText(project: SvgentProject): RenderedText[] {
  const out: RenderedText[] = [
    { where: "title", text: project.title },
    { where: "workspace", text: project.workspaceLabel },
    { where: "branch", text: project.branchLabel },
    { where: "model", text: project.modelLabel },
    { where: "clock", text: project.chrome.clockTime },
  ].filter((entry) => entry.text.trim().length > 0);
  project.messages.forEach((message: SessionMessage, index) => {
    const page = pageOf(project, index);
    const later = page > 1 ? (`page ${page}` as const) : undefined;
    // A user line is listed as it lands on the stage: IME readings and
    // completion prefixes are how it is typed, not what it says.
    out.push({
      where: `${index + 1} · ${message.role}`,
      text: message.role === "user" ? stripDraftMarkup(message.content) : message.content,
      messageId: message.id,
      hiddenBy: later,
    });
    if (message.role === "thinking" && message.highlight) {
      out.push({
        where: `${index + 1} · held note`,
        text: message.content,
        messageId: message.id,
        hiddenBy: later ?? "folds back after a beat",
      });
    }
    for (const [at, option] of (message.options ?? []).entries()) {
      out.push({
        where: `${index + 1} · option ${at + 1}`,
        text: option,
        messageId: message.id,
        hiddenBy:
          later ?? (message.afterSelection === "keep" ? undefined : "collapses after the pick"),
      });
    }
    if (message.freeform) {
      out.push({
        where: `${index + 1} · typed answer`,
        text: message.freeform,
        messageId: message.id,
        hiddenBy: later,
      });
    }
  });
  return out;
}

type SensitiveHit = { path: string; message: string };

/**
 * The same shapes the studio's publication check looks for, run over every
 * rendered string rather than message bodies alone — an option label or a
 * branch name can carry a token as easily as a reply can. Hints, not gates.
 */
const SENSITIVE_RULES: ReadonlyArray<{ pattern: RegExp; message: string }> = [
  {
    pattern:
      /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.)/u,
    message: "looks like a credential or private key",
  },
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
    message: "looks like an email address",
  },
  {
    pattern: /(?:\/Users\/[^\s/]+|\/home\/[^\s/]+|[A-Z]:\\Users\\[^\s\\]+)/iu,
    message: "a local path that could identify the author",
  },
  {
    pattern:
      /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|[^\s/]+\.(?:local|internal))(?:[/:]|\b)/iu,
    message: "looks like an internal or local URL",
  },
  {
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/u,
    message: "looks like an IP address",
  },
];

export function scanForSensitive(project: SvgentProject): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  for (const entry of collectRenderedText(project)) {
    for (const rule of SENSITIVE_RULES) {
      if (rule.pattern.test(entry.text)) {
        hits.push({ path: entry.where, message: rule.message });
      }
    }
  }
  return hits;
}
