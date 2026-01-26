import { describe, expect, test } from "vitest";
import { loadCopilotResponsesFixture } from "../shared/copilot-fixtures.js";
import { normalizeResponsesRequest } from "../../src/handlers/responses/native/request.js";
import { resolveResponsesOutputMode } from "../../src/handlers/responses/shared.js";

describe("copilot responses fixtures", () => {
  test("stream text fixture flattens to a role-tagged transcript", async () => {
    const fixture = await loadCopilotResponsesFixture("responses-stream-text.json");
    const normalized = normalizeResponsesRequest(fixture.request.body);
    expect(normalized.inputItems).toHaveLength(1);
    const item = normalized.inputItems[0];
    expect(item.type).toBe("text");
    expect(item.data.text).toContain("[assistant]");
    expect(item.data.text).toContain("[user]");
    expect(item.data.text).toContain("<redacted>");

    expect(item.data.text.split("\n").length).toBeGreaterThan(1);
  });

  test("stream fixture resolves output mode consistent with capture", async () => {
    const fixture = await loadCopilotResponsesFixture("responses-stream-tool.json");
    const req = { headers: fixture.request.headers };
    const result = resolveResponsesOutputMode({
      req,
      defaultValue: "openai-json",
    });

    expect(result.effective).toBe("openai-json");
  });
});
