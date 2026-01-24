import { describe, expect, it } from "vitest";
import { runNativeResponses } from "../../../../../src/handlers/responses/native/execute.js";

describe("native responses executor", () => {
  it("emits text delta, usage, and finish events", async () => {
    const adapter = {
      async *iterStdoutLines() {
        yield JSON.stringify({ type: "agent_message_delta", msg: { delta: "hi" } });
        yield JSON.stringify({ type: "token_count", msg: { prompt_tokens: 1, completion_tokens: 2 } });
        yield JSON.stringify({ type: "task_complete", msg: { finish_reason: "stop" } });
      },
    };

    const events = [];
    const result = await runNativeResponses({
      adapter,
      onEvent: (event) => events.push(event),
    });

    expect(events).toContainEqual({ type: "text_delta", delta: "hi", choiceIndex: 0 });
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect(events).toContainEqual({ type: "finish", reason: "stop", trigger: "task_complete" });
    expect(result.finishReason).toBe("stop");
  });
});
