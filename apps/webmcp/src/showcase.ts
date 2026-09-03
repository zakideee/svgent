/**
 * Scripts that show the range of what a session can look like: four written
 * for the problems agent-app users have, and three copied from the studio's
 * own README and site examples (a workspace app imports only its own files).
 * The person loads one with a click; the agent reads it back with get_script
 * and directs from there.
 */

import { deserializeProject, type SvgentProject } from "@svgent/scene";
import appImage from "../scripts/app-image.json";
import approvalsSlides from "../scripts/approvals-slides.json";
import denyRepro from "../scripts/deny-repro.json";
import jaTuiZoom from "../scripts/ja-ime.json";
import mcpReadme from "../scripts/mcp-readme.json";
import shareSafely from "../scripts/share-safely.json";
import heroTuiZoom from "../scripts/terminal-camera.json";
import { applySceneDirection, type SceneDirection } from "./direction.js";

type Showcase = {
  id: string;
  label: string;
  hint: string;
  raw: unknown;
  /** A look applied over the example's own, where the showcase wants another. */
  look?: SceneDirection;
};

export const SHOWCASES: Showcase[] = [
  {
    id: "share-safely",
    label: "A clip for the team channel",
    hint: "What we did, re-staged for a post or a channel: the flow stays, names and keys stay out.",
    raw: shareSafely,
  },
  {
    id: "deny-repro",
    label: "When a decline was missed",
    hint: "A calm, reproducible clip of what happened, for when screen recording is not an option.",
    raw: denyRepro,
  },
  {
    id: "approvals-slides",
    label: "Choices and approvals, 3 slides",
    hint: "A walk-through for a colleague: a choice, an allow-always and a held thought, one beat per slide.",
    raw: approvalsSlides,
  },
  {
    id: "mcp-readme",
    label: "Your MCP, in the README",
    hint: "Your own tool in use, at link-card size, with a completion in the composer.",
    raw: mcpReadme,
  },
  {
    id: "hero-tui-camera",
    label: "Terminal · camera",
    hint: "A session about staging a session; the camera leans in on each beat.",
    raw: heroTuiZoom,
  },
  {
    id: "app-image",
    label: "App · image generation",
    hint: "A choice, then a generating skeleton that resolves to the picture.",
    raw: appImage,
    look: { backdrop: "peach" },
  },
  {
    id: "ja-ime",
    label: "日本語 · IME typing",
    hint: "Japanese input staged as IME conversion; a denied approval, then an allowed one.",
    raw: jaTuiZoom,
    look: { theme: "nordic", backdrop: "abyss" },
  },
];

export function showcaseProject(showcase: Showcase): SvgentProject {
  const { project } = deserializeProject(JSON.stringify(showcase.raw), "en");
  return showcase.look === undefined
    ? project
    : applySceneDirection(project, showcase.look).project;
}
