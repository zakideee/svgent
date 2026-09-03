import { describe, expect, it } from "vitest";
import { createApproveProposalTool, createStudioTools } from "../../apps/webmcp/src/tools.js";

const READ_TOOLS = ["get_script", "inspect_timeline", "list_presets", "snapshot_frame"];
const WRITE_TOOLS = [
  "apply_patch",
  "direct_camera",
  "direct_scene",
  "edit_message",
  "export",
  "fit_duration",
  "load_script",
  "preview",
  "propose_patch",
];

describe("WebMCP tool classifications", () => {
  it("explicitly classifies every static tool as read or write", () => {
    const host: Parameters<typeof createStudioTools>[0] = {
      studio: () => null,
      privacy: () => "fictionalized",
      askPerson: async () => "rejected",
      rememberBefore: () => {},
      record: () => {},
    };
    const tools = createStudioTools(host);

    expect(
      tools
        .filter((tool) => tool.annotations.readOnlyHint)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(READ_TOOLS);
    expect(
      tools
        .filter((tool) => !tool.annotations.readOnlyHint)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(WRITE_TOOLS);
  });

  it("classifies the temporary approval tool as a write", () => {
    const tool = createApproveProposalTool({
      handle: "proposal-test",
      waitForDecision: async () => "rejected",
      record: () => {},
    });

    expect(tool.annotations.readOnlyHint).toBe(false);
  });
});
