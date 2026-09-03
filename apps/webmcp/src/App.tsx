import { defaultProjectFor, type SvgentProject } from "@svgent/scene";
import {
  Studio,
  type StudioChrome,
  type StudioHandle,
  type StudioProductConfig,
} from "@svgent/studio";
import { useCallback, useEffect, useRef, useState } from "react";
import { version } from "../package.json";
import {
  applyCameraDirection,
  applySceneDirection,
  CAMERA_STYLES,
  type CameraDirection,
  DIRECTION_CHOICES,
  locateMessage,
  type SceneDirection,
} from "./direction.js";
import { mintId } from "./ids.js";
import {
  collectRenderedText,
  PRIVACY_DEFAULT,
  PRIVACY_MODE_TEXT,
  type PrivacyMode,
  scanForSensitive,
} from "./privacy.js";
import { SHOWCASES, showcaseProject } from "./showcase.js";
import {
  type ActivityEntry,
  createApproveProposalTool,
  createStudioTools,
  type Decision,
  type PendingRequest,
} from "./tools.js";
import type { ModelContext, WebMcpTool } from "./webmcp.js";

const PRODUCT: StudioProductConfig = {
  name: "svgent",
  version,
  engineVersion: "0.1.0",
  repositoryUrl: "https://github.com/zakideee/svgent",
  storageKeyPrefix: "svgent-webmcp",
};

const MAX_ACTIVITY = 40;
const MAX_HISTORY = 20;
const REWRITE_PREVIEW_CHARS = 280;
const UNREGISTER_GRACE_MS = 400;
const HIGHLIGHT_DELAY_MS = 80;
const RAIL_STORAGE_KEY = "svgent-webmcp-rail";

type RailTab = "agent" | "scripts" | "words";

/**
 * The whole studio by default — the agent is a second pair of hands on the
 * real product, not a replacement for its panels. `?chrome=stage` keeps the
 * preview-only shell for a clean recording or an embed.
 */
function chromeFromUrl(): StudioChrome {
  return new URLSearchParams(window.location.search).get("chrome") === "stage" ? "stage" : "full";
}

function readRailOpen(): boolean {
  try {
    return window.localStorage.getItem(RAIL_STORAGE_KEY) !== "closed";
  } catch {
    return true;
  }
}

const PROMPTS_TO_TRY = [
  "Could you turn what we just did into a 20-second clip for the team channel? Keep the flow, leave the names out.",
  "Earlier an edit went ahead after I had declined it. Would you stage that gently, so I can show the team what happened?",
  "Let's make three slides that walk a colleague through choices and approvals, one beat each. A Japanese version would be lovely too.",
  "Show my weather-mcp in use, as one link-card image for the README.",
];

/**
 * The current draft and built-in browsers expose the API on `document`;
 * older browser implementations put it on `navigator`. Prefer the current
 * location while retaining the fallback during the transition.
 */
function modelContext(): ModelContext | null {
  const fromDocument = document.modelContext;
  if (typeof fromDocument?.registerTool === "function") {
    return fromDocument;
  }
  const fromNavigator = navigator.modelContext;
  if (typeof fromNavigator?.registerTool === "function") {
    return fromNavigator;
  }
  return null;
}

/** Register with the standard's options, or without them where they are refused. */
async function registerTool(
  context: ModelContext,
  tool: WebMcpTool,
  signal: AbortSignal,
): Promise<void> {
  try {
    await context.registerTool(tool, { signal });
  } catch (error) {
    if (error instanceof TypeError) {
      await context.registerTool(tool);
      return;
    }
    throw error;
  }
}

/** How long to keep looking for an API that a browser injects after load. */
const API_WAIT_MS = 30_000;
const API_POLL_MS = 300;

function isShim(context: ModelContext): boolean {
  return (context as { isShim?: boolean }).isShim === true;
}

/** The studio's blank template, which a first visit should not be left on. */
function isUntouchedTemplate(project: SvgentProject): boolean {
  const template = defaultProjectFor("en");
  return (
    project.title === template.title &&
    project.messages.length === template.messages.length &&
    project.messages.every(
      (message, index) => message.content === template.messages[index]?.content,
    )
  );
}

/**
 * A content change is reported as a character count; the person deciding on
 * it wants to read the new text. Resolved from the proposal's after-state.
 */
function rewrittenContent(request: PendingRequest, path: string): string | null {
  if (request.kind !== "proposal") {
    return null;
  }
  const match = /^messages\.(.+)\.content$/u.exec(path);
  if (match === null) {
    return null;
  }
  const message = request.after.messages.find((candidate) => candidate.id === match[1]);
  if (message === undefined) {
    return null;
  }
  return message.content.length > REWRITE_PREVIEW_CHARS
    ? `${message.content.slice(0, REWRITE_PREVIEW_CHARS)}…`
    : message.content;
}

type Waiter = { request: PendingRequest; resolve: (decision: Decision) => void };

export function App() {
  const studioRef = useRef<StudioHandle | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [history, setHistory] = useState<SvgentProject[]>([]);
  const [pending, setPending] = useState<Waiter | null>(null);
  const pendingRef = useRef<Waiter | null>(null);
  const [support, setSupport] = useState<"checking" | "ready" | "shim" | "missing">("checking");
  const [supportDetail, setSupportDetail] = useState<string | null>(null);
  const [uiTheme, setUiTheme] = useState<"dark" | "light">("dark");
  // Mirrors the studio's project so the chips show the current staging.
  const [project, setProject] = useState<SvgentProject | null>(null);
  const [chrome, setChrome] = useState<StudioChrome>(chromeFromUrl);
  // Deliberately not persisted: every visit starts on the protective default.
  const [privacy, setPrivacy] = useState<PrivacyMode>("fictionalized");
  const privacyRef = useRef(privacy);
  privacyRef.current = privacy;
  // Messages the agent has touched since the person last said "read".
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [railOpen, setRailOpen] = useState<boolean>(readRailOpen);
  const [railTab, setRailTab] = useState<RailTab>("agent");
  // The chat's composer is the browser's, not this page's, so a prompt
  // travels by clipboard; the label confirms it left.
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const copyPrompt = async (prompt: string) => {
    // The async clipboard needs a secure context; a page served over plain
    // http from a LAN address has none, so fall back to a selection copy.
    let done = false;
    try {
      if (window.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(prompt);
        done = true;
      }
    } catch {
      done = false;
    }
    if (!done) {
      const scratch = document.createElement("textarea");
      scratch.value = prompt;
      scratch.setAttribute("readonly", "");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.append(scratch);
      scratch.select();
      try {
        done = document.execCommand("copy");
      } catch {
        done = false;
      }
      scratch.remove();
    }
    if (done) {
      setCopied(prompt);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1600);
    }
  };
  const toggleRail = () => {
    setRailOpen((open) => {
      try {
        window.localStorage.setItem(RAIL_STORAGE_KEY, open ? "closed" : "open");
      } catch {
        // Storage unavailable; the rail still toggles for this visit.
      }
      return !open;
    });
  };
  const showChrome = (next: StudioChrome) => {
    const url = new URL(window.location.href);
    if (next === "stage") {
      url.searchParams.set("chrome", "stage");
    } else {
      url.searchParams.delete("chrome");
    }
    window.history.pushState(null, "", url);
    setChrome(next);
  };
  useEffect(() => {
    const syncChromeFromHistory = () => setChrome(chromeFromUrl());
    window.addEventListener("popstate", syncChromeFromHistory);
    return () => window.removeEventListener("popstate", syncChromeFromHistory);
  }, []);
  // A request the person has to answer opens the rail on its own.
  useEffect(() => {
    if (pending !== null) {
      setRailOpen(true);
    }
  }, [pending]);

  /**
   * Show where a change landed: cue the preview to the first message it
   * touched and let the studio flash its outline and light its cards. A
   * change to the whole script is not "somewhere", so it gets no cue.
   */
  const highlight = useCallback((messageIds: readonly string[]) => {
    const studio = studioRef.current;
    if (studio === null || messageIds.length === 0) {
      return;
    }
    const current = studio.getProject();
    if (messageIds.length >= current.messages.length) {
      return;
    }
    const first = messageIds[0] as string;
    const where = locateMessage(current, first);
    if (where !== null) {
      studio.seek(where.settledMs, { page: where.page });
    }
    // The seek re-renders the stage; the outline is measured on the frame after.
    window.setTimeout(() => studio.spotlight(messageIds, { jump: true }), HIGHLIGHT_DELAY_MS);
  }, []);

  const record = useCallback(
    (entry: Omit<ActivityEntry, "id" | "at">) => {
      setActivity((current) =>
        [{ ...entry, id: mintId("activity"), at: Date.now() }, ...current].slice(0, MAX_ACTIVITY),
      );
      if (entry.affectedMessageIds?.length) {
        highlight(entry.affectedMessageIds);
      }
    },
    [highlight],
  );
  const recordAgent = useCallback(
    (entry: Omit<ActivityEntry, "id" | "at" | "actor">) => {
      record({ ...entry, actor: "agent" });
      if (entry.affectedMessageIds?.length) {
        const ids = entry.affectedMessageIds;
        setTouched((current) => new Set([...current, ...ids]));
      }
    },
    [record],
  );

  const rememberBefore = useCallback((before: SvgentProject) => {
    setHistory((current) => [before, ...current].slice(0, MAX_HISTORY));
  }, []);

  const settle = useCallback((decision: Decision) => {
    const waiter = pendingRef.current;
    if (waiter === null) {
      return;
    }
    pendingRef.current = null;
    setPending(null);
    waiter.resolve(decision);
  }, []);

  const askPerson = useCallback(
    (request: PendingRequest) =>
      new Promise<Decision>((resolve) => {
        // One request at a time: a newer one supersedes the older, which the
        // agent learns as a rejection.
        pendingRef.current?.resolve("rejected");
        const waiter = { request, resolve };
        pendingRef.current = waiter;
        setPending(waiter);
      }),
    [],
  );

  const approve = () => {
    const waiter = pendingRef.current;
    if (waiter === null) {
      return;
    }
    if (waiter.request.kind === "proposal") {
      const studio = studioRef.current;
      const { after, affectedMessageIds, changes } = waiter.request;
      if (studio !== null) {
        rememberBefore(studio.getProject());
        studio.applyPatch(() => after);
        studio.play({ restart: true });
      }
      record({
        actor: "you",
        tool: "proposal",
        summary: `approved ${changes.length} change(s)`,
        ok: true,
        affectedMessageIds,
      });
      setTouched((current) => new Set([...current, ...affectedMessageIds]));
    }
    settle("approved");
  };

  const reject = () => {
    const waiter = pendingRef.current;
    if (waiter !== null) {
      record({ actor: "you", tool: waiter.request.kind, summary: "rejected", ok: false });
    }
    settle("rejected");
  };

  const undo = () => {
    const [previous, ...rest] = history;
    const studio = studioRef.current;
    if (previous === undefined || studio === null) {
      return;
    }
    studio.replaceProject(previous);
    setHistory(rest);
    record({ actor: "you", tool: "undo", summary: `restored "${previous.title}"`, ok: true });
  };

  /** The person's chips go through the same direction the agent's tool uses. */
  const direct = (direction: SceneDirection, label: string) => {
    const studio = studioRef.current;
    if (studio === null) {
      return;
    }
    const current = studio.getProject();
    const directed = applySceneDirection(current, direction);
    if (directed.changes.length === 0) {
      return;
    }
    rememberBefore(current);
    studio.applyPatch(() => directed.project);
    studio.play({ restart: true });
    record({ actor: "you", tool: "direct_scene", summary: label, ok: true });
  };

  const directCamera = (direction: CameraDirection, label: string) => {
    const studio = studioRef.current;
    if (studio === null) {
      return;
    }
    const current = studio.getProject();
    const directed = applyCameraDirection(current, direction);
    if (directed.changes.length === 0) {
      return;
    }
    rememberBefore(current);
    studio.applyPatch(() => directed.project);
    studio.play({ restart: true });
    record({ actor: "you", tool: "direct_camera", summary: label, ok: true });
  };

  const loadShowcase = (id: string, quiet = false) => {
    const studio = studioRef.current;
    const showcase = SHOWCASES.find((entry) => entry.id === id);
    if (studio === null || showcase === undefined) {
      return;
    }
    if (!quiet) {
      rememberBefore(studio.getProject());
    }
    const next = showcaseProject(showcase);
    studio.replaceProject(next);
    studio.play({ restart: true });
    if (!quiet) {
      record({ actor: "you", tool: "showcase", summary: `loaded "${next.title}"`, ok: true });
    }
  };

  const jumpTo = (entry: ActivityEntry) => {
    const studio = studioRef.current;
    const messageId = entry.affectedMessageIds?.[0];
    if (studio === null || messageId === undefined) {
      return;
    }
    const where = locateMessage(studio.getProject(), messageId);
    if (where !== null) {
      studio.seek(where.settledMs, { page: where.page });
    }
    window.setTimeout(
      () => studio.spotlight(entry.affectedMessageIds ?? [], { jump: true }),
      HIGHLIGHT_DELAY_MS,
    );
  };

  // A first visit lands on a showcase rather than the blank template; a
  // returning visit keeps whatever the studio restored.
  const openedRef = useRef(false);
  const loadShowcaseRef = useRef(loadShowcase);
  loadShowcaseRef.current = loadShowcase;
  const onStudioProject = useCallback((next: SvgentProject) => {
    setProject(next);
    if (!openedRef.current) {
      openedRef.current = true;
      if (isUntouchedTemplate(next)) {
        // The studio has just committed its first project; replacing it in
        // the same callback would fight that commit.
        window.setTimeout(() => loadShowcaseRef.current(SHOWCASES[0]?.id ?? "", true), 0);
      }
    }
  }, []);

  // The static tool set: registered as soon as the browser offers the API,
  // which some inject a moment after the page's own scripts have run.
  useEffect(() => {
    const controller = new AbortController();
    const tools = createStudioTools({
      studio: () => studioRef.current,
      privacy: () => privacyRef.current,
      askPerson,
      rememberBefore,
      record: recordAgent,
    });
    let cancelled = false;
    let registeredWith: ModelContext | null = null;
    const register = async (context: ModelContext) => {
      registeredWith = context;
      try {
        for (const tool of tools) {
          await registerTool(context, tool, controller.signal);
        }
        if (!cancelled) {
          setSupport(isShim(context) ? "shim" : "ready");
          setSupportDetail(null);
        }
      } catch (error) {
        console.error("WebMCP registration failed", error);
        if (!cancelled) {
          setSupport("missing");
          setSupportDetail(error instanceof Error ? error.message : String(error));
        }
      }
    };
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const context = modelContext();
      if (context !== null) {
        window.clearInterval(timer);
        void register(context);
      } else if (Date.now() - startedAt > API_WAIT_MS) {
        window.clearInterval(timer);
        if (!cancelled) {
          setSupport("missing");
        }
      }
    }, API_POLL_MS);
    const immediate = modelContext();
    if (immediate !== null) {
      window.clearInterval(timer);
      void register(immediate);
    }
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      controller.abort();
      const context = registeredWith;
      if (context !== null) {
        for (const tool of tools) {
          void context.unregisterTool?.(tool.name);
        }
      }
    };
  }, [askPerson, rememberBefore, recordAgent]);

  // The confirmation tool exists exactly while a proposal is pending.
  const pendingProposalHandle =
    pending?.request.kind === "proposal" ? pending.request.handle : null;
  useEffect(() => {
    const context = modelContext();
    if (context === null || pendingProposalHandle === null) {
      return;
    }
    const tool = createApproveProposalTool({
      handle: pendingProposalHandle,
      waitForDecision: () =>
        new Promise<Decision>((resolve) => {
          const waiter = pendingRef.current;
          if (waiter === null || waiter.request.handle !== pendingProposalHandle) {
            resolve("rejected");
            return;
          }
          const inner = waiter.resolve;
          waiter.resolve = (decision) => {
            inner(decision);
            resolve(decision);
          };
        }),
      record: recordAgent,
    });
    // Removed through the signal (the standard's way) and, where a browser
    // offers it, an explicit unregister.
    const controller = new AbortController();
    void registerTool(context, tool, controller.signal);
    return () => {
      // The decision that clears the proposal also resolves a call to this
      // tool that may be in flight; removing the tool in the same tick makes
      // the browser report that call as failed. Let the answer land first.
      window.setTimeout(() => {
        controller.abort();
        void context.unregisterTool?.(tool.name);
      }, UNREGISTER_GRACE_MS);
    };
  }, [pendingProposalHandle, recordAgent]);

  const everyWord = project === null ? [] : collectRenderedText(project);
  const sensitive = project === null ? [] : scanForSensitive(project);
  const pendingSensitive =
    pending?.request.kind === "proposal" ? scanForSensitive(pending.request.after) : [];
  const unread = everyWord.filter(
    (entry) => entry.messageId && touched.has(entry.messageId),
  ).length;

  const supportLine =
    support === "ready"
      ? "Site tools registered. Ask your browser's agent to write or direct the session."
      : support === "shim"
        ? "Development shim: no agent attached. Tools answer to navigator.modelContext.executeTool() in the console."
        : support === "checking"
          ? "Registering site tools…"
          : supportDetail
            ? `Site tools could not be registered: ${supportDetail}`
            : "WebMCP is not available in this browser. The stage still works by hand.";

  const tabs: Array<{ id: RailTab; label: string; badge?: number }> = [
    { id: "agent", label: "Agent", badge: activity.length > 0 ? activity.length : undefined },
    { id: "scripts", label: "Scripts" },
    { id: "words", label: "Words", badge: unread > 0 ? unread : undefined },
  ];

  const requestCard =
    pending !== null ? (
      <section className="rail-request" aria-live="polite">
        {pending.request.kind === "proposal" ? (
          <>
            <h2>The agent proposes {pending.request.changes.length} change(s)</h2>
            {pending.request.note ? <p className="rail-note">{pending.request.note}</p> : null}
            <ul className="rail-diff">
              {pending.request.changes.map((entry) => {
                const rewritten = rewrittenContent(pending.request, entry.path);
                return (
                  <li key={entry.path}>
                    <span className="rail-meta">{entry.path}</span>
                    {rewritten !== null ? (
                      <span className="rail-diff-text">{rewritten}</span>
                    ) : (
                      <span>
                        <s>{String(entry.before ?? "—")}</s> → <b>{String(entry.after ?? "—")}</b>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <>
            <h2>The agent asks to export</h2>
            <p className="rail-note">
              {pending.request.exportKind}
              {pending.request.allPages ? ", every page" : ", this page"}. The files download to
              this device.
            </p>
          </>
        )}
        {pendingSensitive.length > 0 ? (
          <ul className="rail-hints">
            {pendingSensitive.map((hit) => (
              <li key={`${hit.path}-${hit.message}`}>
                <span className="rail-meta">{hit.path}</span> {hit.message}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="rail-actions">
          <button type="button" className="pill is-primary" onClick={approve}>
            {pending.request.kind === "proposal" ? "Approve" : "Export"}
          </button>
          <button type="button" className="pill" onClick={reject}>
            Reject
          </button>
        </div>
      </section>
    ) : null;

  return (
    <div
      className="agent-stage"
      data-ui-theme={uiTheme}
      data-chrome={chrome}
      data-rail={railOpen ? "open" : "closed"}
    >
      <div className="agent-stage-studio">
        <Studio
          ref={studioRef}
          chrome={chrome}
          locale="en"
          product={PRODUCT}
          onThemeChange={setUiTheme}
          onProjectChange={onStudioProject}
        />
      </div>
      {!railOpen ? (
        <button
          type="button"
          className="rail-handle pill"
          aria-expanded={false}
          aria-controls="director"
          onClick={toggleRail}
        >
          Agent
          {pending !== null ? <span className="rail-badge">1</span> : null}
        </button>
      ) : null}
      <aside className="rail" id="director" aria-label="Agent panel" hidden={!railOpen}>
        <header className="rail-head">
          <div className="rail-title">
            <h1>Agent</h1>
            <div className="rail-title-actions">
              {chrome === "stage" ? (
                <button type="button" className="pill" onClick={() => showChrome("full")}>
                  Show editor
                </button>
              ) : (
                <button type="button" className="pill" onClick={() => showChrome("stage")}>
                  Stage only
                </button>
              )}
              <button
                type="button"
                className="pill"
                onClick={toggleRail}
                aria-expanded={true}
                aria-controls="director"
              >
                Hide
              </button>
            </div>
          </div>
          <p className="rail-support" data-state={support}>
            {supportLine}
          </p>
        </header>

        <nav className="rail-tabs" aria-label="Agent panel sections">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={railTab === tab.id ? "is-active" : ""}
              onClick={() => setRailTab(tab.id)}
            >
              {tab.label}
              {tab.badge !== undefined ? <span className="rail-tab-badge">{tab.badge}</span> : null}
            </button>
          ))}
        </nav>

        <div className="rail-body">
          {requestCard}

          {railTab === "agent" ? (
            <>
              <section className="rail-section">
                <h2>Try asking</h2>
                <ul className="rail-prompts">
                  {PROMPTS_TO_TRY.map((prompt) => (
                    <li key={prompt}>
                      <button
                        type="button"
                        className="rail-prompt"
                        onClick={() => void copyPrompt(prompt)}
                        title="Copy to paste into the chat"
                      >
                        <span className="rail-prompt-text">“{prompt}”</span>
                        <span className="rail-prompt-copy">
                          {copied === prompt ? "Copied" : "Copy"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="rail-section">
                <div className="rail-section-head">
                  <h2>Activity</h2>
                  <button
                    type="button"
                    className="pill"
                    onClick={undo}
                    disabled={history.length === 0}
                  >
                    Undo{history.length > 0 ? ` · ${history.length}` : ""}
                  </button>
                </div>
                {activity.length === 0 ? (
                  <p className="rail-empty">
                    Everything the agent does lands here, one undo away. Click a line to jump the
                    preview to the message it touched.
                  </p>
                ) : (
                  <ol className="rail-log">
                    {activity.map((entry) => (
                      <li key={entry.id} data-ok={entry.ok} data-actor={entry.actor}>
                        <button
                          type="button"
                          className="rail-log-line"
                          disabled={!entry.affectedMessageIds?.length}
                          onClick={() => jumpTo(entry)}
                        >
                          <span className="rail-log-actor">{entry.actor}</span>
                          <span className="rail-meta">{entry.tool}</span>
                          <span className="rail-log-summary">{entry.summary}</span>
                        </button>
                        {entry.frame ? (
                          <img
                            className="rail-log-frame"
                            src={entry.frame}
                            alt="Frame the agent looked at"
                          />
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          ) : null}

          {railTab === "scripts" ? (
            <>
              <section className="rail-section">
                <h2>Showcase scripts</h2>
                <ul className="rail-showcases">
                  {SHOWCASES.map((showcase) => (
                    <li key={showcase.id}>
                      <button
                        type="button"
                        className="rail-showcase"
                        onClick={() => loadShowcase(showcase.id)}
                      >
                        <span className="rail-showcase-label">{showcase.label}</span>
                        <span className="rail-showcase-hint">{showcase.hint}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="rail-section" hidden={chrome === "full"}>
                <h2>Your direction</h2>
                <div className="rail-direction">
                  <span className="rail-meta">Surface</span>
                  <div className="pill-row">
                    {(["app", "tui"] as const).map((surface) => (
                      <button
                        type="button"
                        key={surface}
                        className="pill"
                        aria-pressed={project?.surface === surface}
                        onClick={() => direct({ surface }, `surface → ${surface}`)}
                      >
                        {surface === "app" ? "App" : "TUI"}
                      </button>
                    ))}
                  </div>
                  <span className="rail-meta">Theme</span>
                  <div className="pill-row">
                    {DIRECTION_CHOICES.themes.map((theme) => (
                      <button
                        type="button"
                        key={theme.id}
                        className="swatch"
                        title={theme.label}
                        aria-label={theme.label}
                        aria-pressed={project?.appearance.theme === theme.id}
                        style={{ background: theme.background, borderColor: theme.accent }}
                        onClick={() => direct({ theme: theme.id }, `theme → ${theme.label}`)}
                      />
                    ))}
                  </div>
                  <span className="rail-meta">Size</span>
                  <div className="pill-row">
                    {DIRECTION_CHOICES.sizes.map((size) => (
                      <button
                        type="button"
                        key={size.id}
                        className="pill"
                        title={`${size.width}×${size.height} · ${size.hint}`}
                        aria-pressed={
                          project?.appearance.canvasWidth === size.width &&
                          project?.appearance.canvasHeight === size.height
                        }
                        onClick={() => direct({ sizePreset: size.id }, `size → ${size.label}`)}
                      >
                        {size.label}
                      </button>
                    ))}
                  </div>
                  <span className="rail-meta">Pacing</span>
                  <div className="pill-row">
                    {DIRECTION_CHOICES.pacing.map((pacing) => (
                      <button
                        type="button"
                        key={pacing.id}
                        className="pill"
                        title={pacing.description}
                        onClick={() =>
                          direct({ pacingPreset: pacing.id }, `pacing → ${pacing.label}`)
                        }
                      >
                        {pacing.label}
                      </button>
                    ))}
                  </div>
                  <span className="rail-meta">Camera</span>
                  <div className="pill-row">
                    <button
                      type="button"
                      className="pill"
                      aria-pressed={project?.camera.follow === true}
                      onClick={() =>
                        directCamera(
                          { follow: !(project?.camera.follow ?? false) },
                          project?.camera.follow ? "camera off" : "camera on",
                        )
                      }
                    >
                      {project?.camera.follow ? "Following" : "Follow"}
                    </button>
                    {CAMERA_STYLES.map((style) => (
                      <button
                        type="button"
                        key={style}
                        className="pill"
                        disabled={project?.camera.follow !== true}
                        aria-pressed={
                          project?.camera.follow === true && project.camera.style === style
                        }
                        onClick={() => directCamera({ follow: true, style }, `camera → ${style}`)}
                      >
                        {style}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {railTab === "words" ? (
            <>
              <section className="rail-section">
                <h2>What the agent may write</h2>
                <div className="pill-row">
                  {(["fictionalized", "as-told"] as const).map((mode) => (
                    <button
                      type="button"
                      key={mode}
                      className="pill"
                      aria-pressed={privacy === mode}
                      onClick={() => {
                        setPrivacy(mode);
                        record({ actor: "you", tool: "privacy", summary: mode, ok: true });
                      }}
                    >
                      {mode === "fictionalized" ? "Fictionalized" : "As told"}
                    </button>
                  ))}
                </div>
                <p className="rail-fine">{PRIVACY_MODE_TEXT[privacy]}</p>
                <details className="rail-details">
                  <summary>The rule the agent reads</summary>
                  <p className="rail-fine">{PRIVACY_DEFAULT}</p>
                  <p className="rail-fine">
                    A loaded script keeps only the fields that render; anything else is dropped and
                    named in the agent's result. The look, fonts, images and camera are directed
                    through their own tools, never carried inside a script.
                  </p>
                </details>
              </section>
              <section className="rail-section">
                <div className="rail-section-head">
                  <h2>Every word on the stage</h2>
                  <button
                    type="button"
                    className="pill"
                    disabled={touched.size === 0}
                    onClick={() => setTouched(new Set())}
                  >
                    Mark read{unread > 0 ? ` · ${unread}` : ""}
                  </button>
                </div>
                {sensitive.length > 0 ? (
                  <ul className="rail-hints">
                    {sensitive.map((hit) => (
                      <li key={`${hit.path}-${hit.message}`}>
                        <span className="rail-meta">{hit.path}</span> {hit.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <ol className="rail-words">
                  {everyWord.map((entry, index) => (
                    <li
                      key={`${entry.where}-${index}`}
                      data-new={entry.messageId !== undefined && touched.has(entry.messageId)}
                    >
                      <span className="rail-meta">
                        {entry.where}
                        {entry.hiddenBy ? <em> · {entry.hiddenBy}</em> : null}
                      </span>
                      <span className="rail-words-text">{entry.text}</span>
                    </li>
                  ))}
                </ol>
              </section>
            </>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
