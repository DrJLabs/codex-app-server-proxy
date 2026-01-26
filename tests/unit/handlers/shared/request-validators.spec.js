import { describe, expect, it } from "vitest";
import { normalizeToolChoice } from "../../../../src/handlers/shared/request-validators.js";

describe("request validators", () => {
  it("rejects invalid tool_choice", () => {
    expect(() => normalizeToolChoice("bogus")).toThrow();
  });
});
