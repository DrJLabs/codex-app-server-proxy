#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import fetch from "node-fetch";
import { startServer, stopServer } from "../tests/integration/helpers.js";
import {
  RESPONSES_TRANSCRIPT_ROOT,
  saveResponsesTranscript,
  sanitizeResponsesNonStream,
  sanitizeResponsesStreamTranscript,
  parseSSE,
  buildMetadata,
} from "../tests/shared/transcript-utils.js";

const BASE_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer test-sk-ci",
};

function gitCommitSha() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function runCapture({ codexBin, filename, includeUsage = false, capture, env = {} }) {
  const ctx = await startServer({ CODEX_BIN: codexBin, ...env });
  try {
    const { request, response, stream, metadataExtra = {} } = await capture(ctx.PORT);
    const transcript = {
      metadata: buildMetadata({
        includeUsage,
        codexBin,
        commit: gitCommitSha(),
        extra: { scenario: filename.replace(/\.json$/, ""), ...metadataExtra },
      }),
      request,
    };
    if (response) transcript.response = response;
    if (stream) transcript.stream = stream;
    await saveResponsesTranscript(filename, transcript);
  } finally {
    await stopServer(ctx.child);
  }
}

async function captureNonStreamMinimal({ codexBin }) {
  await runCapture({
    codexBin,
    filename: "nonstream-minimal.json",
    capture: async (port) => {
      const request = {
        model: "codex-5",
        input: "Write a single sentence bedtime story about a friendly dragon.",
      };
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: BASE_HEADERS,
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        throw new Error(`non-stream responses request failed (${res.status})`);
      }
      const payload = await res.json();
      return {
        request,
        response: sanitizeResponsesNonStream(payload),
      };
    },
  });
}

async function captureNonStreamToolCall({ codexBin }) {
  await runCapture({
    codexBin,
    filename: "nonstream-tool-call.json",
    env: { FAKE_CODEX_MODE: "tool_call" },
    capture: async (port) => {
      const request = {
        model: "codex-5",
        instructions: "Use the legacy_lookup tool when the user asks for an id.",
        input: [{ type: "input_text", text: "Look up user 42." }],
        tools: [
          {
            type: "function",
            function: {
              name: "legacy_lookup",
              description: "Returns fake info",
              parameters: {
                type: "object",
                properties: {
                  id: { type: "string" },
                },
                required: ["id"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "legacy_lookup" },
        },
      };
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: BASE_HEADERS,
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        throw new Error(`non-stream tool-call responses request failed (${res.status})`);
      }
      const payload = await res.json();
      return {
        request,
        response: sanitizeResponsesNonStream(payload),
      };
    },
  });
}

async function captureStreamingText({ codexBin }) {
  await runCapture({
    codexBin,
    filename: "streaming-text.json",
    includeUsage: true,
    capture: async (port) => {
      const request = {
        model: "codex-5",
        input: "Stream a short greeting.",
        stream: true,
        stream_options: { include_usage: true },
      };
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: BASE_HEADERS,
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        throw new Error(`streaming responses request failed (${res.status})`);
      }
      const raw = await res.text();
      const chunks = parseSSE(raw);
      return {
        request,
        stream: sanitizeResponsesStreamTranscript(chunks),
      };
    },
  });
}

async function captureStreamingToolCall({ codexBin }) {
  await runCapture({
    codexBin,
    filename: "streaming-tool-call.json",
    includeUsage: true,
    env: { FAKE_CODEX_MODE: "tool_call" },
    capture: async (port) => {
      const request = {
        model: "codex-5",
        stream: true,
        stream_options: { include_usage: true },
        instructions: "Use lookup_user tool when needed.",
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_user",
              description: "Returns fake info",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
            },
          },
        ],
        tool_choice: {
          type: "function",
          function: { name: "lookup_user" },
        },
        input: "Lookup user 42 via tool",
      };
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: "POST",
        headers: BASE_HEADERS,
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        throw new Error(`streaming tool-call responses request failed (${res.status})`);
      }
      const raw = await res.text();
      const chunks = parseSSE(raw);
      return {
        request,
        stream: sanitizeResponsesStreamTranscript(chunks),
      };
    },
  });
}

async function main() {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path derived from project root constants
  await mkdir(RESPONSES_TRANSCRIPT_ROOT, { recursive: true });
  const argIndex = process.argv.indexOf("--codex");
  const codexBin =
    (argIndex !== -1 && process.argv[argIndex + 1]) ||
    process.env.CODEX_TRANSCRIPT_BIN ||
    "scripts/fake-codex-jsonrpc.js";
  await captureNonStreamMinimal({ codexBin });
  await captureNonStreamToolCall({ codexBin });
  await captureStreamingText({ codexBin });
  await captureStreamingToolCall({ codexBin });
}

main().catch((err) => {
  console.error("[generate-responses-transcripts] failed", err);
  process.exitCode = 1;
});
