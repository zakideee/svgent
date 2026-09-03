import "./app.css";

export type { SvgentProject } from "@svgent/scene";
export { App as Studio } from "./App.js";
export type { StudioPersistence } from "./persistence.js";
export { createLocalStoragePersistence } from "./persistence.js";
export type {
  StudioChrome,
  StudioExportResult,
  StudioHandle,
  StudioLocale,
  StudioProductConfig,
  StudioProps,
} from "./public-types.js";
