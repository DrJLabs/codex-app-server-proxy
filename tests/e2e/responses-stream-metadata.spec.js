import { test, expect } from "@playwright/test";
import fetch from "node-fetch";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, stopServer, wait } from "../integration/helpers.js";
import { parseSSE } from "../shared/transcript-utils.js";

const readLastLogEntry = async (filePath) => {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp path under os.tmpdir
  const data = await fs.readFile(filePath, "utf8");
  const lines = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
};

const collectStreamText = (entries) => {
  const deltas = entries.filter((entry) => entry?.event === "response.output_text.delta");
  return deltas
    .map((entry) => {
      const delta = entry.data?.delta;
      return typeof delta === "string" ? delta : "";
    })
    .join("");
};

const extractCompletedResponse = (entries) => {
  const completed = entries.find((entry) => entry?.event === "response.completed");
  return completed?.data?.response ?? null;
};

test.describe("Responses metadata sanitizer toggle", () => {
  test("redacts metadata when PROXY_SANITIZE_METADATA=true", async () => {
    const tokenLogPath = path.join(
      os.tmpdir(),
      `responses-stream-metadata-enabled-${Date.now()}-usage.ndjson`
    );
    const telemetryLogPath = path.join(
      os.tmpdir(),
      `responses-stream-metadata-enabled-${Date.now()}-telemetry.ndjson`
    );
    const { PORT, child } = await startServer({
      PROXY_SANITIZE_METADATA: "true",
      FAKE_CODEX_METADATA: "true",
      TOKEN_LOG_PATH: tokenLogPath,
      SANITIZER_LOG_PATH: telemetryLogPath,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-sk-ci",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "codex-5",
          stream: true,
          input: "hello",
        }),
      });

      expect(response.ok).toBeTruthy();
      const raw = await response.text();
      const entries = parseSSE(raw);
      const streamText = collectStreamText(entries);
      expect(streamText).toContain("Hello from fake-codex.");
      expect(streamText).not.toContain("rollout_path");
      expect(streamText).not.toContain("session_id");

      const completed = extractCompletedResponse(entries);
      expect(completed).not.toBeNull();
      const content =
        completed?.output?.[0]?.content?.filter?.(
          (node) => node && node.type === "output_text" && typeof node.text === "string"
        ) ?? [];
      const combined = content.map((node) => node.text).join("\n");
      expect(combined).not.toContain("rollout_path");
      expect(combined).not.toContain("session_id");

      await wait(50);
      const usageEntry = await readLastLogEntry(tokenLogPath);
      expect(usageEntry).not.toBeNull();
      expect(usageEntry.metadata_sanitizer_enabled).toBe(true);
      expect(usageEntry.sanitized_metadata_count).toBeGreaterThanOrEqual(2);
      expect(usageEntry.sanitized_metadata_keys).toEqual(
        expect.arrayContaining(["rollout_path", "session_id"])
      );
      expect(Array.isArray(usageEntry.sanitized_metadata_sources)).toBe(true);
      expect(usageEntry.sanitized_metadata_sources).toContain("message.metadata");
    } finally {
      await stopServer(child);
    }
  });

  test("preserves metadata when PROXY_SANITIZE_METADATA=false", async () => {
    const tokenLogPath = path.join(
      os.tmpdir(),
      `responses-stream-metadata-disabled-${Date.now()}-usage.ndjson`
    );
    const telemetryLogPath = path.join(
      os.tmpdir(),
      `responses-stream-metadata-disabled-${Date.now()}-telemetry.ndjson`
    );
    const { PORT, child } = await startServer({
      PROXY_SANITIZE_METADATA: "false",
      FAKE_CODEX_METADATA: "true",
      TOKEN_LOG_PATH: tokenLogPath,
      SANITIZER_LOG_PATH: telemetryLogPath,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-sk-ci",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "codex-5",
          stream: true,
          input: "hello",
        }),
      });

      expect(response.ok).toBeTruthy();
      const raw = await response.text();
      const entries = parseSSE(raw);
      const streamText = collectStreamText(entries);
      expect(streamText).toContain("rollout_path");
      expect(streamText).toContain("session_id");

      await wait(50);
      const usageEntry = await readLastLogEntry(tokenLogPath);
      expect(usageEntry).not.toBeNull();
      expect(usageEntry.metadata_sanitizer_enabled).toBe(false);
      expect(usageEntry.sanitized_metadata_count).toBe(0);
      expect(Array.isArray(usageEntry.sanitized_metadata_keys)).toBe(true);
      expect(usageEntry.sanitized_metadata_keys).toHaveLength(0);
      expect(Array.isArray(usageEntry.sanitized_metadata_sources)).toBe(true);
      expect(usageEntry.sanitized_metadata_sources).toHaveLength(0);
    } finally {
      await stopServer(child);
    }
  });
});
