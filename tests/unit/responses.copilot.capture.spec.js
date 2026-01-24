import { describe, expect, test } from "vitest";
import { loadCopilotResponsesFixture } from "../shared/copilot-fixtures.js";
import {
  coerceInputToChatMessages,
  resolveResponsesOutputMode,
} from "../../src/handlers/responses/shared.js";

describe("copilot responses fixtures", () => {
  test("stream text fixture normalizes to chat messages", async () => {
    const fixture = await loadCopilotResponsesFixture("responses-stream-text.json");
    const messages = coerceInputToChatMessages(fixture.request.body);

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("<redacted>");
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
