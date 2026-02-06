import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SCRIPT_PATH = resolve(process.cwd(), "scripts", "fake-codex-jsonrpc.js");

const runWorker = ({ env, inputLines }) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("node", [SCRIPT_PATH], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      resolvePromise({ code, signal, stdout, stderr });
    });

    if (Array.isArray(inputLines) && inputLines.length) {
      child.stdin.write(`${inputLines.join("\n")}\n`);
    }
    child.stdin.end();
  });

describe("fake-codex jsonrpc stdout flush", () => {
  test("does not truncate jsonrpc output when exiting after tool calls", async () => {
    const toolArgument = "x".repeat(2_000);
    const { stdout } = await runWorker({
      env: {
        CODEX_WORKER_SUPERVISED: "true",
        FAKE_CODEX_MODE: "tool_call",
        FAKE_CODEX_ERROR_AFTER_FIRST_TOOL: "true",
        FAKE_CODEX_TOOL_ARGUMENT: toolArgument,
        FAKE_CODEX_TOOL_CALL_COUNT: "500",
        FAKE_CODEX_WORKER_SHUTDOWN_DELAY_MS: "0",
      },
      inputLines: [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "turn/start",
          params: {
            threadId: "thread-1",
            input: [{ type: "text", text: "Hello", text_elements: [] }],
          },
        }),
      ],
    });

    const lines = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const parseErrors = [];
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch (err) {
        parseErrors.push({ line, message: err?.message || String(err) });
      }
    }
    expect(parseErrors).toEqual([]);
  });
});
