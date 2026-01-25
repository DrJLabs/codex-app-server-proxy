/* eslint-disable security/detect-non-literal-fs-filename */
import { beforeAll, afterAll, test, expect } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fetch from "node-fetch";
import { startServer, stopServer, wait } from "./helpers.js";

let PORT;
let child;
let PID_FILE;
let readyFile;
let releaseFile;
let tempDir;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "responses-kill-"));
  PID_FILE = path.join(tempDir, "child.pid");
  readyFile = path.join(tempDir, "stream-ready");
  releaseFile = path.join(tempDir, "stream-release");
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
  try {
    if (existsSync(readyFile)) unlinkSync(readyFile);
  } catch {}
  try {
    if (existsSync(releaseFile)) unlinkSync(releaseFile);
  } catch {}
  const server = await startServer({
    PROXY_API_KEY: "test-sk-ci",
    CODEX_BIN: "scripts/fake-codex-jsonrpc.js",
    FAKE_CODEX_MODE: "long_stream",
    PROXY_PROTECT_MODELS: "false",
    PROXY_SSE_KEEPALIVE_MS: "0",
    PROXY_KILL_ON_DISCONNECT: "true",
    PROXY_TEST_ENDPOINTS: "true",
    STREAM_READY_FILE: readyFile,
    STREAM_RELEASE_FILE: releaseFile,
    CHILD_PID_FILE: PID_FILE,
  });
  PORT = server.PORT;
  child = server.child;
}, 10_000);

afterAll(async () => {
  await stopServer(child);
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
  try {
    if (existsSync(readyFile)) unlinkSync(readyFile);
  } catch {}
  try {
    if (existsSync(releaseFile)) unlinkSync(releaseFile);
  } catch {}
  if (tempDir) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("aborting responses stream cancels request without killing worker", async () => {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses?stream=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-sk-ci",
    },
    body: JSON.stringify({
      model: "codex-5",
      stream: true,
      input: "hold",
    }),
    signal: controller.signal,
  });

  expect(res.ok).toBeTruthy();
  const pidStart = Date.now();
  while (!existsSync(PID_FILE) && Date.now() - pidStart < 1000) {
    await wait(20);
  }
  const iterator = res.body[Symbol.asyncIterator]();
  // consume one chunk to ensure streaming underway
  await iterator.next();
  controller.abort();

  // wait for proxy to propagate abort and cancel request
  await wait(300);

  const pidRaw = existsSync(PID_FILE) ? readFileSync(PID_FILE, "utf8").trim() : "";
  expect(pidRaw).not.toBe("");
  const pid = Number(pidRaw);
  expect(Number.isFinite(pid)).toBe(true);

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive).toBe(true);
  const ready = await fetch(`http://127.0.0.1:${PORT}/readyz`);
  expect(ready.ok).toBe(true);

  // Ensure concurrency guard released after abort
  const start = Date.now();
  while (Date.now() - start < 2000) {
    const concRes = await fetch(`http://127.0.0.1:${PORT}/__test/conc`, {
      headers: { Authorization: "Bearer test-sk-ci" },
    });
    const { conc } = await concRes.json();
    if (Number(conc || 0) === 0) return;
    await wait(50);
  }
  throw new Error("concurrency guard did not drain after abort");
});
