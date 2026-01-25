import { describe, expect, test } from "vitest";
import {
  applyDefaultProxyOutputModeHeader,
  normalizeMessageId,
  normalizeResponseId,
  resolveResponsesOutputMode,
} from "../../src/handlers/responses/shared.js";

describe("responses shared helpers", () => {
  test("normalizeResponseId strips chatcmpl- prefix and applies resp_", () => {
    expect(normalizeResponseId("chatcmpl-abc")).toBe("resp_abc");
  });

  test("normalizeMessageId preserves msg_ prefix", () => {
    expect(normalizeMessageId("msg_123")).toBe("msg_123");
  });

  test("resolveResponsesOutputMode uses header or default", () => {
    const req = { headers: { "x-proxy-output-mode": " openai-json " } };
    const headerResult = resolveResponsesOutputMode({ req, defaultValue: "obsidian-xml" });
    expect(headerResult).toEqual({ effective: "openai-json", source: "header" });

    const defaultResult = resolveResponsesOutputMode({
      req: { headers: {} },
      defaultValue: "openai-json",
    });
    expect(defaultResult).toEqual({ effective: "openai-json", source: "default" });
  });

  test("applyDefaultProxyOutputModeHeader sets and restores header", () => {
    const req = { headers: {} };
    const restore = applyDefaultProxyOutputModeHeader(req, "openai-json");
    expect(req.headers["x-proxy-output-mode"]).toBe("openai-json");
    restore();
    expect(req.headers["x-proxy-output-mode"]).toBeUndefined();
  });

  test("applyDefaultProxyOutputModeHeader does not override explicit header", () => {
    const req = { headers: { "x-proxy-output-mode": "obsidian-xml" } };
    const restore = applyDefaultProxyOutputModeHeader(req, "openai-json");
    expect(req.headers["x-proxy-output-mode"]).toBe("obsidian-xml");
    restore();
    expect(req.headers["x-proxy-output-mode"]).toBe("obsidian-xml");
  });
});
