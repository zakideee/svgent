import type { ResolvedBrowserFont } from "@boundsvg/browser";
import { GENERATED_SAMPLE_IMAGES } from "@svgent/assets";
import { assertIdentifierNamespace, documentIdPrefix } from "@svgent/render";
import {
  buildSvgentScene,
  collectProjectCharacters,
  countVisibleCharacters,
  createMessage,
  currentToolVersions,
  describeMissingGlyphs,
  deserializeProject,
  draftTimelineIssues,
  type FontChoice,
  type FontSlot,
  findProjectMissingGlyphs,
  MAX_DRAFT_RUN_CLUSTERS,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
  MAX_PROJECT_DURATION_MS,
  type ModelLabelIssueCode,
  messageAtTime,
  messageIdToken,
  modelLabelIssue,
  paginateMessages,
  type ScriptProvenance,
  type SessionMessage,
  type SvgentProject,
  serializeProject,
  stripDraftMarkup,
} from "@svgent/scene";
import type React from "react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { version as studioVersion } from "../package.json";
import { AssistDialog } from "./assist.js";
import {
  clearAutosave,
  freshProjectFor,
  initialProject,
  type RestoredProject,
  restoreNoticeText,
  useAutosave,
} from "./autosave.js";
import { useDialogLightDismiss } from "./dialogs.js";
import { useSvgentEngine } from "./engine.js";
import { ExportDialog, useExportOverlay } from "./export-panel.js";
import { useExportRunner } from "./export-runner.js";
import { SegmentedField } from "./fields.js";
import {
  fontProvenance,
  readUploadedFont,
  resolveFonts,
  type UploadedFonts,
  unresolvableFontSlots,
} from "./fonts.js";
import { GalleryDialog, usePresetPreviews } from "./gallery.js";
import { initialLang, LANG_STORAGE_KEY, type Lang, UI_STRINGS, type UiStrings } from "./i18n.js";
import {
  ArrowIcon,
  ChevronIcon,
  DownloadIcon,
  GitHubIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  StepIcon,
  SunIcon,
  WidthIcon,
} from "./icons.js";
import { IMAGE_ACCEPT } from "./images.js";
import { fontUploadId, useInstanceIdentifier } from "./instance.js";
import {
  AutosaveFailedNotice,
  AutosaveNotOwnedNotice,
  UndoNotice,
  UseNoteToast,
} from "./notices.js";
import { useRaisedOverlay } from "./overlays.js";
import { MotionTab } from "./panel/motion-tab.js";
import { SceneTab } from "./panel/scene-tab.js";
import { ScriptTab } from "./panel/script-tab.js";
import { StyleTab } from "./panel/style-tab.js";
import {
  claimPersistenceNamespace,
  createLocalStoragePersistence,
  ownsPersistenceNamespace,
  readOnlyPersistence,
  releasePersistenceNamespace,
  subscribeToPersistenceNamespaces,
} from "./persistence.js";
import {
  FRAME_STEP_MS,
  formatDuration,
  readAnimationTimeMs,
  usePageVisible,
  usePlaybackClock,
} from "./playback.js";
import { instantiatePreset, SCRIPT_PRESETS, type ScriptPreset } from "./presets.js";
import { useProjectActions } from "./project-actions.js";
import type {
  StudioExportResult,
  StudioHandle,
  StudioProductConfig,
  StudioProps,
} from "./public-types.js";
import { insertAtScrubAnchor } from "./scrub.js";
import { useStageActions } from "./stage/actions.js";
import { useStageGestures } from "./stage/gestures.js";
import { META_EDIT_ATTR, type OutlineRect, outlineRectFor } from "./stage/hit-testing.js";
import { PreviewStage, type StageInput, SvgInspector } from "./stage/stage-view.js";
import { STAGE_FLIGHT_GLIDE_MS, useStageFlightAim, useStageFlightState } from "./stage-flight.js";
import { buildSourceView } from "./svg-source-view.js";
import { useReportedTheme } from "./theme-report.js";
import { restoreIndexFor, useScriptUndo } from "./undo.js";
import {
  WIZARD_EDIT_STEP,
  WIZARD_EXPORT_STEP,
  WIZARD_SCRIPT_STEP,
  WizardOverlay,
} from "./wizard.js";

type PanelTab = "script" | "scene" | "style" | "motion";
type UiTheme = "dark" | "light";

const UI_THEME_STORAGE_KEY = "ui-theme";

/** Wordmark artwork, one per theme: the two differ only in the ink colour. */
const LIGHT_WORDMARK = "/brand/svgent-wordmark.svg";
const DARK_WORDMARK = "/brand/svgent-wordmark-dark.svg";
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar-width";
const WIZARD_SEEN_KEY = "wizard-seen";
const DEFAULT_RESOLVE_ASSET_URL = (assetPath: string): string => `/${assetPath}`;
const DEFAULT_PRODUCT = {
  name: "svgent",
  version: studioVersion,
  engineVersion: "unknown",
  repositoryUrl: "https://github.com/zakideee/svgent",
  storageKeyPrefix: "svgent",
} as const;

/** Total visible-character budget for animated text across the script. */
const TOTAL_CHARACTER_BUDGET = 3_200;

/**
 * Keeps `--header-h` equal to the header that is actually on screen.
 *
 * Everything that has to start below the header reads this — the overlays'
 * inset, the shell's height, the stage's cap — and it was a constant while the
 * header is not. A phone drops the status line and tightens the padding, which
 * left 13px reserved for nothing; narrow enough and the actions wrap to a
 * second row, at which point the header was 85px against a reserved 58px and
 * covered the top of whatever overlay was open, because it sits above them.
 *
 * Measured, both cases come out right on their own.
 */
function useMeasuredHeaderHeight(
  headerRef: React.RefObject<HTMLElement | null>,
  shellRef: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const header = headerRef.current;
    if (header === null) {
      // No header drawn (the stage-only chrome): nothing to stay below.
      shellRef.current?.style.setProperty("--header-h", "0px");
      return;
    }
    const apply = () => {
      const { height } = header.getBoundingClientRect();
      shellRef.current?.style.setProperty("--header-h", `${Math.round(height)}px`);
    };
    apply();
    const sizes = new ResizeObserver(apply);
    sizes.observe(header);
    return () => sizes.disconnect();
  }, [headerRef, shellRef]);
}

/**
 * Phones keep focus in a textarea after the software keyboard is
 * dismissed, which leaves the edit pin (frozen preview and slider) on
 * with nothing visibly causing it. When the visual viewport grows back
 * to full height on a touch device, the typing is over — release the
 * pin by blurring whatever still holds focus.
 */
function useKeyboardDismissBlur(shellRef: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
      return;
    }
    let keyboardOpen = false;
    const onViewportResize = () => {
      const openNow = viewport.height < window.innerHeight * 0.8;
      // The viewport is the whole page's, so every studio on it hears the
      // keyboard close. Only the one holding the field may take the focus away
      // — otherwise a studio blurs another studio's editor, or the host's.
      const active = document.activeElement;
      const mine = active instanceof Node && (shellRef.current?.contains(active) ?? false);
      if (keyboardOpen && !openNow && mine && active instanceof HTMLTextAreaElement) {
        active.blur();
      }
      keyboardOpen = openNow;
    };
    viewport.addEventListener("resize", onViewportResize);
    return () => viewport.removeEventListener("resize", onViewportResize);
  }, [shellRef]);
}

/** Devtool source panel heights — the excerpt sizes live in svg-source-view. */
const SOURCE_MIN_PX = 140;
const SOURCE_DEFAULT_PX = 280;

const SIDEBAR_MIN_PX = 320;
const SIDEBAR_MAX_PX = 760;
const SIDEBAR_DEFAULT_PX = 520;
const SIDEBAR_WIDE_PX = 680;

function initialUiTheme(
  persistence: ReturnType<typeof createLocalStoragePersistence> | null,
): UiTheme {
  try {
    return persistence?.getItem(UI_THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function initialSidebarWidth(
  persistence: ReturnType<typeof createLocalStoragePersistence> | null,
): number {
  try {
    const stored = Number(persistence?.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= SIDEBAR_MIN_PX && stored <= SIDEBAR_MAX_PX
      ? stored
      : SIDEBAR_DEFAULT_PX;
  } catch {
    return SIDEBAR_DEFAULT_PX;
  }
}

/**
 * What the export run button can act on: a rendered artifact, or the
 * script JSON itself — a radio like the rest, so no chip ever downloads
 * on first tap.
 */
function modelIssueText(code: ModelLabelIssueCode | null, t: UiStrings): string | null {
  if (code === null) {
    return null;
  }
  return code === "empty" ? t.modelIssueEmpty : t.modelIssueTooLong;
}

/**
 * The number the export gate and the budget meter must agree on. A choice
 * answered in the user's own words is keyed at the prompt like any other
 * message, so its answer counts too.
 */
function totalVisibleCharacters(messages: SvgentProject["messages"]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      countVisibleCharacters(stripDraftMarkup(message.content)) +
      countVisibleCharacters(stripDraftMarkup(message.freeform ?? "")),
    0,
  );
}

function projectIssues(project: SvgentProject, t: UiStrings): string[] {
  const issues: string[] = [];
  const labelIssue = modelIssueText(modelLabelIssue(project.modelLabel), t);
  if (labelIssue) {
    issues.push(labelIssue);
  }
  if (project.messages.length === 0) {
    issues.push(t.issueNeedMessage);
  }
  if (project.messages.length > MAX_MESSAGES) {
    issues.push(t.issueMaxMessages(MAX_MESSAGES));
  }
  if (totalVisibleCharacters(project.messages) > TOTAL_CHARACTER_BUDGET) {
    issues.push(t.issueTotalCharacters);
  }
  // Images on roles that never render them are flagged in the card's own
  // image list and by the publication check — advisory only, because the
  // issues list gates the export buttons and invisible weight is not a
  // reason to block an export.
  project.messages.forEach((message, index) => {
    if (message.content.length > MAX_MESSAGE_CHARS) {
      issues.push(t.issueMessageTooLong(index + 1, MAX_MESSAGE_CHARS.toLocaleString()));
    }
  });
  for (const issue of draftTimelineIssues(project)) {
    switch (issue.code) {
      case "ime-run-too-long":
        issues.push(t.issueImeRunTooLong((issue.messageIndex ?? 0) + 1, MAX_DRAFT_RUN_CLUSTERS));
        break;
      case "duration-too-short":
        issues.push(t.issueDraftDurationTooShort((issue.messageIndex ?? 0) + 1));
        break;
      case "project-too-long":
        issues.push(t.issueProjectTooLong(MAX_PROJECT_DURATION_MS / 1_000));
        break;
    }
  }
  return issues;
}

/**
 * Which drawer of device storage this studio saves into. It follows the
 * caller's own id and never the derived one: `useId` answers to the shape of
 * the React tree, so a component added above this one would rename the drawer
 * and lose every script saved in it.
 *
 * A caller's value is checked, not repaired. Deleting the characters it
 * rejects is not injective — `pane/left` and `pane.left` would arrive as one
 * namespace, which is the collision this exists to prevent.
 */
export function storageNamespaceFor(
  product: StudioProductConfig,
  instanceId: string | undefined,
): string {
  if (instanceId === undefined) {
    return product.storageKeyPrefix;
  }
  assertIdentifierNamespace(instanceId);
  return `${product.storageKeyPrefix}-${instanceId}`;
}

/**
 * Miniature layout wireframe for a display preset: which chrome elements
 * survive and roughly how large the text runs, at a glance. Bar thickness
 * tracks fontScale so "huge" visibly fits fewer lines than "compact".
 */
export function App({
  initialProject: suppliedProject,
  chrome = "full",
  ref,
  instanceId,
  locale,
  onboarding = false,
  persistence: suppliedPersistence,
  product = DEFAULT_PRODUCT,
  resolveAssetUrl = DEFAULT_RESOLVE_ASSET_URL,
  onProjectChange,
  onLocaleChange,
  onThemeChange,
  onExport,
  onError,
}: StudioProps = {}) {
  const storageNamespace = storageNamespaceFor(product, instanceId);
  const basePersistence = useMemo(
    () =>
      suppliedPersistence === false
        ? null
        : (suppliedPersistence ?? createLocalStoragePersistence(storageNamespace)),
    [storageNamespace, suppliedPersistence],
  );
  const [persistenceOwner] = useState(() => Symbol("studio-persistence"));
  // Storage is one drawer per namespace, and whichever studio is at the head
  // of its queue is the only one that writes. Read out of the queue rather
  // than assumed: a studio that guessed it owned the drawer would write a
  // whole commit's worth of settings into another studio's before the guess
  // was corrected. A caller that supplies its own persistence owns the
  // question, and answers yes.
  const claims = suppliedPersistence === undefined && basePersistence !== null;
  const ownsPersistence = useSyncExternalStore(
    useCallback(
      (onOwnersChanged: () => void) => {
        if (!claims) {
          return () => {};
        }
        const unsubscribe = subscribeToPersistenceNamespaces(onOwnersChanged);
        claimPersistenceNamespace(storageNamespace, persistenceOwner);
        return () => {
          unsubscribe();
          releasePersistenceNamespace(storageNamespace, persistenceOwner);
        };
      },
      [claims, storageNamespace, persistenceOwner],
    ),
    () => !claims || ownsPersistenceNamespace(storageNamespace, persistenceOwner),
  );
  const persistence = useMemo(
    () =>
      basePersistence !== null && !ownsPersistence
        ? readOnlyPersistence(basePersistence)
        : basePersistence,
    [basePersistence, ownsPersistence],
  );
  // Every element this studio reaches for is looked up inside its own shell,
  // and every listener that reacts to one is bound to the shell rather than to
  // the document. Another studio's controls are another studio's business.
  // Two studios sharing a page carry the same class names, and both start from
  // the same script, so `[data-message-id]` collides outright: a document-wide
  // query would hand one studio the other's card, and the first match wins.
  const shellRef = useRef<HTMLDivElement>(null);
  const inShell = <T extends Element>(selector: string): T | null =>
    shellRef.current?.querySelector<T>(selector) ?? null;
  const [resolvedFonts, setResolvedFonts] = useState<ResolvedBrowserFont[] | null>(null);
  const engineState = useSvgentEngine(resolvedFonts);
  // Read once, at the first render, and kept: a later studio restoring its own
  // autosave says nothing about what this one opened on.
  const [openedFrom] = useState<RestoredProject>(() =>
    suppliedProject === undefined
      ? initialProject(basePersistence, locale ?? initialLang(basePersistence))
      : { project: suppliedProject, restored: false, omittedImages: 0 },
  );
  const [project, setProject] = useState<SvgentProject>(openedFrom.project);
  const [panelTab, setPanelTab] = useState<PanelTab>("script");
  const [pageIndex, setPageIndex] = useState(0);
  const [sampleTimeMs, setSampleTimeMs] = useState(0);
  const [restartKey, setRestartKey] = useState(0);
  // One transport, one clock: `playing` is the whole mode axis. Paused is
  // where the old scrub mode lived — the slider seeks the CSS animations
  // in place and direct message editing becomes available.
  const [playing, setPlaying] = useState(true);
  const [uiError, setUiError] = useState<Error | null>(null);
  // Artifacts produced by a `StudioHandle.exportArtifact` call in flight.
  const handleExportsRef = useRef<StudioExportResult[] | null>(null);
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => initialUiTheme(persistence));
  const [lang, setLang] = useState<Lang>(() => locale ?? initialLang(persistence));
  const [showSvgInspector, setShowSvgInspector] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => initialSidebarWidth(persistence));
  const [inlineEdit, setInlineEdit] = useState<{ messageId: string; x: number; y: number } | null>(
    null,
  );
  const [stageInput, setStageInput] = useState<StageInput | null>(null);
  const stageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const imageReplaceInputRef = useRef<HTMLInputElement | null>(null);
  /** Which banner a canvas click is replacing, until the picker returns. */
  const pendingImageRef = useRef<{ messageId: string; index: number } | null>(null);
  const [scrubFollowMessageId, setScrubFollowMessageId] = useState<string | null>(null);
  const [inspectedNodeId, setInspectedNodeId] = useState<string | null>(null);
  const [hoverOutline, setHoverOutline] = useState<OutlineRect | null>(null);
  // The editable element under the mouse, outlined as an affordance.
  const [editHover, setEditHover] = useState<OutlineRect | null>(null);
  const [pinnedOutline, setPinnedOutline] = useState<OutlineRect | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  // Samples live in a dedicated dialog: applying one auto-closes it, so the
  // message list keeps the full panel height at all times.
  const galleryDialogRef = useRef<HTMLDialogElement | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);
  // The preset the current script started from — a starting point, not an
  // identity. The first message change after applying demotes it to edited
  // and drops the card highlight, so nothing may assume the messages still
  // match the preset's content.
  const [appliedPreset, setAppliedPreset] = useState<{ id: string; edited: boolean } | null>(null);
  /** The next messages change is a wholesale replacement (sample apply,
      new script, reset), not a hand edit. */
  const scriptJustReplacedRef = useRef(false);
  /** Whether the current messages hold the user's own work. A pristine
      default, a blank new script, or an untouched sample does not — so
      replacing it needs no confirm. A restored autosave always does. */
  const hasAuthoredMessagesRef = useRef(openedFrom.restored);
  const [settingsHoldReleased, setSettingsHoldReleased] = useState(false);
  const [sourceHeight, setSourceHeight] = useState(SOURCE_DEFAULT_PX);
  const sourceHeightBeforeExpand = useRef(SOURCE_DEFAULT_PX);
  const [fieldFlash, setFieldFlash] = useState<OutlineRect | null>(null);
  const fieldFlashTimer = useRef<number | undefined>(undefined);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const previewColumnRef = useRef<HTMLElement | null>(null);

  // The phone's sticky preview block changes height (sheet drag, aspect,
  // collapse); the panel tab bar sticks right under it, so its offset has
  // to track the measured height instead of re-deriving the CSS formula.
  useEffect(() => {
    const column = previewColumnRef.current;
    if (!column || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      shellRef.current?.style.setProperty(
        "--preview-block-px",
        `${Math.round(column.getBoundingClientRect().height)}px`,
      );
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);
  const [uploadedFonts, setUploadedFonts] = useState<UploadedFonts>({});
  const [fontError, setFontError] = useState<string | null>(null);

  useEffect(() => {
    onProjectChange?.(project);
  }, [onProjectChange, project]);

  useEffect(() => {
    if (uiError !== null) {
      onError?.(uiError);
    }
  }, [onError, uiError]);

  useEffect(() => {
    if (fontError !== null) {
      onError?.(new Error(fontError));
    }
  }, [fontError, onError]);

  // The host hears about a studio that cannot save; the notice stack tells the
  // person using it.
  const reportOwnershipLoss = useEffectEvent(() => {
    onError?.(
      new Error(
        `Another studio on this page already saves under "${storageNamespace}", so this one will not write to it. Give each <Studio> its own instanceId.`,
      ),
    );
  });
  useEffect(() => {
    if (!ownsPersistence) {
      reportOwnershipLoss();
    }
  }, [ownsPersistence]);

  // `useId` is unique within a React root, not across roots: two createRoot
  // mounts hand out the same value. A caller who cannot reach those roots
  // passes its own, the way `storageKeyPrefix` already works.
  const derivedInstance = useInstanceIdentifier();
  const instance = instanceId ?? derivedInstance;

  const {
    presetThumbs,
    presetMotion,
    hoverPresetId,
    hoverPreset,
    clearPresetHover,
    renderPresetThumbs,
  } = usePresetPreviews({
    engineState,
    project,
    lang,
    galleryOpen,
    generator: { name: product.name, version: product.version },
    instance,
  });

  /** Whether this card is the unedited starting point of the current script. */
  const isAppliedPreset = (presetId: string): boolean =>
    appliedPreset !== null && !appliedPreset.edited && appliedPreset.id === presetId;

  // Demote the applied-preset marker on the first message change after
  // applying; replacements pass through via the ref guard and leave a
  // script that holds no user work yet. Reference equality is the edit
  // signal, so the check stays O(1) per render.
  const lastMessagesRef = useRef(project.messages);
  useEffect(() => {
    if (lastMessagesRef.current === project.messages) {
      return;
    }
    lastMessagesRef.current = project.messages;
    if (scriptJustReplacedRef.current) {
      scriptJustReplacedRef.current = false;
      hasAuthoredMessagesRef.current = false;
      // A wholesale replacement orphans pending undo entries: restoring a
      // message from the previous script into the new one would be wrong.
      scriptUndo.drop();
      return;
    }
    hasAuthoredMessagesRef.current = true;
    setAppliedPreset((current) =>
      current === null || current.edited ? current : { ...current, edited: true },
    );
  });

  const t = UI_STRINGS[lang];

  const scene = useMemo(
    () =>
      buildSvgentScene(project, pageIndex, {
        // With the engine attached, message heights are measured by a probe
        // layout instead of estimated, so auto-scroll lands exactly.
        engine: engineState.status === "ready" ? engineState.engine : undefined,
        generator: { name: product.name, version: product.version },
        fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
      }),
    [pageIndex, product.name, product.version, project, engineState],
  );
  const issues = useMemo(() => projectIssues(project, t), [project, t]);
  const totalCharacters = totalVisibleCharacters(project.messages);

  const googleActive =
    project.fonts.sans.source === "google" || project.fonts.mono.source === "google";
  const subsetText = useMemo(
    () => (googleActive ? collectProjectCharacters(project) : ""),
    [googleActive, project],
  );
  // Characters the loaded fonts cannot draw. Probed against the character set
  // rather than the scene, so an edit costs one small layout regardless of how
  // long the transcript is.
  const missingGlyphs = useMemo(
    () =>
      engineState.engine === null ? [] : findProjectMissingGlyphs(engineState.engine, project),
    [engineState.engine, project],
  );

  // Content-value key: project.fonts may be recreated by unrelated project
  // edits, and a string compares by value. Uploads are NOT folded in — a
  // re-upload of the same file name must still re-resolve, and the
  // uploadedFonts state object changes identity exactly then.
  const fontsKey = JSON.stringify(project.fonts);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fontsKey stands in for project.fonts by value
  useEffect(() => {
    let cancelled = false;
    // Debounce only google fetches: typing new characters into the script
    // changes the subset and would otherwise refetch per keystroke.
    const timer = window.setTimeout(
      () => {
        void resolveFonts({
          settings: project.fonts,
          uploads: uploadedFonts,
          subsetText,
          t,
          resolveAssetUrl,
        })
          .then((fonts) => {
            if (!cancelled) {
              setResolvedFonts(fonts);
              setFontError(null);
            }
          })
          .catch((cause: unknown) => {
            if (!cancelled) {
              setFontError(cause instanceof Error ? cause.message : String(cause));
            }
          });
      },
      googleActive ? 700 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fontsKey, subsetText, googleActive, uploadedFonts, t, resolveAssetUrl]);

  useEffect(() => {
    try {
      persistence?.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      // Ignore storage failures.
    }
    onLocaleChange?.(lang);
  }, [lang, persistence, onLocaleChange]);

  // The theme is an attribute on this studio's own shell, not on the document:
  // an embedded studio repainting the page around it is the host's decision,
  // not the studio's. A host that wants the page to follow says so by taking
  // `onThemeChange`.
  useReportedTheme(uiTheme, onThemeChange);
  // Storage is not what the page is waiting for, so it is not asked for before
  // paint. A host that sets state from the theme callback can still pull this
  // forward into the same frame; what it must not do is hold the frame open
  // itself.
  useEffect(() => {
    try {
      persistence?.setItem(UI_THEME_STORAGE_KEY, uiTheme);
    } catch {
      // Private-mode storage failures are fine; the toggle still works.
    }
  }, [uiTheme, persistence]);

  useEffect(() => {
    try {
      persistence?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Ignore storage failures.
    }
  }, [sidebarWidth, persistence]);

  // Reset-on-change: the dependency list is the trigger, not something the
  // body reads. Biome reports these as unnecessary and they are load-bearing.
  useEffect(() => {
    setInlineEdit(null);
    setStageInput(null);
    setPinnedOutline(null);
    setHoverOutline(null);
    setInspectedNodeId(null);
  }, []);

  // Watching was a one-off: the next edit or tab switch goes back to the
  // instant-feedback hold.
  useEffect(() => {
    setSettingsHoldReleased(false);
  }, []);

  useEffect(() => {
    // A scrub jump can move every element; a stale outline would lie.
    setPinnedOutline(null);
    setHoverOutline(null);
  }, []);

  useEffect(() => {
    if (pageIndex >= scene.pageCount) {
      setPageIndex(Math.max(0, scene.pageCount - 1));
    }
  }, [pageIndex, scene.pageCount]);

  // While a message editor has focus, follow it: switch to its page and
  // freeze the preview on that message's reveal-complete frame, so edits
  // appear instantly instead of after a full replay reaches them.
  useEffect(() => {
    if (focusedMessageId === null) {
      return;
    }
    const page = scene.messagePage[focusedMessageId];
    if (page !== undefined && page !== scene.pageIndex) {
      setPageIndex(page);
    }
  }, [focusedMessageId, scene]);

  useEffect(() => {
    setSampleTimeMs((current) => Math.min(current, scene.durationMs));
  }, [scene.durationMs]);

  // A newly inserted user turn may repaginate the script. Follow it only
  // after the rebuilt scene knows its page and reveal time.
  useEffect(() => {
    if (scrubFollowMessageId === null) {
      return;
    }
    const targetPage = scene.messagePage[scrubFollowMessageId];
    if (targetPage === undefined) {
      return;
    }
    if (targetPage !== scene.pageIndex) {
      setPageIndex(targetPage);
      return;
    }
    const revealMs = scene.messageRevealMs[scrubFollowMessageId];
    if (revealMs !== undefined) {
      setSampleTimeMs(revealMs);
      setScrubFollowMessageId(null);
    }
  }, [scene, scrubFollowMessageId]);

  // Static frame to hold while editing: the focused (sidebar) or inline-
  // edited (preview click) message's reveal end. Clicking a message during
  // playback therefore pauses on it instead of racing the animation.
  const pinnedMessageId = focusedMessageId ?? inlineEdit?.messageId ?? null;
  const editFollowTimeMs =
    pinnedMessageId !== null ? (scene.messageRevealMs[pinnedMessageId] ?? null) : null;
  const currentScrubTiming = !playing
    ? messageAtTime(scene.messageTimings, editFollowTimeMs ?? sampleTimeMs)
    : null;
  const currentScrubMessageId = currentScrubTiming?.message.id ?? null;
  // On the Scene/Style tabs the preview holds the final frame: every
  // element is visible there, so a setting change shows its effect
  // instantly instead of after a replay crawls back to it. The Motion tab
  // keeps playing — that is what its knobs tune. Pressing Playback or
  // Play again releases the hold ("I want to watch now"); the next
  // setting change or tab switch re-engages it.
  const settingsHold = (panelTab === "style" || panelTab === "scene") && !settingsHoldReleased;

  // Only the markup generation is deferred, never the scene: the scrub
  // range, page clamping, and the edit-follow pin all read `scene` and
  // must answer the keystroke that caused them. Rendering the scene to a
  // ~800 KB string is the expensive half, and the preview is the one
  // consumer that can lag a beat without any of them noticing.
  const deferredScene = useDeferredValue(scene);
  const { previewSvg, previewError } = useMemo((): {
    previewSvg: string | null;
    previewError: Error | null;
  } => {
    if (engineState.status !== "ready") {
      return { previewSvg: null, previewError: null };
    }
    // Paused frames stay on the declarative render — the slider seeks the
    // live CSS animations instead of swapping in a static sample, so the
    // pixels and the clock can never disagree. Static renders remain for
    // the edit-follow and settings holds only.
    const staticTimeMs = editFollowTimeMs ?? (settingsHold ? deferredScene.durationMs : null);
    try {
      return {
        // Playing and held are two different renders now, not one call with a
        // mode: the preview plays on its own clock, and a held frame is a
        // still picture of one instant.
        previewSvg:
          staticTimeMs === null
            ? engineState.engine.renderToAnimatedSvg(deferredScene.vnode, {
                playback: { mode: "independent" },
                reducedMotion: "keep",
                resourceIdPrefix: documentIdPrefix("preview", instance, String(restartKey)),
              })
            : engineState.engine.renderToSvg(deferredScene.vnode, {
                timeMs: staticTimeMs,
                resourceIdPrefix: documentIdPrefix("preview", instance, "static"),
              }),
        previewError: null,
      };
    } catch (cause) {
      return {
        previewSvg: null,
        previewError: cause instanceof Error ? cause : new Error(String(cause)),
      };
    }
  }, [engineState, restartKey, deferredScene, editFollowTimeMs, settingsHold]);

  // Memoized so unrelated re-renders (export progress ticks) hand React the
  // identical element: React 19 re-applies dangerouslySetInnerHTML whenever
  // the prop object is recreated, which replaced the <svg> and restarted its
  // animations from t=0 on every tick.
  const editFollowActive = editFollowTimeMs !== null;
  const staticHoldActive = editFollowActive || settingsHold;
  const previewNode = useMemo(() => {
    if (!previewSvg) {
      return null;
    }
    return (
      <div
        key={`${restartKey}-${staticHoldActive ? "hold" : "live"}`}
        className="svg-preview"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: boundsvg escapes authored text and the SVG never executes user-provided markup
        dangerouslySetInnerHTML={{ __html: previewSvg }}
      />
    );
  }, [previewSvg, restartKey, staticHoldActive]);

  // A hidden tab keeps neither the animations nor the loop timer running;
  // the user's own playing choice survives the round trip.
  const pageVisible = usePageVisible();

  // Pausing freezes the CSS animations mid-frame (the renderer drives
  // everything with CSS keyframes), so resuming continues from the same
  // spot without a remount or a React clock.
  const previewPaused = !staticHoldActive && (!playing || !pageVisible);
  // Restarting after the loop's final-frame hold remounts the preview via
  // restartKey; the clock itself lives in usePlaybackClock.
  const restartLoop = useCallback(() => setRestartKey((key) => key + 1), []);
  const { scrubInputRef, scrubOutputRef } = usePlaybackClock({
    playing,
    pageVisible,
    staticHoldActive,
    previewSvg,
    durationMs: scene.durationMs,
    sampleTimeMs,
    stageRef,
    onLoopRestart: restartLoop,
  });

  /**
   * Picking "upload" with no file loaded opens the file dialog instead of
   * selecting an empty source. Switching to Google seeds a family that suits
   * the slot rather than leaving the field blank.
   */
  const chooseFontSource = (slot: FontSlot, source: FontChoice["source"], choice: FontChoice) => {
    if (source === "bundled") {
      updateFontChoice(slot, { source: "bundled" });
      return;
    }
    if (source === "google") {
      updateFontChoice(slot, {
        source: "google",
        family:
          choice.source === "google"
            ? choice.family
            : slot === "sans"
              ? "Zen Maru Gothic"
              : "Fira Code",
      });
      return;
    }
    const uploaded = uploadedFonts[slot];
    if (!uploaded) {
      document.getElementById(fontUploadId(instance, slot))?.click();
      return;
    }
    updateFontChoice(slot, { source: "upload", fileName: uploaded.fileName });
  };

  const attachFontFile = async (slot: FontSlot, file: File) => {
    try {
      const uploaded = await readUploadedFont(file, t);
      setUploadedFonts((current) => ({ ...current, [slot]: uploaded }));
      updateFontChoice(slot, { source: "upload", fileName: uploaded.fileName });
      setFontError(null);
    } catch (cause) {
      setFontError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const { autosaveFailed, dismissAutosaveFailure, rearmAutosaveBaseline } = useAutosave(
    project,
    persistence,
  );

  // In-app replacement for window.confirm: destructive actions describe
  // themselves in a styled dialog instead of the browser's native alert.
  const [confirmRequest, setConfirmRequest] = useState<{
    message: string;
    action: () => void;
  } | null>(null);
  const confirmDialogRef = useRef<HTMLDialogElement | null>(null);
  // Chat-assisted authoring: no LLM API — the user carries a prompt to
  // their own chat tool and pastes the reply back for salvage + import.
  const assistDialogRef = useRef<HTMLDialogElement | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);

  // Light dismiss for the modal dialogs, matching the quick-start overlay and
  // the script menu: clicking away closes them. Only a press that both starts
  // and ends on the backdrop counts, so a selection dragged out of a textarea
  // never closes the dialog under the pointer. `close()` runs the dialog's own
  // onClose, so cancelling this way is the same path as Escape.
  const dialogLightDismiss = useDialogLightDismiss();

  /**
   * What to stamp on a script the user is handing to someone else. A script
   * cannot otherwise say which build drew it, which fonts it drew with, or
   * which moment a report is about, and those are what the reader needs first.
   */
  const exportProvenance = (): ScriptProvenance => ({
    ...currentToolVersions(product.version, product.engineVersion),
    fonts: fontProvenance(project.fonts, uploadedFonts),
    capturedAtMs: Math.round(editFollowTimeMs ?? sampleTimeMs),
    // The clamped one, so a script copied while repagination shrinks the
    // count records the page the preview was drawing.
    page: scene.pageIndex,
  });

  const copyScriptJson = async () => {
    try {
      await navigator.clipboard.writeText(serializeProject(project, exportProvenance()));
      setScriptCopied(true);
      window.setTimeout(() => setScriptCopied(false), 1_600);
    } catch {
      // Clipboard unavailable — the save button stays the fallback.
    }
  };

  const toggleSvgInspector = () => {
    setShowSvgInspector((value) => !value);
    setInspectedNodeId(null);
    setPinnedOutline(null);
    setHoverOutline(null);
  };

  useEffect(() => {
    if (confirmRequest && !confirmDialogRef.current?.open) {
      confirmDialogRef.current?.showModal();
      // A modal covers the hovered card without the pointer ever leaving
      // it, so no mouseleave fires and the preset preview would stay on
      // the canvas — making an applied preset look like nothing happened.
      clearPresetHover();
    }
  }, [confirmRequest, clearPresetHover]);

  // Clears the conversation only: styling and scene settings survive, so
  // starting an own script never means hand-deleting the sample messages.
  const resetProject = () => {
    setConfirmRequest({
      message: t.newScriptConfirm,
      action: () => {
        scriptJustReplacedRef.current = true;
        setProject((current) => ({
          ...current,
          messages: [{ id: `message-${messageIdToken()}-0`, role: "user", content: "" }],
        }));
        setPageIndex(0);
        setImportWarnings([]);
        setAppliedPreset(null);
        clearPresetHover();
      },
    });
  };

  // One-time note when the studio opened from an autosave, so a restored
  // state never masquerades as the app's defaults. Auto-hides; the action
  // routes through the same confirmed full reset as the toolbar button.
  const [showRestoreNotice, setShowRestoreNotice] = useState(openedFrom.restored);
  useEffect(() => {
    if (!showRestoreNotice) {
      return;
    }
    const timer = window.setTimeout(() => setShowRestoreNotice(false), 12_000);
    return () => window.clearTimeout(timer);
  }, [showRestoreNotice]);

  // Beginner wizard: opens by itself only on a truly fresh visit (no
  // autosave, never dismissed) so regulars are not nagged; the header's
  // Quick-start button reopens it on demand.
  // One tooltip for the whole app, rendered at the root and positioned with
  // JS: a CSS ::after tooltip can never escape a scrolling panel's clip or
  // outrank a sticky sibling, which is why sidebar hints hid behind the
  // tab bar.
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  // Keep the bubble on screen: anchors near an edge would otherwise push it
  // past the viewport, and one near the top would sit above it.
  useLayoutEffect(() => {
    const node = tooltipRef.current;
    if (!node || !tooltip) {
      return;
    }
    node.style.transform = "translate(-50%, calc(-100% - 8px))";
    const rect = node.getBoundingClientRect();
    const margin = 8;
    let shiftX = 0;
    if (rect.left < margin) {
      shiftX = margin - rect.left;
    } else if (rect.right > window.innerWidth - margin) {
      shiftX = window.innerWidth - margin - rect.right;
    }
    const below = rect.top < margin;
    node.style.transform = `translate(calc(-50% + ${Math.round(shiftX)}px), ${
      below ? "26px" : "calc(-100% - 8px)"
    })`;
  }, [tooltip]);
  useEffect(() => {
    const show = (target: EventTarget | null): void => {
      const anchorEl = target instanceof Element ? target.closest("[data-tip]") : null;
      const text = anchorEl?.getAttribute("data-tip");
      if (!anchorEl || !text) {
        setTooltip(null);
        return;
      }
      const rect = anchorEl.getBoundingClientRect();
      setTooltip({ text, x: rect.left + rect.width / 2, y: rect.top });
    };
    const onOver = (event: MouseEvent) => show(event.target);
    const onOut = () => setTooltip(null);
    const onFocus = (event: FocusEvent) => show(event.target);
    const onScroll = () => setTooltip(null);
    // On the shell, not the document: `[data-tip]` is a name every studio's
    // controls carry, so a document listener answers another studio's hover
    // and draws this studio's tooltip over it.
    const shell = shellRef.current;
    if (shell === null) {
      return;
    }
    shell.addEventListener("mouseover", onOver);
    shell.addEventListener("mouseout", onOut);
    shell.addEventListener("focusin", onFocus);
    shell.addEventListener("focusout", onOut);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      shell.removeEventListener("mouseover", onOver);
      shell.removeEventListener("mouseout", onOut);
      shell.removeEventListener("focusin", onFocus);
      shell.removeEventListener("focusout", onOut);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  const [wizardStep, setWizardStep] = useState<number | null>(null);
  const [wizardClosing, setWizardClosing] = useState(false);
  const [wizardAppliedPresetLabel, setWizardAppliedPresetLabel] = useState<string | null>(null);
  // Detailed export temporarily owns the same flying stage. This marker
  // distinguishes that handoff from opening export directly in the editor.
  const resumeWizardAfterExportRef = useRef(false);
  // The live canvas flies into the wizard (FLIP): one stage element, its
  // transform animated between the preview column and the wizard's slot,
  // so every wizard choice is seen on the real canvas, in place.
  const wizardSlotRef = useRef<HTMLDivElement | null>(null);
  const { stageFlight, setStageFlight, glideHome } = useStageFlightState();
  const exportOverlay = useExportOverlay({ glideHome });
  useStageFlightAim({
    stageFlight,
    setStageFlight,
    stageRef,
    wizard: { step: wizardStep, closing: wizardClosing, slotRef: wizardSlotRef },
    dialog: {
      open: exportOverlay.open,
      closing: exportOverlay.closing,
      slotRef: exportOverlay.slotRef,
    },
    canvasWidth: project.appearance.canvasWidth,
    canvasHeight: project.appearance.canvasHeight,
  });
  // One decision, one action: the dialog selects a format and a single
  // button runs it. The pane above is a static final-frame snapshot —
  // deterministic, so it IS the export — rendered once per open; no
  // second animation clock ever runs behind the modal.
  const {
    exportUrls,
    pendingExport,
    exportProgress,
    exportEta,
    exportResult,
    exportElapsed,
    exportAllPages,
    setExportAllPages,
    exportOpenNotes,
    setExportOpenNotes,
    exportScale,
    setExportScale,
    motionExportScale,
    setMotionExportScale,
    motionQuality,
    setMotionQuality,
    animatedSvgIterations,
    setAnimatedSvgIterations,
    resourceMode,
    setResourceMode,
    runExport,
    abortExport,
    exportScript,
    useNoteToastOpen,
    dismissUseNoteToast,
  } = useExportRunner({
    engine: engineState.status === "ready" ? engineState.engine : null,
    project,
    scene,
    issues,
    resolvedFonts,
    provenance: exportProvenance,
    persistence,
    generator: { name: product.name, version: product.version },
    fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
    dialogOpen: exportOverlay.open,
    t,
    onUiError: setUiError,
    onExport: (result) => {
      handleExportsRef.current?.push(result);
      onExport?.(result);
    },
  });
  // Opt-in, because the panel is fixed to the viewport and covers the whole
  // document: several studios opening it at once would stack one over another,
  // and only the last would be reachable. The app that owns the page turns it
  // on; an embedded studio waits to be asked.
  useEffect(() => {
    if (!onboarding) {
      return;
    }
    try {
      if (!openedFrom.restored && !persistence?.getItem(WIZARD_SEEN_KEY)) {
        setWizardStep(0);
      }
    } catch {
      // Storage unavailable — never auto-open.
    }
  }, [onboarding, openedFrom.restored, persistence]);
  // The wizard's script cards use the same rendered thumbnails as the
  // sidebar's preset drawer — kick the shared render as soon as both the
  // wizard and the engine are ready.
  // Thumbs render after the look step, so the script cards preview in the
  // theme the user just chose.
  const kickPresetThumbs = useEffectEvent(() => {
    void renderPresetThumbs();
  });
  useEffect(() => {
    if (wizardStep === null || wizardStep < 1 || engineState.status !== "ready") {
      return;
    }
    // presetThumbs is the re-arm signal: the style-invalidation effect
    // clears it, and a kick while the shared render loop is already
    // running is a no-op behind its started guard.
    if (SCRIPT_PRESETS.some((preset) => !presetThumbs[preset.id])) {
      kickPresetThumbs();
    }
  }, [wizardStep, engineState.status, presetThumbs]);
  // Tracked so reopening within the glide cancels the pending close —
  // an orphaned timeout would slam the fresh wizard shut mid-open.
  const wizardCloseTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (wizardCloseTimer.current !== null) {
        window.clearTimeout(wizardCloseTimer.current);
      }
    },
    [],
  );
  const rememberWizardSeen = useCallback(() => {
    try {
      persistence?.setItem(WIZARD_SEEN_KEY, "1");
    } catch {
      // Best-effort; worst case the wizard greets again next visit.
    }
  }, [persistence]);
  const dismissWizard = useCallback(() => {
    rememberWizardSeen();
    if (wizardCloseTimer.current !== null) {
      window.clearTimeout(wizardCloseTimer.current);
      wizardCloseTimer.current = null;
    }
    setWizardStep(null);
    setWizardClosing(false);
  }, [rememberWizardSeen]);
  const openWizard = () => {
    if (pendingExport !== null) {
      return;
    }
    // The header remains reachable above either overlay. Hand ownership of
    // the live stage to the wizard in one render instead of stacking two
    // panels during the export dialog's closing glide.
    resumeWizardAfterExportRef.current = false;
    exportOverlay.dismissDialog();
    if (wizardCloseTimer.current !== null) {
      window.clearTimeout(wizardCloseTimer.current);
      wizardCloseTimer.current = null;
    }
    setWizardClosing(false);
    setWizardAppliedPresetLabel(null);
    setWizardStep(0);
  };
  const closeWizard = useCallback(() => {
    rememberWizardSeen();
    if (wizardCloseTimer.current !== null) {
      window.clearTimeout(wizardCloseTimer.current);
    }
    // Fly the canvas home first; the overlay unmounts after the glide.
    // The flight itself is torn down by the ownership effect in
    // useStageFlightAim.
    glideHome();
    setWizardClosing(true);
    wizardCloseTimer.current = window.setTimeout(() => {
      wizardCloseTimer.current = null;
      setWizardStep(null);
      setWizardClosing(false);
    }, STAGE_FLIGHT_GLIDE_MS);
  }, [glideHome, rememberWizardSeen]);
  // Raised through the glide as well: the panel is still over the page, so the
  // page stays held and Escape stays taken. Pressing it again during the close
  // has nothing left to close.
  // Raised through the glide as well: the panel is still over the page, so the
  // page stays held and Escape stays taken. Pressing it again during the close
  // has nothing left to close.
  useRaisedOverlay(wizardStep !== null || wizardClosing, () => {
    if (wizardStep !== null && !wizardClosing) {
      closeWizard();
    }
  });
  useKeyboardDismissBlur(shellRef);
  useMeasuredHeaderHeight(headerRef, shellRef);

  // A detailed-export close completes only the child flow: once its glide
  // has unmounted the panel, restore the guide at its completion step.
  useLayoutEffect(() => {
    if (!resumeWizardAfterExportRef.current || exportOverlay.open || exportOverlay.closing) {
      return;
    }
    resumeWizardAfterExportRef.current = false;
    setWizardClosing(false);
    setWizardStep(WIZARD_EXPORT_STEP);
  }, [exportOverlay.open, exportOverlay.closing]);

  // Full factory reset: defaults for script and settings, and the autosave
  // is deleted — the documented way to leave nothing on a shared machine.
  const resetEverything = () => {
    setConfirmRequest({
      message: t.resetAllConfirm,
      action: () => {
        try {
          clearAutosave(persistence);
        } catch {
          // Storage unavailable — nothing persisted to remove.
        }
        rearmAutosaveBaseline();
        scriptJustReplacedRef.current = true;
        setProject(() => freshProjectFor(lang));
        setPageIndex(0);
        setImportWarnings([]);
        setAppliedPreset(null);
        setShowRestoreNotice(false);
      },
    });
  };

  const openGallery = () => {
    setGalleryOpen(true);
    galleryDialogRef.current?.showModal();
  };

  const closeGallery = () => {
    galleryDialogRef.current?.close();
  };

  /** Flash an outline over the preview element a scene field controls. */
  const flashField = (fieldKey: string) => {
    const stage = stageRef.current;
    const element = stage?.querySelector(`[${META_EDIT_ATTR}="field:${fieldKey}"]`);
    if (!stage || !element) {
      return;
    }
    setFieldFlash(outlineRectFor(element, stage));
    window.clearTimeout(fieldFlashTimer.current);
    fieldFlashTimer.current = window.setTimeout(() => setFieldFlash(null), 1_600);
  };

  // Destructive script edits are guarded by undo, not confirmation: a
  // per-delete dialog is friction on a frequent small action and teaches
  // click-through, while the notice makes every mistake recoverable.
  const scriptUndo = useScriptUndo(project.messages, setProject);
  const {
    updateAppearance,
    updateFontChoice,
    updateChrome,
    updateTiming,
    updatePagination,
    updateDisplay,
    updateMessage,
    removeMessage,
    clearMessageContent,
    removeMessageImage,
    moveMessage,
    duplicateMessage,
    insertMessage,
    reorderMessage,
    attachImage,
    attachBackdrop,
    removeBackdropImage,
    applyDisplayPreset,
    resetAppearance,
    resetMotion,
  } = useProjectActions({
    project,
    setProject,
    scriptUndo,
    lang,
    t,
    onUiError: setUiError,
    onPaginationChange: () => setPageIndex(0),
    // The list glide is suppressed by the script tab itself, which owns
    // both the drag and the FLIP; nothing else reorders messages.
    onBeforeReorder: () => {},
  });

  // The host's view of the script is the same state the controls edit, read
  // through a ref so a handle method sees the latest commit rather than the
  // render it was created in.
  const projectRef = useRef(project);
  projectRef.current = project;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const issuesRef = useRef(issues);
  issuesRef.current = issues;
  const engineReadyRef = useRef(engineState.status === "ready");
  engineReadyRef.current = engineState.status === "ready";
  const engineRef = useRef(engineState.status === "ready" ? engineState.engine : null);
  engineRef.current = engineState.status === "ready" ? engineState.engine : null;
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  useImperativeHandle(
    ref,
    (): StudioHandle => ({
      getProject: () => projectRef.current,
      replaceProject: (next) => {
        // Mirrors importing a file: the new script owes nothing to the
        // entries recorded against the old one, and starts on page one.
        scriptJustReplacedRef.current = true;
        // Written through the ref as well, so a `getProject` in the same
        // task reads this commit rather than the render before it.
        projectRef.current = next;
        setProject(next);
        setPageIndex(0);
        setImportWarnings([]);
        setAppliedPreset(null);
        scriptUndo.drop();
        setUiError(null);
      },
      applyPatch: (update) => {
        const next = update(projectRef.current);
        projectRef.current = next;
        setProject(next);
      },
      seek: (timeMs, options) => {
        const page = options?.page;
        if (page !== undefined) {
          setPageIndex(Math.min(Math.max(page, 0), sceneRef.current.pageCount - 1));
        }
        setPlaying(false);
        setSampleTimeMs(Math.min(Math.max(timeMs, 0), sceneRef.current.durationMs));
        setSettingsHoldReleased(true);
      },
      play: (options) => {
        if (options?.restart) {
          setRestartKey((key) => key + 1);
          setSampleTimeMs(0);
        }
        setPlaying(true);
        setSettingsHoldReleased(true);
      },
      exportArtifact: async (kind, options) => {
        if (!engineReadyRef.current) {
          throw new Error("The render engine is still loading; try again in a moment.");
        }
        if (issuesRef.current.length > 0) {
          throw new Error(
            `The script has issues that block export: ${issuesRef.current.join(" ")}`,
          );
        }
        const collected: StudioExportResult[] = [];
        handleExportsRef.current = collected;
        try {
          await runExport(kind, { autoDownload: true, allPages: options?.allPages ?? true });
        } finally {
          handleExportsRef.current = null;
        }
        return collected;
      },
      spotlight: (messageIds, options) => {
        const [first] = messageIds;
        if (first === undefined) {
          return;
        }
        const stage = stageRef.current;
        const element = stage?.querySelector(`[${META_EDIT_ATTR}="${first}"]`);
        if (stage && element) {
          setFieldFlash(outlineRectFor(element, stage));
          window.clearTimeout(fieldFlashTimer.current);
          fieldFlashTimer.current = window.setTimeout(() => setFieldFlash(null), 1_600);
        }
        for (const messageId of messageIds) {
          const card = inShell(`[data-message-id="${messageId}"]`);
          card?.classList.remove("is-attention");
          requestAnimationFrame(() => card?.classList.add("is-attention"));
        }
        if (options?.jump) {
          jumpToMessageCard(first);
        }
      },
      renderFrame: async (options) => {
        const engine = engineRef.current;
        if (engine === null) {
          throw new Error("The render engine is still loading; try again in a moment.");
        }
        const current = projectRef.current;
        const pageCount = Math.max(1, paginateMessages(current).length);
        const page = Math.min(Math.max(options.page ?? pageIndexRef.current, 0), pageCount - 1);
        // The previewed page's scene is already built; any other page is
        // built the same way, measured by the engine so the frame matches
        // what the preview would show there.
        const frameScene =
          page === pageIndexRef.current
            ? sceneRef.current
            : buildSvgentScene(current, page, {
                engine,
                generator: { name: product.name, version: product.version },
                fallbackImage: GENERATED_SAMPLE_IMAGES.generic,
              });
        const timeMs = Math.min(Math.max(options.timeMs, 0), frameScene.durationMs);
        const scale = options.scale ?? 1;
        const bytes = engine.renderToPng(frameScene.vnode, {
          timeMs,
          ...(scale !== 1 ? { scale } : {}),
        });
        return {
          bytes,
          page,
          timeMs,
          durationMs: frameScene.durationMs,
          width: Math.round(current.appearance.canvasWidth * scale),
          height: Math.round(current.appearance.canvasHeight * scale),
        };
      },
    }),
    [runExport, scriptUndo.drop],
  );

  // Scoped resets: the way back when a look has been nudged past recognition.
  // Autosave keeps every nudge, so without these the drift is permanent.
  const resetAppearanceSettings = () => {
    setConfirmRequest({
      message: t.resetAppearanceConfirm,
      action: () => {
        resetAppearance();
        setConfirmRequest(null);
      },
    });
  };
  const resetMotionSettings = () => {
    setConfirmRequest({
      message: t.resetMotionConfirm,
      action: () => {
        resetMotion();
        setConfirmRequest(null);
      },
    });
  };

  // A deleted card's spot in the list offers the way back while the undo
  // window is open — the bottom of a tall window is nowhere near the
  // delete button that was just pressed.
  const newestUndo = scriptUndo.stack[scriptUndo.stack.length - 1];
  const undoRowIndex =
    newestUndo?.kind === "delete" ? restoreIndexFor(newestUndo, project.messages) : null;
  // Mobile-only preview sheet: the sticky canvas can be resized by
  // dragging its grip bar or tucked away entirely. Desktop layout reads
  // neither value — the media query gates their CSS.
  const [previewSheetVh, setPreviewSheetVh] = useState(40);
  const [previewSheetOpen, setPreviewSheetOpen] = useState(true);

  const startPreviewSheetResize = (event: React.PointerEvent) => {
    if (event.button > 0) {
      return;
    }
    if (!previewSheetOpen) {
      // Nothing to size while tucked away, so the row is one wide tap
      // target that brings the canvas back at the height last chosen —
      // a reader who never found the chevron still has a way up. Settled
      // on release, and only if the finger stayed put, so brushing past
      // the row on the way to the editor does not open it.
      openPreviewSheetOnTap(event);
      return;
    }
    event.preventDefault();
    const startY = event.clientY;
    const startVh = previewSheetVh;
    // Window listeners, so only the finger that started this drag drives it.
    const pointerId = event.pointerId;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) {
        return;
      }
      const deltaVh = ((move.clientY - startY) / window.innerHeight) * 100;
      setPreviewSheetVh(Math.min(70, Math.max(22, startVh + deltaVh)));
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  /** Expand on a tap that lands and lifts in the same place. */
  const openPreviewSheetOnTap = (event: React.PointerEvent) => {
    const startY = event.clientY;
    const startX = event.clientX;
    const pointerId = event.pointerId;
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
      if (Math.hypot(end.clientX - startX, end.clientY - startY) < 10) {
        setPreviewSheetOpen(true);
      }
    };
    const onCancel = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onCancel);
    };
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onCancel);
  };

  // Click-to-edit works in every mode now — opening the editor pins the
  // preview to the clicked message, which doubles as the pause.
  const canEditInline = !showSvgInspector;

  // Touch-only canvas zoom, pan, and long-press-to-edit; the handlers
  // read openStageEditorAt through a stable wrapper so the hook needs no
  // knowledge of the scene.
  const {
    stageZoom,
    resetZoom,
    lastPointerTypeRef: stageLastPointerTypeRef,
    onPointerDown: handleStageTouchDown,
    onPointerMove: handleStageTouchMove,
    onPointerEnd: handleStageTouchEnd,
  } = useStageGestures({
    stageRef,
    canEditInline,
    onLongPress: (stage, point) => openStageEditorAt(stage, point),
  });

  const submitStageInput = () => {
    const input = stageInput;
    if (!input || input.draft.trim().length === 0) {
      return;
    }
    if (input.kind === "choice") {
      updateMessage(input.messageId, { freeform: input.draft });
      setStageInput(null);
      return;
    }
    if (project.messages.length >= MAX_MESSAGES) {
      return;
    }
    if (input.draft.length > MAX_MESSAGE_CHARS) {
      return;
    }
    const created: SessionMessage = {
      ...createMessage("user", project.messages.length, lang),
      content: input.draft,
    };
    setProject((current) => {
      if (current.messages.length >= MAX_MESSAGES) {
        return current;
      }
      return {
        ...current,
        messages: insertAtScrubAnchor(current.messages, created, {
          afterMessageId: input.afterMessageId,
          beforeMessageId: input.beforeMessageId,
        }),
      };
    });
    setStageInput(null);
    setScrubFollowMessageId(created.id);
  };

  const captureImeSelection = () => {
    const textarea = stageInputRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    setStageInput((current) =>
      current?.kind === "user"
        ? {
            ...current,
            selection: end > start ? { start, end, text: current.draft.slice(start, end) } : null,
          }
        : current,
    );
  };

  const applyStageMarkup = (next: { value: string; caret: number }) => {
    if (stageInput?.kind !== "user") {
      return;
    }
    setStageInput({ ...stageInput, draft: next.value, selection: null });
    requestAnimationFrame(() => {
      stageInputRef.current?.focus();
      stageInputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const sourceMaxPx = () => Math.round(window.innerHeight * 0.72);

  // Devtools-style drag on the panel's top edge; the preview above shrinks
  // to make room instead of the column growing a scrollbar.
  const startSourceResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = sourceHeight;
    // Capture retargets this pointer's events; every other pointer still
    // reaches the window, so a second finger has to be turned away here.
    const pointerId = event.pointerId;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      const next = startHeight + (startY - moveEvent.clientY);
      setSourceHeight(Math.min(sourceMaxPx(), Math.max(SOURCE_MIN_PX, next)));
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const toggleSourceExpand = () => {
    const max = sourceMaxPx();
    setSourceHeight((current) => {
      if (current < max - 40) {
        sourceHeightBeforeExpand.current = current;
        return max;
      }
      return Math.max(SOURCE_MIN_PX, sourceHeightBeforeExpand.current);
    });
  };

  const startSidebarResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const divider = event.currentTarget;
    divider.setPointerCapture(event.pointerId);
    const pointerId = event.pointerId;
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      setSidebarWidth(Math.min(SIDEBAR_MAX_PX, Math.max(SIDEBAR_MIN_PX, moveEvent.clientX)));
    };
    const onEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  /** Engine state, autosave note, and the hold/edit chips over the canvas. */
  const stageStatusRow = (): React.ReactNode => (
    <div className="stage-status-row">
      <div className="stage-status-left">
        {/* Playback state changes this text's length, and a slider that
            resizes under the pointer every time playback stops is the one
            control that cannot afford a neighbour like that. The row below
            already exists for exactly this — chips that must not compete
            with the toolbar for width. */}
        <span className="edit-hint">
          {!playing ? (
            t.scrubEditHint
          ) : (
            <>
              <span className="copy-hover">{t.editHint}</span>
              <span className="copy-touch">{t.editHintTouch}</span>
            </>
          )}
        </span>
        <span className="scene-metrics">
          {project.appearance.canvasWidth}×{project.appearance.canvasHeight} ·{" "}
          {formatDuration(scene.durationMs)}
        </span>
        {scene.pageCount > 1 ? (
          <div className="page-controls">
            <button
              type="button"
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
              disabled={scene.pageIndex === 0}
            >
              <ArrowIcon direction="left" />
            </button>
            {/* The word is context; the numbers are what the eye comes for. */}
            <span className="page-count">
              {t.pageWord}
              <span className="page-count-numbers">
                <strong>{scene.pageIndex + 1}</strong>/{scene.pageCount}
              </span>
            </span>
            <button
              type="button"
              onClick={() => setPageIndex((index) => Math.min(scene.pageCount - 1, index + 1))}
              disabled={scene.pageIndex >= scene.pageCount - 1}
            >
              <ArrowIcon direction="right" />
            </button>
          </div>
        ) : null}
      </div>
      {/* Quick saves sit beside the pager and grab the page on screen;
      whole-deck export lives in the dialog, where scope is explicit. */}
      <div className="stage-status-actions">
        <button
          type="button"
          className="quick-download"
          data-tip={t.quickSvgTitle}
          disabled={engineState.status !== "ready" || pendingExport !== null || issues.length > 0}
          onClick={() => void runExport("animated-svg", { autoDownload: true, allPages: false })}
        >
          <DownloadIcon /> {t.quickSvgLabel}
        </button>
        <button
          type="button"
          className="quick-download"
          data-tip={t.quickDownloadTitle}
          disabled={engineState.status !== "ready" || pendingExport !== null || issues.length > 0}
          onClick={() => void runExport("poster-png", { autoDownload: true, allPages: false })}
        >
          <DownloadIcon /> PNG
        </button>
        <button type="button" className="export-open" onClick={exportOverlay.openDialog}>
          <DownloadIcon /> {t.exportTitle}
          <span className="export-open-formats">GIF · MP4…</span>
        </button>
      </div>
    </div>
  );

  /** Play/pause toggle and the from-the-top restart. */
  const loopControls = (): React.ReactNode => (
    <>
      <button
        type="button"
        className="play-toggle"
        aria-label={playing ? t.playbackPause : t.playbackResume}
        data-tip={playing ? t.playbackPause : t.playbackResume}
        onClick={() => {
          if (playing) {
            // Committing the clock into state is what makes the pause a
            // scrub position: the slider, direct editing, and any later
            // remount all resume from this exact frame.
            setSampleTimeMs(Math.min(readAnimationTimeMs(stageRef.current) ?? 0, scene.durationMs));
            setPlaying(false);
          } else {
            setPlaying(true);
            setSettingsHoldReleased(true);
          }
        }}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        className="restart-button"
        onClick={() => {
          setRestartKey((key) => key + 1);
          setSampleTimeMs(0);
          setPlaying(true);
          setSettingsHoldReleased(true);
        }}
        aria-label={t.playAgain}
      >
        ↻ <span className="label-full">{t.playAgain}</span>
      </button>
    </>
  );

  /**
   * Touching a message takes the clock, like touching the timeline: pause
   * and cue the slider to the message's reveal-complete moment, so closing
   * the editor stays on what the edit produced. While zoomed the camera is
   * aimed at pixels, so keep the tapped moment instead of letting a seek
   * move the scene under the viewport.
   */
  const pauseAtMessage = (messageId: string) => {
    if (!playing) {
      return;
    }
    const revealMs = scene.messageRevealMs[messageId];
    const cueMs =
      stageZoom.scale <= 1 && revealMs !== undefined
        ? revealMs
        : (readAnimationTimeMs(stageRef.current) ?? sampleTimeMs);
    setPlaying(false);
    setSampleTimeMs(Math.min(Math.max(cueMs, 0), scene.durationMs));
  };

  /** Pause (if needed) and nudge the timeline by one authoring frame. */
  const stepFrame = (deltaMs: number) => {
    const snapClamp = (timeMs: number) => {
      const snappedMs = Math.round(timeMs / FRAME_STEP_MS) * FRAME_STEP_MS;
      return Math.min(Math.max(snappedMs, 0), scene.durationMs);
    };
    setSettingsHoldReleased(true);
    if (playing) {
      const baseMs = readAnimationTimeMs(stageRef.current) ?? sampleTimeMs;
      setPlaying(false);
      setSampleTimeMs(snapClamp(baseMs + deltaMs));
      return;
    }
    // Functional update so rapid taps land in the same batch without
    // reading a stale position and collapsing into one step.
    setSampleTimeMs((current) => snapClamp(current + deltaMs));
  };

  const stepControls = (): React.ReactNode => (
    <>
      <button
        type="button"
        className="step-button"
        aria-label={t.stepBack}
        data-tip={t.stepBack}
        onClick={() => stepFrame(-FRAME_STEP_MS)}
      >
        <StepIcon direction="back" />
      </button>
      <button
        type="button"
        className="step-button"
        aria-label={t.stepForward}
        data-tip={t.stepForward}
        onClick={() => stepFrame(FRAME_STEP_MS)}
      >
        <StepIcon direction="forward" />
      </button>
    </>
  );

  /** One video-player transport: play/pause + replay + the shared timeline. */
  const previewToolbar = (): React.ReactNode => (
    <div className={`preview-toolbar${settingsHold ? " is-held" : ""}`}>
      {loopControls()}
      {stepControls()}
      <label className="scrub-field">
        <input
          ref={scrubInputRef}
          type="range"
          min={0}
          max={scene.durationMs}
          step={FRAME_STEP_MS}
          defaultValue={sampleTimeMs}
          onChange={(event) => {
            // Touching the timeline takes the clock: playback pauses and
            // the frame follows the finger, like a video player's seek.
            // That includes the settings hold — grabbing the slider means
            // "I want to watch", so the held final frame lets go.
            const timeMs = Number(event.currentTarget.value);
            setSettingsHoldReleased(true);
            if (playing) {
              setPlaying(false);
            }
            setSampleTimeMs(timeMs);
          }}
        />
        <output ref={scrubOutputRef}>{formatDuration(sampleTimeMs)}</output>
      </label>
      <button
        type="button"
        className={`svg-toggle ${showSvgInspector ? "is-active" : ""}`}
        onClick={toggleSvgInspector}
        data-tip={t.svgToggleTitle}
      >
        {"</>"}
      </button>
      {editFollowActive ? (
        <span className="edit-follow-chip push-right" data-tip={t.editFollowTip}>
          {t.editFollowActive}
        </span>
      ) : settingsHold ? (
        <span className="edit-follow-chip push-right" data-tip={t.settingsHoldTip}>
          {t.settingsHoldChip}
        </span>
      ) : null}
      {/* Phone-only export at the toolbar's right end (hidden on desktop
          by CSS): the toolbar already floats over the canvas, so the icon
          costs no stage space and never covers the window. */}
      <button
        type="button"
        className="export-open toolbar-export"
        aria-label={t.exportTitle}
        onClick={exportOverlay.openDialog}
      >
        <DownloadIcon />
      </button>
    </div>
  );

  /**
   * Mobile-only sheet controls (hidden on desktop by CSS): drag the bar to
   * resize the sticky canvas, tap the chevron to tuck it away entirely and
   * give the controls the whole screen.
   *
   * Tucked away there is no canvas to size, so the row stops being a drag
   * target and becomes one wide tap target that brings it back — a reader
   * who never found the chevron still has a way up, and the height they
   * last chose is restored rather than re-invented mid-gesture. The
   * chevron stays the labelled control; this is the second route to it.
   */
  const previewSheetGrip = (): React.ReactNode => (
    // One row under the canvas: surface toggle, drag bar, chevron. The row
    // background (and the bar's whole flexible track) is the drag area;
    // the buttons stop the pointer so taps never resize.
    <div className="preview-sheet-grip" onPointerDown={startPreviewSheetResize}>
      <div
        className="sheet-surface-tabs"
        role="group"
        aria-label={t.fieldSurface}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className={project.surface === "app" ? "is-active" : ""}
          onClick={() => setProject((current) => ({ ...current, surface: "app" }))}
        >
          {t.surfaceApp}
        </button>
        <button
          type="button"
          className={project.surface === "tui" ? "is-active" : ""}
          onClick={() => setProject((current) => ({ ...current, surface: "tui" }))}
        >
          {t.surfaceTui}
        </button>
      </div>
      <span className="preview-sheet-grip-bar" aria-hidden="true" />
      {/* Split-flow pager rides the right cluster next to the chevron —
          never the center, which is the drag bar's landing zone. */}
      {scene.pageCount > 1 ? (
        <div
          className="sheet-pager"
          role="group"
          aria-label={t.pagePagerAria}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label={t.pagePrev}
            disabled={scene.pageIndex === 0}
            onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
          >
            <ArrowIcon direction="left" />
          </button>
          <span className="page-count-numbers">
            <strong>{scene.pageIndex + 1}</strong>/{scene.pageCount}
          </span>
          <button
            type="button"
            aria-label={t.pageNext}
            disabled={scene.pageIndex >= scene.pageCount - 1}
            onClick={() => setPageIndex((index) => Math.min(scene.pageCount - 1, index + 1))}
          >
            <ArrowIcon direction="right" />
          </button>
        </div>
      ) : null}
      <button
        type="button"
        aria-label={t.previewSheetToggle}
        aria-expanded={previewSheetOpen}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setPreviewSheetOpen((open) => !open)}
      >
        <ChevronIcon direction={previewSheetOpen ? "up" : "down"} />
      </button>
    </div>
  );

  /** Validation issues and UI errors listed under the stage. */
  const previewIssueList = (): React.ReactNode => (
    <>
      {issues.length > 0 ? (
        <div className="issue-list" role="alert">
          {issues.map((issue) => (
            <p key={issue}>• {issue}</p>
          ))}
        </div>
      ) : null}
      {uiError ? (
        <div className="issue-list" role="alert">
          <p>{uiError.message}</p>
        </div>
      ) : null}
      {missingGlyphs.length > 0 ? (
        <div className="issue-list is-warning" role="status">
          <p>{t.missingGlyphNotice(missingGlyphs.length, describeMissingGlyphs(missingGlyphs))}</p>
        </div>
      ) : null}
    </>
  );

  /** The right-hand column: the rendered scene, its toolbar, and the inspector. */
  const previewColumn = (): React.ReactNode => (
    <section
      ref={previewColumnRef}
      className={`preview-column${showSvgInspector ? " has-inspector" : ""}${
        previewSheetOpen ? "" : " is-sheet-collapsed"
      }`}
      style={{ "--preview-sheet-vh": `${previewSheetVh}vh` } as React.CSSProperties}
    >
      {previewToolbar()}

      {stageStatusRow()}
      <PreviewStage
        stageRef={stageRef}
        shellRef={shellRef}
        project={project}
        engineState={engineState}
        previewError={previewError}
        previewNode={previewNode}
        stageFlight={stageFlight}
        stageZoom={stageZoom}
        onResetZoom={resetZoom}
        previewPaused={previewPaused}
        playing={playing}
        canEditInline={canEditInline}
        showSvgInspector={showSvgInspector}
        sourceHeight={sourceHeight}
        editFollowActive={editFollowActive}
        fieldFlash={fieldFlash}
        editHover={editHover}
        hoverOutline={hoverOutline}
        pinnedOutline={pinnedOutline}
        inspectedNodeId={inspectedNodeId}
        onClick={handleStageClick}
        onHover={handleStageHover}
        onLeave={() => {
          setHoverOutline(null);
          setEditHover(null);
        }}
        onPointerDown={handleStageTouchDown}
        onPointerMove={handleStageTouchMove}
        onPointerEnd={handleStageTouchEnd}
        stageInput={stageInput}
        stageInputRef={stageInputRef}
        stageInputHandlers={{
          onDraftChange: (draft) =>
            setStageInput((current) =>
              current === null
                ? current
                : current.kind === "user"
                  ? { ...current, draft, selection: null }
                  : { ...current, draft },
            ),
          onSelect: captureImeSelection,
          onApplyMarkup: applyStageMarkup,
          onSubmit: submitStageInput,
          onClose: () => setStageInput(null),
        }}
        inlineEdit={inlineEdit}
        inlineEditMessage={inlineEditMessage}
        inlineEditNumber={
          inlineEditMessage === null
            ? 0
            : project.messages.findIndex((message) => message.id === inlineEditMessage.id) + 1
        }
        onInlineEditContentChange={(content) => {
          if (inlineEditMessage) {
            updateMessage(inlineEditMessage.id, { content });
          }
        }}
        onInlineEditClose={() => setInlineEdit(null)}
        t={t}
      />
      {previewSheetGrip()}
      <input
        ref={imageReplaceInputRef}
        type="file"
        hidden
        accept={IMAGE_ACCEPT}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          const pending = pendingImageRef.current;
          pendingImageRef.current = null;
          if (file && pending) {
            void attachImage(pending.messageId, file, pending.index);
          }
          event.currentTarget.value = "";
        }}
      />

      <SvgInspector
        open={showSvgInspector}
        sourceView={sourceView}
        sourceBytes={previewSvg?.length ?? 0}
        inspectedNodeId={inspectedNodeId}
        sourceHeight={sourceHeight}
        sourceMinPx={SOURCE_MIN_PX}
        sourceMaxPx={sourceMaxPx()}
        onResizeStart={startSourceResize}
        onToggleExpand={toggleSourceExpand}
        t={t}
      />

      {previewIssueList()}

      <AssistDialog dialogRef={assistDialogRef} lang={lang} t={t} onApply={applyAssistImport} />
      <GalleryDialog
        dialogRef={galleryDialogRef}
        onDialogClose={() => {
          setGalleryOpen(false);
          clearPresetHover();
        }}
        presetThumbs={presetThumbs}
        presetMotion={presetMotion}
        hoverPresetId={hoverPresetId}
        hoverPreset={hoverPreset}
        isAppliedPreset={isAppliedPreset}
        returnToWizard={wizardStep === WIZARD_SCRIPT_STEP}
        onApply={applyPreset}
        t={t}
        lang={lang}
      />
      <WizardOverlay
        step={wizardStep}
        closing={wizardClosing}
        slotRef={wizardSlotRef}
        project={project}
        pageIndex={scene.pageIndex}
        pageCount={scene.pageCount}
        lang={lang}
        t={t}
        setProject={setProject}
        actions={{ updateAppearance, updateMessage, applyDisplayPreset }}
        engineReady={engineState.status === "ready"}
        issues={issues}
        exportOverlay={exportOverlay}
        pendingExport={pendingExport}
        exportProgress={exportProgress}
        exportEta={exportEta}
        exportElapsed={exportElapsed}
        appliedPresetLabel={wizardAppliedPresetLabel}
        onStepChange={setWizardStep}
        onClose={closeWizard}
        onPageChange={setPageIndex}
        onOpenAssist={() => assistDialogRef.current?.showModal()}
        onOpenGallery={openGallery}
        onOpenEditor={() => {
          setPanelTab("script");
          closeWizard();
        }}
        onMessageFocus={setFocusedMessageId}
        onMessageBlur={(messageId) =>
          setFocusedMessageId((current) => (current === messageId ? null : current))
        }
        exportResult={exportResult}
        exportUrls={exportUrls}
        // The wizard shows what it made and lets the reader take it from
        // there, the same as the detailed dialog. Saving every file the moment
        // it finished gave the simplest path the fewest options.
        onRunExport={() => runSelectedExport({ allPages: true })}
        onAbortExport={abortExport}
        onMoreFormats={() => {
          // This is an overlay-to-overlay handoff, not a close to the main
          // stage: unmount the guide immediately so its backdrop and panel
          // cannot overlap the export dialog during the glide interval.
          resumeWizardAfterExportRef.current = true;
          dismissWizard();
          exportOverlay.openDialog();
        }}
      />
      <dialog
        className="confirm-dialog"
        ref={confirmDialogRef}
        onClose={() => setConfirmRequest(null)}
        {...dialogLightDismiss}
      >
        <p>{confirmRequest?.message}</p>
        <div className="confirm-actions">
          <button type="button" onClick={() => confirmDialogRef.current?.close()}>
            {t.confirmCancel}
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => {
              confirmRequest?.action();
              confirmDialogRef.current?.close();
            }}
          >
            {t.confirmOk}
          </button>
        </div>
      </dialog>
      <ExportDialog
        instance={instance}
        overlay={exportOverlay}
        engine={engineState.engine}
        scene={scene}
        project={project}
        issues={issues}
        engineReady={engineState.status === "ready"}
        pendingExport={pendingExport}
        exportProgress={exportProgress}
        exportEta={exportEta}
        exportElapsed={exportElapsed}
        exportResult={exportResult}
        exportUrls={exportUrls}
        exportScale={exportScale}
        onExportScaleChange={setExportScale}
        motionExportScale={motionExportScale}
        onMotionExportScaleChange={setMotionExportScale}
        motionQuality={motionQuality}
        onMotionQualityChange={setMotionQuality}
        animatedSvgIterations={animatedSvgIterations}
        onAnimatedSvgIterationsChange={setAnimatedSvgIterations}
        resourceMode={resourceMode}
        onResourceModeChange={setResourceMode}
        exportAllPages={exportAllPages}
        onExportScopeChange={setExportAllPages}
        exportOpenNotes={exportOpenNotes}
        onExportOpenNotesChange={setExportOpenNotes}
        onPageChange={setPageIndex}
        onBasisChange={(basis) => setProject((current) => ({ ...current, basis }))}
        onCameraFollowChange={(follow) =>
          setProject((current) => ({
            ...current,
            camera: { ...current.camera, follow },
          }))
        }
        onRun={() => runSelectedExport()}
        onAbort={abortExport}
        onExportScript={exportScript}
        t={t}
      />
    </section>
  );

  /** Brand lockup, the language and theme toggles, and the wizard entry point. */
  const appHeader = (): React.ReactNode => (
    <>
      <div className="brand-lockup">
        <img
          className="brand-mark"
          src="/brand/svgent-mark.svg"
          alt=""
          aria-hidden="true"
          width={34}
          height={34}
        />
        <div className="brand-copy">
          {/* The wordmark is the brand's own letterforms, shared with the
              boundsvg family, so it is artwork rather than type. The heading
              keeps its text for anything that reads the page rather than
              looks at it. */}
          <h1 className="brand-wordmark">
            {/* The asset lives in the app's public directory, so the path is
                resolved here at runtime rather than in this package's CSS,
                which is bundled without it. */}
            <img
              src={uiTheme === "light" ? LIGHT_WORDMARK : DARK_WORDMARK}
              alt=""
              aria-hidden="true"
              width={75}
              height={26}
            />
            <span>svgent</span>
          </h1>
          <div className="brand-subline">
            <div
              className={`engine-status is-${engineState.status}`}
              data-tip={t.autosaveTooltip}
              role="status"
            >
              {engineState.status === "ready"
                ? t.statusReadyLocal
                : engineState.status === "loading"
                  ? t.statusLoading
                  : t.rendererError}
            </div>
          </div>
        </div>
      </div>
      <div className="header-actions">
        <button
          type="button"
          className="wizard-open"
          disabled={pendingExport !== null}
          onClick={() => {
            // Any floating stage popover would sit above the overlay and
            // read as part of the wizard; the guide starts clean instead.
            setStageInput(null);
            setInlineEdit(null);
            openWizard();
          }}
        >
          {t.wizardOpen}
        </button>
        {/* No tooltips here: what EN and the sun/moon do is visible the
            moment they are pressed, and aria-labels keep them readable. */}
        <button
          type="button"
          className="ui-theme-toggle ui-lang-toggle"
          onClick={() => setLang((current) => (current === "ja" ? "en" : "ja"))}
          aria-label={t.langToggle}
        >
          {t.langToggleShort}
        </button>
        <button
          type="button"
          className="ui-theme-toggle"
          onClick={() => setUiTheme((current) => (current === "dark" ? "light" : "dark"))}
          aria-label={uiTheme === "dark" ? t.themeToggleToLight : t.themeToggleToDark}
        >
          {uiTheme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <a
          className="ui-repo-link"
          href={product.repositoryUrl}
          target="_blank"
          rel="noreferrer"
          aria-label={t.repoLink}
          title={t.repoLink}
        >
          <GitHubIcon />
        </a>
      </div>
    </>
  );

  /** The left editor column: its tab strip and whichever tab body is active. */
  const controlPanel = (): React.ReactNode => (
    <aside className="control-panel" aria-label={t.sceneEditorAria}>
      <div className="quick-bar">
        <SegmentedField
          label={t.fieldSurface}
          value={project.surface}
          options={[
            { value: "app", label: t.surfaceApp },
            { value: "tui", label: t.surfaceTui },
          ]}
          onChange={(surface) => setProject((current) => ({ ...current, surface }))}
        />
        <SegmentedField
          label={t.fieldFlow}
          value={project.pagination.flow}
          options={[
            { value: "scroll", label: t.flowScroll },
            { value: "slides", label: t.flowPages },
          ]}
          onChange={(flow) => updatePagination("flow", flow)}
        />
      </div>

      <nav className="panel-tabs" aria-label={t.editorSectionsAria}>
        {panelTabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            className={panelTab === tab.id ? "is-active" : ""}
            onClick={() => setPanelTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          className="panel-width-toggle"
          onClick={() =>
            setSidebarWidth((width) =>
              width < (SIDEBAR_DEFAULT_PX + SIDEBAR_WIDE_PX) / 2
                ? SIDEBAR_WIDE_PX
                : SIDEBAR_DEFAULT_PX,
            )
          }
          aria-label={t.panelWidthTitle}
          data-tip={t.panelWidthTitle}
        >
          <WidthIcon />
        </button>
      </nav>

      <div className="panel-tab-body">
        {panelTab === "script" ? (
          <ScriptTab
            instance={instance}
            project={project}
            totalCharacters={totalCharacters}
            messagePage={scene.messagePage}
            actions={{
              updateMessage,
              removeMessage,
              clearMessageContent,
              removeMessageImage,
              attachImage,
              moveMessage,
              duplicateMessage,
              insertMessage,
              reorderMessage,
            }}
            undo={{
              rowIndex: undoRowIndex,
              count: scriptUndo.stack.length,
              onUndo: scriptUndo.undo,
              onDismiss: scriptUndo.drop,
            }}
            importWarnings={importWarnings}
            onDismissImportWarnings={() => setImportWarnings([])}
            scriptCopied={scriptCopied}
            onCopyScript={copyScriptJson}
            onImportScript={(file) => void importScript(file)}
            onExportScript={exportScript}
            onOpenGallery={openGallery}
            onOpenAssist={() => assistDialogRef.current?.showModal()}
            onNewScript={resetProject}
            onResetAll={resetEverything}
            onJumpToFlowField={jumpToFlowField}
            currentScrubMessageId={currentScrubMessageId}
            onMessageFocusChange={(messageId, focused) =>
              setFocusedMessageId((current) =>
                focused ? messageId : current === messageId ? null : current,
              )
            }
            t={t}
          />
        ) : panelTab === "scene" ? (
          <SceneTab
            project={project}
            setProject={setProject}
            actions={{ updateChrome, updateDisplay }}
            onFieldFocus={flashField}
            pageIndex={scene.pageIndex}
            product={product}
            t={t}
          />
        ) : panelTab === "motion" ? (
          <MotionTab
            project={project}
            setProject={setProject}
            actions={{ updateTiming }}
            durationMs={scene.durationMs}
            onResetMotion={resetMotionSettings}
            lang={lang}
            t={t}
          />
        ) : (
          <StyleTab
            instance={instance}
            project={project}
            setProject={setProject}
            actions={{
              updateAppearance,
              updateFontChoice,
              updatePagination,
              applyDisplayPreset,
              attachBackdrop,
              removeBackdropImage,
            }}
            uploadedFonts={uploadedFonts}
            fontError={fontError}
            onChooseFontSource={chooseFontSource}
            onAttachFontFile={(slot, file) => void attachFontFile(slot, file)}
            onResetAppearance={resetAppearanceSettings}
            lang={lang}
            t={t}
          />
        )}
      </div>
    </aside>
  );

  /** Picking one of the offered options, or opening the freeform answer field. */

  const inlineEditMessage = inlineEdit
    ? (project.messages.find((message) => message.id === inlineEdit.messageId) ?? null)
    : null;

  // Devtool source view: a highlighted excerpt of the generated SVG, focused
  // on the inspected node when there is one.
  const sourceView = useMemo(
    () => (showSvgInspector && previewSvg ? buildSourceView(previewSvg, inspectedNodeId) : null),
    [showSvgInspector, previewSvg, inspectedNodeId],
  );

  const applyAssistImport = (
    imported: ReturnType<typeof deserializeProject>,
    keepStyle: boolean,
  ) => {
    setProject((current) =>
      keepStyle
        ? {
            ...imported.project,
            appearance: current.appearance,
            display: current.display,
            fonts: current.fonts,
            chrome: current.chrome,
          }
        : imported.project,
    );
    setPageIndex(0);
    setImportWarnings(warningsWithFontMismatch(imported));
    setAppliedPreset(null);
    setWizardAppliedPresetLabel(null);
    // The imported script replaces every message id; pending undo entries
    // would restore strangers into it.
    scriptUndo.drop();
  };

  const applyPreset = (preset: ScriptPreset) => {
    const applyingFromWizard = wizardStep === WIZARD_SCRIPT_STEP;
    const replaceWithPreset = () => {
      const variant = preset.variants[lang];
      scriptJustReplacedRef.current = true;
      setAppliedPreset({ id: preset.id, edited: false });
      setProject((current) => ({
        ...current,
        title: variant.title,
        workspaceLabel: variant.workspaceLabel,
        branchLabel: variant.branchLabel,
        messages: instantiatePreset(preset, lang),
      }));
      setPageIndex(0);
      setImportWarnings([]);
      if (applyingFromWizard) {
        setWizardAppliedPresetLabel(preset.label[lang]);
        setWizardStep(WIZARD_EDIT_STEP);
      }
      // Applying is the gallery's terminal action; canceling the confirm
      // instead keeps it open for more browsing.
      closeGallery();
    };
    // The overwrite warning exists to protect the user's own writing. A
    // first visit's default script or a sample they just tried is not
    // that — warning there teaches that the warning is noise.
    if (!hasAuthoredMessagesRef.current) {
      replaceWithPreset();
      return;
    }
    setConfirmRequest({
      message: t.presetConfirm(preset.label[lang]),
      action: replaceWithPreset,
    });
  };

  /** The run button's action: save the script, or render the selected format. */
  const runSelectedExport = (options: { autoDownload?: boolean; allPages?: boolean } = {}) => {
    if (exportOverlay.kind === "script") {
      exportScript();
      return;
    }
    void runExport(exportOverlay.kind, options);
  };

  /**
   * Import warnings, plus the one the file itself cannot raise: a script
   * written with fonts this tab cannot reproduce renders at different metrics,
   * and nothing on screen says so — the text simply wraps somewhere else.
   */
  const warningsWithFontMismatch = (result: ReturnType<typeof deserializeProject>): string[] => {
    const recorded = result.provenance?.fonts;
    if (!recorded) {
      return result.warnings;
    }
    const slots = unresolvableFontSlots(recorded, result.project.fonts, uploadedFonts);
    return slots.length === 0
      ? result.warnings
      : [...result.warnings, t.importFontMismatch(slots.join(", "))];
  };

  const importScript = async (file: File) => {
    try {
      const result = deserializeProject(await file.text(), lang);
      setProject(result.project);
      setPageIndex(0);
      setImportWarnings(warningsWithFontMismatch(result));
      setAppliedPreset(null);
      // Same as the assist import: the new script owes nothing to entries
      // recorded against the old one.
      scriptUndo.drop();
      setUiError(null);
    } catch (cause) {
      setUiError(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };

  /**
   * The page labels in the script tab are effects of a control that lives
   * on the Style tab; tapping one jumps to the cause so it never has to
   * be hunted by tab name.
   */
  const jumpToFlowField = () => {
    setPanelTab("style");
    requestAnimationFrame(() => {
      const field = inShell(".flow-field");
      field?.scrollIntoView({ behavior: "smooth", block: "center" });
      field?.classList.remove("is-attention");
      requestAnimationFrame(() => field?.classList.add("is-attention"));
    });
  };

  /**
   * Clicking a chrome element on the canvas (title, clock, footer…) jumps
   * to the panel control that owns it and focuses its input — the focus
   * flashes the canvas element back, closing the loop.
   */
  const jumpToSceneField = (fieldKey: string) => {
    setPanelTab("scene");
    requestAnimationFrame(() => {
      const field = inShell(`.scene-field-${fieldKey}`);
      field?.scrollIntoView({ behavior: "smooth", block: "center" });
      field?.classList.remove("is-attention");
      requestAnimationFrame(() => field?.classList.add("is-attention"));
      field?.querySelector("input")?.focus({ preventScroll: true });
    });
  };

  /**
   * A choice block is one element: clicking it edits the whole option
   * list in the message's script card, not one line of text inline.
   */
  const jumpToMessageCard = (messageId: string) => {
    setPanelTab("script");
    requestAnimationFrame(() => {
      const card = inShell(`[data-message-id="${messageId}"]`);
      card?.scrollIntoView({ behavior: "smooth", block: "center" });
      card?.classList.remove("is-attention");
      requestAnimationFrame(() => card?.classList.add("is-attention"));
    });
  };

  // What a click on the canvas does: scene actions, inspector selection,
  // and the click-to-edit resolution shared with the touch long-press.
  const { handleStageClick, handleStageHover, openStageEditorAt } = useStageActions({
    project,
    t,
    mode: { showSvgInspector, canEditInline, playing },
    currentScrubMessageId,
    firstMessageId: scene.messageTimings[0]?.message.id ?? null,
    lastPointerTypeRef: stageLastPointerTypeRef,
    updateMessage,
    onUiError: setUiError,
    edit: { setStageInput, setInlineEdit },
    inspect: { setInspectedNodeId, setPinnedOutline, setHoverOutline, setEditHover },
    navigate: { jumpToSceneField, jumpToMessageCard, pauseAtMessage },
    onReplaceImage: (messageId, index) => {
      pendingImageRef.current = { messageId, index };
      imageReplaceInputRef.current?.click();
    },
  });

  // Ordered to echo the wizard — 見た目 → 文字とアニメ — with two
  // deliberate departures: 台本 leads because it is the tab reopened on
  // every edit, and シーン trails because the wizard never covers the
  // window's own labels.
  const panelTabs: Array<{ id: PanelTab; label: string }> = [
    { id: "script", label: t.tabScript(project.messages.length) },
    { id: "style", label: t.tabStyle },
    { id: "motion", label: t.tabMotion },
    { id: "scene", label: t.tabScene },
  ];

  return (
    <div className="studio-shell" data-ui-theme={uiTheme} data-chrome={chrome} ref={shellRef}>
      {chrome === "full" ? (
        <header className="studio-header" ref={headerRef}>
          {appHeader()}
        </header>
      ) : null}

      {tooltip ? (
        <div
          className="app-tooltip"
          role="tooltip"
          ref={tooltipRef}
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          {tooltip.text}
        </div>
      ) : null}
      {/* One stack for every bottom notice: coexistence is a flex gap,
      never a hand-tuned per-pair offset. */}
      <div className="notice-stack">
        {showRestoreNotice ? (
          <div className="restore-notice" role="status">
            <span>{restoreNoticeText(t, openedFrom.omittedImages)}</span>
            <button type="button" onClick={resetEverything}>
              {t.restoreStartFresh}
            </button>
            <button
              type="button"
              className="restore-dismiss"
              aria-label={t.restoreDismiss}
              onClick={() => setShowRestoreNotice(false)}
            >
              ✕
            </button>
          </div>
        ) : null}
        <UndoNotice
          stack={scriptUndo.stack}
          t={t}
          onUndo={scriptUndo.undo}
          onDismiss={scriptUndo.drop}
        />
        <AutosaveNotOwnedNotice owned={ownsPersistence} t={t} />
        <AutosaveFailedNotice failed={autosaveFailed} t={t} onDismiss={dismissAutosaveFailure} />
        <UseNoteToast open={useNoteToastOpen} t={t} onDismiss={dismissUseNoteToast} />
      </div>

      <main
        className="studio-main"
        style={{ "--sidebar-w": `${sidebarWidth}px` } as React.CSSProperties}
      >
        {chrome === "full" ? (
          <>
            {controlPanel()}

            {/* biome-ignore lint/a11y/useFocusableInteractive: pointer-only drag affordance; the sidebar width is cosmetic and all content stays reachable without resizing */}
            <div
              className="panel-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t.panelResizeAria}
              aria-valuenow={Math.round(sidebarWidth)}
              aria-valuemin={SIDEBAR_MIN_PX}
              aria-valuemax={SIDEBAR_MAX_PX}
              onPointerDown={startSidebarResize}
            />
          </>
        ) : null}

        {previewColumn()}
      </main>
    </div>
  );
}
