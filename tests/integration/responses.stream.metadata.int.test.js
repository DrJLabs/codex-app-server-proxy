import { test, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fetch from "node-fetch";
import { startServer, stopServer, wait } from "./helpers.js";
import { parseSSE } from "../shared/transcript-utils.js";

let child;

afterEach(async () => {
  if (child) {
    await stopServer(child);
    child = undefined;
  }
});

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

const collectDeltaText = (entries) => {
  let text = "";
  for (const entry of entries) {
    if (entry?.type !== "data") continue;
    if (entry.event !== "response.output_text.delta") continue;
    const delta = entry.data?.delta;
    if (typeof delta === "string" && delta) text += delta;
  }
  return text;
};

const findCompletedEnvelope = (entries) => {
  const completed = entries.find(
    (entry) => entry?.type === "data" && entry.event === "response.completed"
  );
  return completed?.data?.response ?? null;
};

test("sanitizes streaming metadata when toggle enabled", async () => {
  const tokenLogPath = path.join(
    os.tmpdir(),
    `responses-stream-metadata-enabled-${Date.now()}-usage.ndjson`
  );
  const telemetryLogPath = path.join(
    os.tmpdir(),
    `responses-stream-metadata-enabled-${Date.now()}-telemetry.ndjson`
  );
  const { PORT, child: proc } = await startServer({
    PROXY_SANITIZE_METADATA: "true",
    FAKE_CODEX_METADATA: "true",
    TOKEN_LOG_PATH: tokenLogPath,
    SANITIZER_LOG_PATH: telemetryLogPath,
  });
  child = proc;

  const response = await fetch(`http://127.0.0.1:${PORT}/v1/responses?stream=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-sk-ci",
    },
    body: JSON.stringify({
      model: "codex-5",
      stream: true,
      input: "hello",
      stream_options: { include_usage: true },
    }),
  });

  expect(response.ok).toBe(true);
  const raw = await response.text();
  const entries = parseSSE(raw);
  const text = collectDeltaText(entries);
  expect(text).toContain("Hello from fake-codex.");
  expect(text).not.toContain("rollout_path");
  expect(text).not.toContain("session_id");

  const completed = findCompletedEnvelope(entries);
  expect(completed).toBeTruthy();
  const messageContent = Array.isArray(completed?.output)
    ? completed.output.flatMap((node) => node?.content || [])
    : [];
  const aggregatedText = messageContent
    .filter((node) => node && node.type === "output_text" && typeof node.text === "string")
    .map((node) => node.text)
    .join("\n");
  expect(aggregatedText).toContain("Hello from fake-codex.");
  expect(aggregatedText).not.toContain("rollout_path");
  expect(aggregatedText).not.toContain("session_id");

  const completedEntry = entries.find(
    (entry) => entry?.type === "data" && entry.event === "response.completed"
  );
  expect(completedEntry).toBeTruthy();
  const responseUsage = completedEntry?.data?.response?.usage;
  expect(responseUsage).toBeDefined();

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
});

test("retains streaming metadata when toggle disabled", async () => {
  const tokenLogPath = path.join(
    os.tmpdir(),
    `responses-stream-metadata-disabled-${Date.now()}-usage.ndjson`
  );
  const telemetryLogPath = path.join(
    os.tmpdir(),
    `responses-stream-metadata-disabled-${Date.now()}-telemetry.ndjson`
  );
  const { PORT, child: proc } = await startServer({
    PROXY_SANITIZE_METADATA: "false",
    FAKE_CODEX_METADATA: "true",
    TOKEN_LOG_PATH: tokenLogPath,
    SANITIZER_LOG_PATH: telemetryLogPath,
  });
  child = proc;

  const response = await fetch(`http://127.0.0.1:${PORT}/v1/responses?stream=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-sk-ci",
    },
    body: JSON.stringify({
      model: "codex-5",
      stream: true,
      input: "hello",
      stream_options: { include_usage: true },
    }),
  });

  expect(response.ok).toBe(true);
  const raw = await response.text();
  const entries = parseSSE(raw);
  const text = collectDeltaText(entries);
  expect(text).toContain("rollout_path");
  expect(text).toContain("session_id");

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
