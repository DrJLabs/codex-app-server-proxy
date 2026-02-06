import { afterEach, describe, expect, it, vi } from "vitest";

const originalAppServerRaw = process.env.PROXY_CAPTURE_APP_SERVER_RAW;
const originalAppServerRawDir = process.env.PROXY_CAPTURE_APP_SERVER_RAW_DIR;
const originalAppServerRawMax = process.env.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES;
const originalThinkingRaw = process.env.PROXY_CAPTURE_THINKING_RAW;
const originalThinkingRawDir = process.env.PROXY_CAPTURE_THINKING_RAW_DIR;
const originalThinkingRawMax = process.env.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES;

afterEach(() => {
  if (originalAppServerRaw === undefined) {
    delete process.env.PROXY_CAPTURE_APP_SERVER_RAW;
  } else {
    process.env.PROXY_CAPTURE_APP_SERVER_RAW = originalAppServerRaw;
  }
  if (originalAppServerRawDir === undefined) {
    delete process.env.PROXY_CAPTURE_APP_SERVER_RAW_DIR;
  } else {
    process.env.PROXY_CAPTURE_APP_SERVER_RAW_DIR = originalAppServerRawDir;
  }
  if (originalAppServerRawMax === undefined) {
    delete process.env.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES;
  } else {
    process.env.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES = originalAppServerRawMax;
  }
  if (originalThinkingRaw === undefined) {
    delete process.env.PROXY_CAPTURE_THINKING_RAW;
  } else {
    process.env.PROXY_CAPTURE_THINKING_RAW = originalThinkingRaw;
  }
  if (originalThinkingRawDir === undefined) {
    delete process.env.PROXY_CAPTURE_THINKING_RAW_DIR;
  } else {
    process.env.PROXY_CAPTURE_THINKING_RAW_DIR = originalThinkingRawDir;
  }
  if (originalThinkingRawMax === undefined) {
    delete process.env.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES;
  } else {
    process.env.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES = originalThinkingRawMax;
  }
  vi.resetModules();
});

describe("config dev-only raw capture", () => {
  it("exposes default capture settings", async () => {
    delete process.env.PROXY_CAPTURE_APP_SERVER_RAW;
    delete process.env.PROXY_CAPTURE_APP_SERVER_RAW_DIR;
    delete process.env.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES;
    delete process.env.PROXY_CAPTURE_THINKING_RAW;
    delete process.env.PROXY_CAPTURE_THINKING_RAW_DIR;
    delete process.env.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES;
    vi.resetModules();
    const { config } = await import("../../../src/config/index.js");

    expect(config.PROXY_CAPTURE_APP_SERVER_RAW).toBe(false);
    expect(config.PROXY_CAPTURE_APP_SERVER_RAW_DIR).toContain("test-results");
    expect(config.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES).toBeGreaterThan(0);
    expect(config.PROXY_CAPTURE_THINKING_RAW).toBe(false);
    expect(config.PROXY_CAPTURE_THINKING_RAW_DIR).toContain("test-results");
    expect(config.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES).toBeGreaterThan(0);
  });

  it("accepts overrides", async () => {
    process.env.PROXY_CAPTURE_APP_SERVER_RAW = "true";
    process.env.PROXY_CAPTURE_APP_SERVER_RAW_DIR = "/tmp/app-server";
    process.env.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES = "1024";
    process.env.PROXY_CAPTURE_THINKING_RAW = "true";
    process.env.PROXY_CAPTURE_THINKING_RAW_DIR = "/tmp/thinking";
    process.env.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES = "2048";
    vi.resetModules();
    const { config } = await import("../../../src/config/index.js");

    expect(config.PROXY_CAPTURE_APP_SERVER_RAW).toBe(true);
    expect(config.PROXY_CAPTURE_APP_SERVER_RAW_DIR).toBe("/tmp/app-server");
    expect(config.PROXY_CAPTURE_APP_SERVER_RAW_MAX_BYTES).toBe(1024);
    expect(config.PROXY_CAPTURE_THINKING_RAW).toBe(true);
    expect(config.PROXY_CAPTURE_THINKING_RAW_DIR).toBe("/tmp/thinking");
    expect(config.PROXY_CAPTURE_THINKING_RAW_MAX_BYTES).toBe(2048);
  });
});
