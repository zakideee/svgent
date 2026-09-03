/**
 * Scene tab: the labels and chrome values printed into the scene,
 * grouped by where they sit on the canvas. App and TUI keep separate
 * group orders because the two surfaces put these regions in different
 * places — the panel reads top-to-bottom like the rendered window does.
 * Attribution closes both lists: it belongs to no single region, and it is
 * the one section here that is not a matter of taste.
 */

import {
  type DisplaySettings,
  type ModelLabelIssueCode,
  modelLabelIssue,
  type ProductMarkPlacement,
  productMarkPlacements,
  type SvgentProject,
} from "@svgent/scene";
import type React from "react";
import { NumberField, TextField } from "../fields.js";
import type { UiStrings } from "../i18n.js";
import type { useProjectActions } from "../project-actions.js";
import type { StudioProductConfig } from "../public-types.js";

function modelIssueText(code: ModelLabelIssueCode | null, t: UiStrings): string | null {
  if (code === null) {
    return null;
  }
  return code === "empty" ? t.modelIssueEmpty : t.modelIssueTooLong;
}

export function SceneTab({
  project,
  setProject,
  actions,
  onFieldFocus,
  pageIndex,
  product,
  t,
}: {
  project: SvgentProject;
  /** Top-level label edits (title, workspace, branch, model) live on the project root. */
  setProject: React.Dispatch<React.SetStateAction<SvgentProject>>;
  actions: Pick<ReturnType<typeof useProjectActions>, "updateChrome" | "updateDisplay">;
  /** Flash the matching element in the preview when a field takes focus. */
  onFieldFocus: (fieldKey: string) => void;
  /**
   * The page on show, already clamped by the scene builder. Attribution is
   * answered per page — a terminal greets on its first one only — so the
   * panel has to report the page the preview is actually drawing.
   */
  pageIndex: number;
  product: StudioProductConfig;
  t: UiStrings;
}) {
  const { updateChrome, updateDisplay } = actions;

  const displayToggle = (key: keyof DisplaySettings, label: string): React.ReactNode => (
    <label key={key} className="display-toggle">
      <input
        type="checkbox"
        checked={project.display[key]}
        onChange={(event) => updateDisplay(key, event.currentTarget.checked)}
      />
      {label}
    </label>
  );

  /**
   * A Scene tab group, named after a place on the canvas or — with no gate
   * key — after something the canvas has no one place for. The heading
   * checkbox removes the region itself; the rows inside choose what the
   * region shows. Fields stay editable while the region is off — dimmed,
   * not locked — so drafting text never requires flipping chrome back on.
   */
  const positionGroup = (options: {
    label: string;
    gateKey: keyof DisplaySettings | null;
    children: React.ReactNode;
    className?: string;
  }): React.ReactNode => (
    <section
      className={`position-group${options.className === undefined ? "" : ` ${options.className}`}${
        options.gateKey !== null && !project.display[options.gateKey] ? " is-off" : ""
      }`}
    >
      <h3 className="group-title position-title">
        {options.gateKey !== null ? (
          <label className="group-gate">
            <input
              type="checkbox"
              checked={project.display[options.gateKey]}
              onChange={(event) => {
                if (options.gateKey !== null) {
                  updateDisplay(options.gateKey, event.currentTarget.checked);
                }
              }}
            />
            {options.label}
          </label>
        ) : (
          options.label
        )}
      </h3>
      <div className="position-body">{options.children}</div>
    </section>
  );

  const titleField = (
    <TextField
      label={t.fieldTitle}
      value={project.title}
      onChange={(title) => setProject((current) => ({ ...current, title }))}
      maxLength={80}
      onFocus={() => onFieldFocus("title")}
      className="scene-field-title"
    />
  );

  const workspaceField = (
    <TextField
      label={t.fieldWorkspace}
      value={project.workspaceLabel}
      onChange={(workspaceLabel) => setProject((current) => ({ ...current, workspaceLabel }))}
      maxLength={70}
      onFocus={() => onFieldFocus("workspace")}
      className="scene-field-workspace"
    />
  );

  const branchField = (note: string | null): React.ReactNode => (
    <>
      <TextField
        label={t.fieldBranch}
        value={project.branchLabel}
        onChange={(branchLabel) => setProject((current) => ({ ...current, branchLabel }))}
        maxLength={70}
        onFocus={() => onFieldFocus("workspace")}
      />
      {note !== null ? <small className="panel-note">{note}</small> : null}
    </>
  );

  const clockField = (
    <TextField
      label={t.clockLabel}
      value={project.chrome.clockTime}
      onChange={(clockTime) => updateChrome("clockTime", clockTime)}
      issue={
        project.chrome.clockTime.trim().length === 0 ||
        /^\d{1,2}:\d{2}$/u.test(project.chrome.clockTime)
          ? null
          : t.clockIssue
      }
      maxLength={5}
      onFocus={() => onFieldFocus("clock")}
      className="scene-field-clock"
    />
  );

  const modelField = (note: string | null): React.ReactNode => (
    <>
      <TextField
        label={t.fieldModel}
        value={project.modelLabel}
        onChange={(modelLabel) => setProject((current) => ({ ...current, modelLabel }))}
        issue={modelIssueText(modelLabelIssue(project.modelLabel), t)}
        maxLength={40}
        onFocus={() => onFieldFocus("footer")}
        className="scene-field-footer"
      />
      {note !== null ? <small className="panel-note">{note}</small> : null}
    </>
  );

  const contextField = (
    <NumberField
      label={t.fieldContext}
      value={project.chrome.contextPercent}
      min={0}
      max={100}
      onChange={(value) =>
        updateChrome("contextPercent", Math.min(100, Math.max(0, Math.round(value))))
      }
      onFocus={() => onFieldFocus("footer")}
    />
  );

  /*
   * Its own section, and not a position group, because it asks a different
   * question. Every other box here is staging — how should this picture look.
   * This one asks whether the evidence that the picture was generated may
   * come off, and it reaches two regions at once on the TUI. The places are
   * listed from the current state rather than written down, so the coupling
   * with the footer shows itself: turn the footer off and the line loses an
   * entry. With no gate on the heading it never dims, which is the point —
   * a warning that fades exactly when it applies is no warning.
   */
  const placementNames: Record<ProductMarkPlacement, string> = {
    banner: t.markPlaceBanner,
    footer: t.markPlaceFooter,
  };
  const placements = productMarkPlacements(project, pageIndex);
  const attributionGroup = positionGroup({
    label: t.groupAttribution,
    // The gate is the mark itself, so the version below it reads as what it
    // is: a detail of something that may not be there at all. Off, it dims
    // with the region — but the warning under it does not, which is why this
    // section narrows what the dim covers.
    gateKey: "productMark",
    className: "attribution-group",
    children: (
      <>
        <div className="display-toggle-row">
          {displayToggle("productVersion", t.displayProductVersion(`v${product.version}`))}
        </div>
        {/* Both lines share this one slot, under the boxes like every other
            note in this panel. Above them, the two would trade places as the
            mark goes on and off and walk the checkbox out from under the
            pointer mid-click. */}
        {placements.length > 0 ? (
          <small className="panel-note">
            {t.markPlacements(
              product.name,
              placements.map((placement) => placementNames[placement]).join(t.listSeparator),
            )}
          </small>
        ) : (
          <small className="mark-off-hint">{t.markOffHint(product.name)}</small>
        )}
      </>
    ),
  });

  /** App surface, top to bottom: header → composer → footer. */
  const appSceneGroups = (
    <>
      {positionGroup({
        label: t.groupHeader,
        gateKey: "header",
        children: (
          <>
            {/* Contents of a region the heading owns. Both may go while the
                band stays — an empty title bar is a real window state. */}
            <div className="display-toggle-row" role="group" aria-label={t.groupHeader}>
              {displayToggle("headerIcons", t.displayHeaderIcons)}
              {displayToggle("headerText", t.displayHeaderText)}
            </div>
            {titleField}
            {workspaceField}
            {branchField(null)}
            {clockField}
          </>
        ),
      })}
      {positionGroup({
        label: t.displayComposer,
        gateKey: "composer",
        children: (
          <>
            <small className="panel-note">{t.composerContentsNote}</small>
            <small className="panel-note">{t.composerTypingNote}</small>
          </>
        ),
      })}
      {positionGroup({
        label: t.displayFooter,
        gateKey: "footer",
        children: (
          <>
            {modelField(t.alsoInComposer)}
            {contextField}
            <small className="panel-note">{t.footerPageNote}</small>
          </>
        ),
      })}
      {attributionGroup}
    </>
  );

  /** TUI surface, top to bottom: title bar → body top → prompt → footer. */
  const tuiSceneGroups = (
    <>
      {positionGroup({
        label: t.groupTitlebar,
        gateKey: "header",
        children: (
          <>
            <div className="display-toggle-row" role="group" aria-label={t.groupTitlebar}>
              {displayToggle("headerIcons", t.displayHeaderIcons)}
              {displayToggle("headerText", t.displayHeaderText)}
              {displayToggle("tuiTitle", t.displayTuiTitle)}
              {displayToggle("tuiClock", t.displayTuiClock)}
              {displayToggle("tuiGeometry", t.displayTuiGeometry)}
            </div>
            {titleField}
            {workspaceField}
            {clockField}
          </>
        ),
      })}
      {positionGroup({
        label: t.groupBodyTop,
        gateKey: null,
        children: branchField(t.alsoInPrompt),
      })}
      {positionGroup({
        label: t.groupPrompt,
        gateKey: "composer",
        children: (
          <>
            {contextField}
            <div className="display-toggle-row" role="group" aria-label={t.groupPrompt}>
              {displayToggle("tuiStatusHints", t.displayTuiStatusHints)}
            </div>
            <small className="panel-note">{t.composerTypingNote}</small>
          </>
        ),
      })}
      {positionGroup({
        label: t.displayFooter,
        gateKey: "footer",
        children: (
          <>
            {modelField(null)}
            <small className="panel-note">{t.footerPageNote}</small>
          </>
        ),
      })}
      {attributionGroup}
    </>
  );

  return (
    <div className="field-stack">{project.surface === "app" ? appSceneGroups : tuiSceneGroups}</div>
  );
}
