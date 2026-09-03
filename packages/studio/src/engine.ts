import { loadWasmModule, type ResolvedBrowserFont } from "@boundsvg/browser";
import { createEngineAsync, type Engine } from "@boundsvg/core";
import { initWasm } from "@boundsvg/core/wasm";
import { useEffect, useState } from "react";

type EngineState =
  | { status: "loading"; engine: null; error: null }
  | { status: "ready"; engine: Engine; error: null }
  | { status: "error"; engine: null; error: Error };

let wasmReady: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  wasmReady ??= loadWasmModule()
    .then((wasmModule) => initWasm(wasmModule))
    .catch((error: unknown) => {
      // A transient fetch failure must not poison every later engine build
      // until a full page reload; drop the cached rejection so the next
      // build retries (fonts.ts evicts its cache entry the same way).
      wasmReady = null;
      throw error;
    });
  return wasmReady;
}

/**
 * Builds an engine for the given fonts and rebuilds it whenever the resolved
 * font set changes — boundsvg bakes fonts in at engine creation, so swapping
 * a font source means a fresh engine.
 */
export function useSvgentEngine(fonts: ResolvedBrowserFont[] | null): EngineState {
  const [state, setState] = useState<EngineState>({
    status: "loading",
    engine: null,
    error: null,
  });

  useEffect(() => {
    if (fonts === null) {
      setState({ status: "loading", engine: null, error: null });
      return;
    }
    let active = true;
    let initializedEngine: Engine | null = null;
    setState({ status: "loading", engine: null, error: null });
    void ensureWasm()
      .then(() => createEngineAsync({ fonts }))
      .then((engine) => {
        initializedEngine = engine;
        if (!active) {
          engine.dispose();
          return;
        }
        setState({ status: "ready", engine, error: null });
      })
      .catch((cause: unknown) => {
        if (!active) {
          return;
        }
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState({ status: "error", engine: null, error });
      });

    return () => {
      active = false;
      initializedEngine?.dispose();
    };
  }, [fonts]);

  return state;
}
