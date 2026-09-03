import { createRoot } from "react-dom/client";
import "@svgent/studio/styles.css";
import "./app.css";
import { App } from "./App.js";

// Without WebMCP in the browser, development installs a console-driven
// stand-in so the tool layer can be exercised. Production ships without it.
if (import.meta.env.DEV && !navigator.modelContext && !document.modelContext) {
  const { installDevShim } = await import("./dev-shim.js");
  installDevShim();
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

// No StrictMode: its double-mount makes the studio claim its storage
// namespace twice in development, and the second claim is refused.
createRoot(root).render(<App />);
