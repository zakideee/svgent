/**
 * A stand-in `modelContext` for browsers without WebMCP, installed only in
 * development so the registration path and every tool can be exercised from
 * the console: `navigator.modelContext.executeTool("get_script", {})`.
 * Production pages never load this module; there the real API or nothing.
 */

import type { ModelContext, WebMcpTool } from "./webmcp.js";

type DevModelContext = ModelContext & {
  getTools: () => Array<Pick<WebMcpTool, "name" | "description" | "inputSchema" | "annotations">>;
  executeTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  isShim: true;
};

export function installDevShim(): DevModelContext {
  const tools = new Map<string, WebMcpTool>();
  const shim: DevModelContext = {
    isShim: true,
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      document.dispatchEvent(new Event("toolchange"));
    },
    unregisterTool: (name) => {
      tools.delete(name);
      document.dispatchEvent(new Event("toolchange"));
    },
    getTools: () =>
      [...tools.values()].map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema,
        annotations,
      })),
    executeTool: async (name, args = {}) => {
      const tool = tools.get(name);
      if (tool === undefined) {
        throw new Error(`No tool named ${name}; registered: ${[...tools.keys()].join(", ")}`);
      }
      const result = await tool.execute(args);
      const textPart = result.content.find((part) => part.type === "text");
      return textPart === undefined || textPart.type !== "text" ? null : JSON.parse(textPart.text);
    },
  };
  Object.defineProperty(navigator, "modelContext", { value: shim, configurable: true });
  return shim;
}
