/**
 * The subset of WebMCP this page relies on. The current draft and built-in
 * browsers expose `document.modelContext`; older implementations used
 * `navigator.modelContext`. The standard lifecycle uses an AbortSignal, while
 * some hosts also expose `unregisterTool`.
 */

export type WebMcpToolResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  /** The result's own fields, for a client that takes a plain object. */
  [field: string]: unknown;
};

export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Required locally so every tool is explicitly classified for browser UIs. */
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint?: boolean;
  };
  execute: (args: Record<string, unknown>) => Promise<WebMcpToolResult>;
};

export type ModelContext = {
  registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => Promise<void> | void;
  unregisterTool?: (name: string) => Promise<void> | void;
};

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: only an interface merges into the DOM globals
  interface Navigator {
    modelContext?: ModelContext;
  }
  // biome-ignore lint/style/useConsistentTypeDefinitions: only an interface merges into the DOM globals
  interface Document {
    modelContext?: ModelContext;
  }
}
