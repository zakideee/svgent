import type { StudioProductConfig } from "@svgent/studio";
import { version } from "../package.json";

export const STUDIO_PRODUCT_CONFIG: StudioProductConfig = {
  name: "svgent",
  version,
  engineVersion: "0.1.0",
  repositoryUrl: "https://github.com/zakideee/svgent",
  storageKeyPrefix: "svgent",
};
