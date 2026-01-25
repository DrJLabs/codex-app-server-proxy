import { test, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fetch from "node-fetch";
import { startServer, stopServer, wait } from "./helpers.js";

let child;

afterEach(async () => {
  if (child) {
    await stopServer(child);
    child = undefined;
  }
});

const readLastLogEntry = async (filePath) => {
  // Intentional dynamic path inside the test tmp directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp path under os.tmpdir
  const data = await fs.readFile(filePath, "utf8");
  const lines = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
};

const readTelemetryEntries = async (filePath) => {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp path under os.tmpdir
    const data = await fs.readFile(filePath, "utf8");
    return data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
};

const extractResponseText = (payload) => {
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  const first = outputs[0];
  if (!first || !Array.isArray(first.content)) return "";
  return first.content
    .filter((node) => node && node.type === "output_text" && typeof node.text === "string")
    .map((node) => node.text)
    .join("\n");
};

test("sanitizes metadata when toggle enabled", async () => {
  const tokenLogPath = path.join(
    os.tmpdir(),
    `responses-metadata-enabled-${Date.now()}-usage.ndjson`
  );
  const telemetryLogPath = path.join(
    os.tmpdir(),
    `responses-metadata-enabled-${Date.now()}-telemetry.ndjson`
  );
  const { PORT, child: proc } = await startServer({
    PROXY_SANITIZE_METADATA: "true",
    FAKE_CODEX_METADATA: "true",
    TOKEN_LOG_PATH: tokenLogPath,
    SANITIZER_LOG_PATH: telemetryLogPath,
  });
  child = proc;

  const response = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-sk-ci",
    },
    body: JSON.stringify({
      model: "codex-5",
      stream: false,
      input: "hello",
    }),
  });

  expect(response.ok).toBe(true);
  const body = await response.json();
  const outputText = extractResponseText(body);
  expect(outputText).toContain("Hello from fake-codex");
  expect(outputText).not.toContain("rollout_path");
  expect(outputText).not.toContain("session_id");

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

  const telemetryEntries = await readTelemetryEntries(telemetryLogPath);
  const toggleEntries = telemetryEntries.filter(
    (entry) => entry.kind === "proxy_sanitize_metadata"
  );
  expect(toggleEntries).not.toHaveLength(0);
  expect(toggleEntries[0].enabled).toBe(true);
  const summaryEntry = telemetryEntries.find(
    (entry) => entry.kind === "metadata_sanitizer_summary"
  );
  expect(summaryEntry).toBeDefined();
  expect(summaryEntry.enabled).toBe(true);
  expect(summaryEntry.sanitized_keys).toEqual(
    expect.arrayContaining(["rollout_path", "session_id"])
  );
  expect(summaryEntry.sanitized_sources).toEqual(expect.arrayContaining(["message.metadata"]));
});

test("retains metadata when toggle disabled", async () => {
  const tokenLogPath = path.join(
    os.tmpdir(),
    `responses-metadata-disabled-${Date.now()}-usage.ndjson`
  );
  const telemetryLogPath = path.join(
    os.tmpdir(),
    `responses-metadata-disabled-${Date.now()}-telemetry.ndjson`
  );
  const { PORT, child: proc } = await startServer({
    PROXY_SANITIZE_METADATA: "false",
    FAKE_CODEX_METADATA: "true",
    TOKEN_LOG_PATH: tokenLogPath,
    SANITIZER_LOG_PATH: telemetryLogPath,
  });
  child = proc;

  const response = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-sk-ci",
    },
    body: JSON.stringify({
      model: "codex-5",
      stream: false,
      input: "hello",
    }),
  });

  expect(response.ok).toBe(true);
  const body = await response.json();
  const outputText = extractResponseText(body);
  expect(outputText).toContain("rollout_path");
  expect(outputText).toContain("session_id");

  await wait(50);
  const usageEntry = await readLastLogEntry(tokenLogPath);
  expect(usageEntry).not.toBeNull();
  expect(usageEntry.metadata_sanitizer_enabled).toBe(false);
  expect(usageEntry.sanitized_metadata_count).toBe(0);
  expect(Array.isArray(usageEntry.sanitized_metadata_keys)).toBe(true);
  expect(usageEntry.sanitized_metadata_keys).toHaveLength(0);
  expect(Array.isArray(usageEntry.sanitized_metadata_sources)).toBe(true);
  expect(usageEntry.sanitized_metadata_sources).toHaveLength(0);

  const telemetryEntries = await readTelemetryEntries(telemetryLogPath);
  const toggleEntries = telemetryEntries.filter(
    (entry) => entry.kind === "proxy_sanitize_metadata"
  );
  expect(toggleEntries).toHaveLength(1);
  expect(toggleEntries[0].enabled).toBe(false);
  const summaryEntries = telemetryEntries.filter(
    (entry) => entry.kind === "metadata_sanitizer_summary"
  );
  expect(summaryEntries).toHaveLength(0);
});
