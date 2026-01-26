import { describe, expect, it } from "vitest";
import { resolveResponsesOutputMode } from "../../src/handlers/responses/shared.js";

describe("responses output mode resolution", () => {
  it("uses default when header is absent", () => {
    const req = { headers: { "user-agent": "obsidian/1.9.7" } };
    const result = resolveResponsesOutputMode({ req, defaultValue: "openai-json" });
    expect(result).toEqual({ effective: "openai-json", source: "default" });
  });

  it("uses explicit header when provided", () => {
    const req = {
      headers: {
        "user-agent": "obsidian/1.9.7",
        "x-proxy-output-mode": "obsidian-xml",
      },
    };
    const result = resolveResponsesOutputMode({ req, defaultValue: "openai-json" });
    expect(result).toEqual({ effective: "obsidian-xml", source: "header" });
  });
});
