import { describe, expect, it } from "vitest";

import {
  CHAT_INTERNAL_TOOLS_INSTRUCTION,
  RESPONSES_INTERNAL_TOOLS_INSTRUCTION,
} from "../../../src/lib/prompts/internal-tools-instructions.js";

describe("internal tools instructions", () => {
  it("exposes saved chat guidance for potential reuse", () => {
    expect(CHAT_INTERNAL_TOOLS_INSTRUCTION).toMatch(
      "Never use internal tools (shell/exec_command/apply_patch/update_plan/view_image)."
    );
  });

  it("exposes saved responses guidance for potential reuse", () => {
    expect(RESPONSES_INTERNAL_TOOLS_INSTRUCTION).toMatch(
      "Never use internal tools (web_search, view_image, fileChange, commandExecution, mcpToolCall, shell, exec_command, apply_patch, update_plan)."
    );
  });
});
