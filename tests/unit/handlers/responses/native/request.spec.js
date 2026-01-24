import { describe, expect, it } from "vitest";
import { normalizeResponsesRequest } from "../../../../../src/handlers/responses/native/request.js";

const expectNormalizeError = (fn) => {
  try {
    fn();
  } catch (err) {
    if (err?.body) return err.body;
    return err;
  }
  throw new Error("expected normalization error");
};

describe("native responses request normalizer", () => {
  it("rejects top-level messages", () => {
    const body = { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] };
    const err = expectNormalizeError(() => normalizeResponsesRequest(body));
    expect(err.error.param).toBe("messages");
  });

  it("flattens instructions and input text into a single transcript item", () => {
    const body = { instructions: "Be nice", input: "Hi" };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      { type: "text", data: { text: "[system] Be nice\n[user] Hi" } },
    ]);
  });

  it("flattens message and function_call_output items", () => {
    const body = {
      input: [
        { type: "message", role: "assistant", content: "ok" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      { type: "text", data: { text: "[assistant] ok\n[tool:c1] done" } },
    ]);
  });

  it("emits role marker and image items for input_image", () => {
    const body = { input: [{ type: "input_image", image_url: "https://img" }] };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      { type: "text", data: { text: "[user]" } },
      { type: "image", data: { image_url: "https://img" } },
    ]);
  });

  it("emits role markers around images inside messages", () => {
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "hi" },
            { type: "input_image", image_url: "https://img" },
            { type: "input_text", text: "there" },
          ],
        },
      ],
    };
    const result = normalizeResponsesRequest(body);
    expect(result.inputItems).toEqual([
      { type: "text", data: { text: "[user] hi" } },
      { type: "text", data: { text: "[user]" } },
      { type: "image", data: { image_url: "https://img" } },
      { type: "text", data: { text: "[user] there" } },
    ]);
  });

  it("rejects unsupported input item types", () => {
    const err = expectNormalizeError(() =>
      normalizeResponsesRequest({ input: [{ type: "bogus" }] })
    );
    expect(err.error.param).toBe("input[0]");
  });
});
