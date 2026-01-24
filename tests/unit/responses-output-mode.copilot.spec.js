import { describe, expect, it } from "vitest";
import {
  detectCopilotRequest,
  resolveResponsesOutputMode,
} from "../../src/handlers/responses/shared.js";

describe("responses output mode for Copilot", () => {
  it("detects Copilot via User-Agent", () => {
    const req = { headers: { "user-agent": "obsidian/1.9.7 Electron/37.2.4" } };
    expect(detectCopilotRequest(req)).toBe(true);
  });

  it("detects Copilot via un/JS User-Agent", () => {
    const req = { headers: { "user-agent": "un/JS 6.5.0" } };
    expect(detectCopilotRequest(req)).toBe(true);
  });

  it("detects Copilot via trace header", () => {
    const req = { headers: { "x-copilot-trace-id": "copilot-test" } };
    expect(detectCopilotRequest(req)).toBe(true);
  });

  it("detects Copilot via x-trace-id header", () => {
    const req = { headers: { "x-trace-id": "trace-test" } };
    expect(detectCopilotRequest(req)).toBe(true);
  });

  it("does not detect generic clients", () => {
    const req = { headers: { "user-agent": "curl/8.0" } };
    expect(detectCopilotRequest(req)).toBe(false);
  });

  it("ignores legacy UA detection when no explicit header provided", () => {
    const req = { headers: { "user-agent": "obsidian/1.9.7" } };
    const result = resolveResponsesOutputMode({
      req,
      defaultValue: "openai-json",
      copilotDefault: "obsidian-xml",
    });
    expect(result.effective).toBe("openai-json");
    expect(result.source).toBe("default");
  });

  it("ignores high-confidence classifier when no explicit header provided", () => {
    const req = { headers: { "user-agent": "curl/8.0" } };
    const result = resolveResponsesOutputMode({
      req,
      defaultValue: "openai-json",
      copilotDefault: "obsidian-xml",
      copilotDetection: {
        copilot_detected: true,
        copilot_detect_tier: "high",
        copilot_detect_reasons: ["marker_recent_conversations"],
      },
    });
    expect(result.effective).toBe("openai-json");
    expect(result.source).toBe("default");
  });

  it("does not force obsidian-xml for suspected classifier", () => {
    const req = { headers: { "user-agent": "curl/8.0" } };
    const result = resolveResponsesOutputMode({
      req,
      defaultValue: "openai-json",
      copilotDefault: "obsidian-xml",
      copilotDetection: {
        copilot_detected: true,
        copilot_detect_tier: "suspected",
        copilot_detect_reasons: ["ua_obsidian"],
      },
    });
    expect(result.effective).toBe("openai-json");
    expect(result.source).toBe("default");
  });

  it("respects explicit x-proxy-output-mode", () => {
    const req = {
      headers: {
        "user-agent": "obsidian/1.9.7",
        "x-proxy-output-mode": "openai-json",
      },
    };
    const result = resolveResponsesOutputMode({
      req,
      defaultValue: "openai-json",
      copilotDefault: "obsidian-xml",
    });
    expect(result.effective).toBe("openai-json");
    expect(result.source).toBe("header");
  });
});
