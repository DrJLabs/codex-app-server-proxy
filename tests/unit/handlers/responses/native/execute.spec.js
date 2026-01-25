import { describe, expect, it } from "vitest";
import { runNativeResponses } from "../../../../../src/handlers/responses/native/execute.js";
import { extractMetadataFromPayload } from "../../../../../src/lib/metadata-sanitizer.js";

describe("native responses executor", () => {
  it("emits text delta, usage, and finish events", async () => {
    const adapter = {
      async *iterStdoutLines() {
        yield JSON.stringify({ type: "agent_message_delta", msg: { delta: "hi" } });
        yield JSON.stringify({
          type: "token_count",
          msg: { prompt_tokens: 1, completion_tokens: 2 },
        });
        yield JSON.stringify({ type: "task_complete", msg: { finish_reason: "stop" } });
      },
    };

    const events = [];
    const result = await runNativeResponses({
      adapter,
      onEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "text_delta", delta: "hi", choiceIndex: 0 })
    );
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(events).toContainEqual({ type: "finish", reason: "stop", trigger: "task_complete" });
    expect(result.finishReason).toBe("stop");
  });

  it("captures metadata info when sanitizeMetadata is enabled", async () => {
    const adapter = {
      async *iterStdoutLines() {
        yield JSON.stringify({
          type: "agent_message_delta",
          msg: {
            delta: {
              content: "hello",
              metadata: { rollout_path: "/tmp/rollout", session_id: "s-1" },
            },
          },
        });
        yield JSON.stringify({ type: "task_complete", msg: { finish_reason: "stop" } });
      },
    };

    const events = [];
    await runNativeResponses({
      adapter,
      onEvent: (event) => events.push(event),
      sanitizeMetadata: true,
      extractMetadataFromPayload,
    });

    const textEvent = events.find((event) => event.type === "text_delta");
    expect(textEvent?.metadataInfo?.metadata?.rollout_path).toBe("/tmp/rollout");
    expect(textEvent?.metadataInfo?.metadata?.session_id).toBe("s-1");
    expect(textEvent?.metadataInfo?.sources).toContain("delta.metadata");
  });
});
