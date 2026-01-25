#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";

const supervised =
  String(process.env.CODEX_WORKER_SUPERVISED || "")
    .trim()
    .toLowerCase() === "true";

const readyDelayMs = Number(process.env.FAKE_CODEX_WORKER_READY_DELAY_MS ?? 20);
const heartbeatMs = Number(process.env.FAKE_CODEX_WORKER_HEARTBEAT_MS ?? 0);
const autoExitMs = Number(process.env.FAKE_CODEX_WORKER_AUTOEXIT_MS ?? 0);
const shutdownDelayMs = Number(process.env.FAKE_CODEX_WORKER_SHUTDOWN_DELAY_MS ?? 20);
const exitCode = Number(process.env.FAKE_CODEX_WORKER_EXIT_CODE ?? 0);
const errorAfterFirstTool =
  String(process.env.FAKE_CODEX_ERROR_AFTER_FIRST_TOOL || "").toLowerCase() === "true";
const emitUnauthorized = /^(1|true|yes)$/i.test(String(process.env.FAKE_CODEX_UNAUTHORIZED || ""));
const fakeAuthUrl =
  process.env.FAKE_CODEX_AUTH_URL || "https://example.com/fake-login?source=codex";
const fakeLoginId = process.env.FAKE_CODEX_LOGIN_ID || "login-fake-123";
const parseToolCallCount = () => {
  const parsed = Number.parseInt(process.env.FAKE_CODEX_TOOL_CALL_COUNT ?? "1", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return 1;
};
const parseToolBurstCount = () => {
  const raw = process.env.FAKE_CODEX_TOOL_BURST_COUNT;
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
};
const parseChoiceCount = () => {
  const raw = process.env.FAKE_CODEX_CHOICE_COUNT;
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return null;
};
const parseToolCallChoices = () => {
  const raw = process.env.FAKE_CODEX_TOOL_CALL_CHOICES;
  if (raw === undefined || raw === null || raw === "") return null;
  const indices = raw
    .split(/[,\s]+/)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isFinite(entry) && entry >= 0);
  if (!indices.length) return null;
  return Array.from(new Set(indices));
};
const toolCallCount = parseToolCallCount();
const toolBurstCount = parseToolBurstCount();
const choiceCount = parseChoiceCount();
const toolCallChoices = parseToolCallChoices();

let heartbeatTimer = null;
let autoExitTimer = null;

const clearTimers = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (autoExitTimer) {
    clearTimeout(autoExitTimer);
    autoExitTimer = null;
  }
};

const flushStdout = async () => {
  if (!process.stdout?.writableNeedDrain) return;
  await Promise.race([
    new Promise((resolve) => process.stdout.once("drain", resolve)),
    delay(1000),
  ]);
};

const scheduleExit = (code, delayMs = shutdownDelayMs) => {
  setTimeout(
    () => {
      const finishExit = () => process.exit(code);
      return flushStdout().then(finishExit, finishExit);
    },
    Math.max(0, delayMs)
  );
};

const write = (payload) => {
  try {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } catch {}
};

const hangMode = String(process.env.FAKE_CODEX_JSONRPC_HANG || "").toLowerCase();
const handshakeMode = String(process.env.FAKE_CODEX_HANDSHAKE_MODE || "").toLowerCase();
const skipReadyEvent = /^(1|true|yes)$/i.test(String(process.env.FAKE_CODEX_SKIP_READY || ""));
const captureRpc = /^(1|true|yes)$/i.test(String(process.env.FAKE_CODEX_CAPTURE_RPCS || ""));
const emitCapture = (direction, payload) => {
  if (!captureRpc) return;
  try {
    process.stderr.write(`${JSON.stringify({ capture: { direction, payload } })}\n`);
  } catch {}
};

const configuredToolArgument = process.env.FAKE_CODEX_TOOL_ARGUMENT;
const toolArgumentChunkSize = Number(process.env.FAKE_CODEX_TOOL_ARGUMENT_CHUNK_SIZE || 0);
const toolXmlChunkSize = Number.parseInt(process.env.FAKE_CODEX_TOOL_XML_CHUNK_SIZE ?? "", 10);
const truncateToolXml = /^(1|true|yes)$/i.test(
  String(process.env.FAKE_CODEX_TRUNCATE_TOOL_XML || "")
);
const abortAfterToolXml = /^(1|true|yes)$/i.test(
  String(process.env.FAKE_CODEX_ABORT_AFTER_TOOL_XML || "")
);
const emitTextualXml =
  String(process.env.FAKE_CODEX_EMIT_TEXTUAL_XML || "true").toLowerCase() !== "false";
const streamReadyFile = process.env.STREAM_READY_FILE;
const streamReleaseFile = process.env.STREAM_RELEASE_FILE;
const childPidFile = process.env.CHILD_PID_FILE;
const longStreamIntervalMs = Number(process.env.FAKE_CODEX_STREAM_INTERVAL_MS ?? 100);
const longStreamTicks = Number(process.env.FAKE_CODEX_STREAM_TICKS ?? 50);
const longStreamMaxTicksRaw = Number.parseInt(
  process.env.FAKE_CODEX_STREAM_RELEASE_MAX_TICKS ?? "",
  10
);
const longStreamMaxTicks =
  Number.isFinite(longStreamMaxTicksRaw) && longStreamMaxTicksRaw > 0
    ? longStreamMaxTicksRaw
    : 10_000;
const streamHangMs = Number(process.env.FAKE_CODEX_STREAM_HANG_MS ?? 10_000);
const splitToolArgumentPayload = (value) => {
  if (Number.isFinite(toolArgumentChunkSize) && toolArgumentChunkSize > 0) {
    const chunks = [];
    for (let i = 0; i < value.length; i += toolArgumentChunkSize) {
      chunks.push(value.slice(i, i + toolArgumentChunkSize));
    }
    return chunks.length ? chunks : [value];
  }

  if (!configuredToolArgument) {
    const match = value.match(/^(\{"id":")([^"]+)(.*)$/);
    if (match) {
      const [, prefix, idValue, suffix] = match;
      return [prefix, idValue, suffix].filter(Boolean);
    }
  }

  return [value];
};

const splitTextByByteLength = (value, chunkSize) => {
  if (!value || !Number.isFinite(chunkSize) || chunkSize <= 0) return [value];
  const chunks = [];
  let current = "";
  let currentBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (current && currentBytes + charBytes > chunkSize) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
      continue;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [value];
};

const applyToolXmlControls = (value) => {
  if (!value || typeof value !== "string") return value;
  if (!truncateToolXml || !value.includes("<use_tool")) return value;
  const closingAt = value.indexOf("</use_tool>");
  if (closingAt < 0) return value;
  const cutoff = Math.min(value.length, closingAt + 4);
  return value.slice(0, cutoff);
};

const splitToolXmlPayload = (value) => {
  if (!Number.isFinite(toolXmlChunkSize) || toolXmlChunkSize <= 0) {
    return [value];
  }
  if (!value || typeof value !== "string") return [value];
  if (!value.includes("<use_tool")) return [value];
  return splitTextByByteLength(value, toolXmlChunkSize);
};

async function runJsonRpcWorker() {
  process.stdin.setEncoding("utf8");
  try {
    if (childPidFile) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper
      fs.writeFileSync(childPidFile, String(process.pid), "utf8");
    }
  } catch {}
  write({ event: "starting" });
  await delay(Math.max(0, readyDelayMs));
  if (!skipReadyEvent) {
    write({ event: "ready", ready: true });
  }

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      write({ event: "heartbeat" });
    }, heartbeatMs);
  }

  if (autoExitMs > 0) {
    autoExitTimer = setTimeout(() => {
      clearTimers();
      write({ event: "exit", reason: "auto" });
      scheduleExit(exitCode, 0);
    }, autoExitMs);
  }

  let conversationSeq = 0;
  let subscriptionSeq = 0;
  const conversations = new Map();
  const subscriptions = new Map();
  const resolveConversationId = (params = {}) => {
    const provided = params.conversation_id || params.conversationId;
    if (provided) {
      if (!conversations.has(provided)) conversations.set(provided, {});
      return provided;
    }
    const generated = `conv-${++conversationSeq}`;
    conversations.set(generated, {});
    return generated;
  };

  const handleLine = async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      write({ event: "decode_error", message: err.message });
      return;
    }

    const { method, id, params = {} } = message;

    if (!method && id !== undefined) {
      // Ignore stray responses
      return;
    }

    switch (method) {
      case "initialize": {
        emitCapture("request", message);
        if (handshakeMode === "timeout") {
          return;
        }
        if (handshakeMode === "error") {
          write({
            jsonrpc: "2.0",
            id,
            error: {
              code: "handshake_failed",
              message: "handshake failed",
              data: { retryable: true },
            },
          });
          break;
        }
        if (handshakeMode === "exit") {
          process.nextTick(() => {
            clearTimers();
            scheduleExit(1, 0);
          });
          return;
        }
        write({
          jsonrpc: "2.0",
          id,
          result: { advertised_models: ["codex-5"], capabilities: { tools: {} } },
        });
        break;
      }
      case "newConversation": {
        emitCapture("request", message);
        const convId = `conv-${++conversationSeq}`;
        conversations.set(convId, { lastTurn: null });
        write({
          jsonrpc: "2.0",
          id,
          result: {
            conversation_id: convId,
            conversationId: convId,
            model: params?.model || process.env.CODEX_MODEL || "codex-5",
            reasoning_effort: null,
            reasoningEffort: null,
            rollout_path: `/tmp/${convId}.jsonl`,
            rolloutPath: `/tmp/${convId}.jsonl`,
          },
        });
        break;
      }
      case "addConversationListener": {
        emitCapture("request", message);
        const convId = resolveConversationId(params);
        const subscriptionId = `sub-${++subscriptionSeq}`;
        subscriptions.set(subscriptionId, convId);
        write({
          jsonrpc: "2.0",
          id,
          result: {
            subscription_id: subscriptionId,
            subscriptionId,
          },
        });
        break;
      }
      case "removeConversationListener": {
        emitCapture("request", message);
        const subscriptionId = params?.subscription_id || params?.subscriptionId;
        if (subscriptionId) subscriptions.delete(subscriptionId);
        write({ jsonrpc: "2.0", id, result: {} });
        break;
      }
      case "account/login/start": {
        emitCapture("request", message);
        const requestedType = typeof params?.type === "string" ? params.type.toLowerCase() : null;
        if (requestedType === "apikey") {
          write({
            jsonrpc: "2.0",
            id,
            result: { type: "apiKey" },
          });
          break;
        }
        write({
          jsonrpc: "2.0",
          id,
          result: {
            type: "chatgpt",
            authUrl: fakeAuthUrl,
            loginId: fakeLoginId,
          },
        });
        break;
      }
      case "sendUserTurn": {
        emitCapture("request", message);
        const convId = resolveConversationId(params);
        const existing = conversations.get(convId) || {};
        conversations.set(convId, { ...existing, lastTurn: params });
        write({ jsonrpc: "2.0", id, result: { conversation_id: convId } });
        break;
      }
      case "sendUserMessage": {
        emitCapture("request", message);
        const convId = resolveConversationId(params);
        if (hangMode === "message") {
          // Simulate a stalled worker by not emitting any response.
          return;
        }
        if (emitUnauthorized) {
          write({
            jsonrpc: "2.0",
            method: "error",
            params: {
              conversation_id: convId,
              request_id: params.request_id || convId,
              codexErrorInfo: "unauthorized",
              willRetry: false,
            },
          });
          return;
        }
        const scenario = String(process.env.FAKE_CODEX_MODE || "").toLowerCase();
        const requestId = params.request_id || convId;
        if (scenario === "stream_hang") {
          write({
            jsonrpc: "2.0",
            method: "agentMessageDelta",
            params: {
              conversation_id: convId,
              request_id: requestId,
              delta: "Hello (pre-hang)",
            },
          });
          if (streamReadyFile) {
            try {
              // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper
              fs.writeFileSync(streamReadyFile, String(process.pid), "utf8");
            } catch {}
          }
          await delay(streamHangMs);
          return;
        }
        if (scenario === "long_stream") {
          const shouldHoldOpen = Boolean(streamReleaseFile);
          let i = 0;
          while (true) {
            write({
              jsonrpc: "2.0",
              method: "agentMessageDelta",
              params: {
                conversation_id: convId,
                request_id: requestId,
                delta: `tick-${i} `,
              },
            });
            if (i === 0 && streamReadyFile) {
              try {
                // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper
                fs.writeFileSync(streamReadyFile, String(process.pid), "utf8");
              } catch {}
            }
            i += 1;
            if (!shouldHoldOpen && i >= longStreamTicks) break;
            if (shouldHoldOpen && i >= longStreamMaxTicks) break;
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper
            if (shouldHoldOpen && streamReleaseFile && fs.existsSync(streamReleaseFile)) {
              try {
                // eslint-disable-next-line security/detect-non-literal-fs-filename -- test helper
                fs.unlinkSync(streamReleaseFile);
              } catch {}
              break;
            }
            await delay(longStreamIntervalMs);
          }
          write({
            jsonrpc: "2.0",
            method: "agentMessage",
            params: {
              conversation_id: convId,
              request_id: requestId,
              message: {
                role: "assistant",
                content: "Long stream complete.",
              },
            },
          });
          write({
            jsonrpc: "2.0",
            method: "tokenCount",
            params: {
              conversation_id: convId,
              request_id: requestId,
              prompt_tokens: 8,
              completion_tokens: 12,
            },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: {
              finish_reason: "stop",
            },
          });
          return;
        }
        if (scenario === "crash") {
          process.nextTick(() => {
            clearTimers();
            process.exit(1);
          });
          return;
        }
        if (scenario === "error") {
          write({
            jsonrpc: "2.0",
            id,
            error: {
              code: "worker_error",
              message: "synthetic worker error",
              data: { retryable: false },
            },
          });
          return;
        }
        if (scenario === "multi_choice_tool") {
          const convId = resolveConversationId(params);
          const calls = [
            { id: "multi_tool_0", name: "lookup_user" },
            { id: "multi_tool_1", name: "send_email" },
          ];
          calls.forEach((call, idx) => {
            const argumentValue = configuredToolArgument || `{"id":"${42 + idx}","choice":${idx}}`;
            const argumentChunks = splitToolArgumentPayload(argumentValue);
            write({
              jsonrpc: "2.0",
              method: "agentMessageDelta",
              params: {
                conversation_id: convId,
                request_id: params.request_id || convId,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: call.id,
                      type: "function",
                      function: { name: call.name },
                    },
                  ],
                  choice_index: idx,
                },
                choice_index: idx,
              },
            });
            argumentChunks.forEach((chunk) => {
              write({
                jsonrpc: "2.0",
                method: "agentMessageDelta",
                params: {
                  conversation_id: convId,
                  request_id: params.request_id || convId,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: chunk },
                      },
                    ],
                    choice_index: idx,
                  },
                  choice_index: idx,
                },
              });
            });
          });
          calls.forEach((call, idx) => {
            write({
              jsonrpc: "2.0",
              method: "agentMessage",
              params: {
                conversation_id: convId,
                request_id: params.request_id || convId,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: `{"id":"${42 + idx}"}` },
                    },
                  ],
                  choice_index: idx,
                },
                choice_index: idx,
              },
            });
          });
          write({
            jsonrpc: "2.0",
            method: "tokenCount",
            params: {
              conversation_id: convId,
              request_id: params.request_id || convId,
              prompt_tokens: 5,
              completion_tokens: 5,
              finish_reason: "tool_calls",
            },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: {
              finish_reason: "tool_calls",
            },
          });
          return;
        }
        if (scenario === "multi_choice_tool_call") {
          const convId = resolveConversationId(params);
          const requestId = params.request_id || convId;
          const totalChoices = choiceCount ?? 2;
          const toolChoiceSet = new Set(toolCallChoices ?? [0]);
          const argumentValue = configuredToolArgument || '{"id":"42"}';
          const argumentChunks = splitToolArgumentPayload(argumentValue);

          for (let idx = 0; idx < totalChoices; idx += 1) {
            if (!toolChoiceSet.has(idx)) {
              write({
                jsonrpc: "2.0",
                method: "agentMessageDelta",
                params: {
                  conversation_id: convId,
                  request_id: requestId,
                  delta: { content: `Choice ${idx}`, choice_index: idx },
                  choice_index: idx,
                },
              });
              continue;
            }
            write({
              jsonrpc: "2.0",
              method: "agentMessageDelta",
              params: {
                conversation_id: convId,
                request_id: requestId,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `multi_tool_${idx}`,
                      type: "function",
                      function: { name: "lookup_user" },
                    },
                  ],
                  choice_index: idx,
                },
                choice_index: idx,
              },
            });
            for (const chunk of argumentChunks) {
              write({
                jsonrpc: "2.0",
                method: "agentMessageDelta",
                params: {
                  conversation_id: convId,
                  request_id: requestId,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: chunk },
                      },
                    ],
                    choice_index: idx,
                  },
                  choice_index: idx,
                },
              });
            }
          }

          for (let idx = 0; idx < totalChoices; idx += 1) {
            if (!toolChoiceSet.has(idx)) {
              write({
                jsonrpc: "2.0",
                method: "agentMessage",
                params: {
                  conversation_id: convId,
                  request_id: requestId,
                  message: {
                    role: "assistant",
                    content: `Choice ${idx}`,
                    choice_index: idx,
                  },
                  choice_index: idx,
                },
              });
              continue;
            }
            write({
              jsonrpc: "2.0",
              method: "agentMessage",
              params: {
                conversation_id: convId,
                request_id: requestId,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `multi_tool_${idx}`,
                      type: "function",
                      function: { name: "lookup_user", arguments: argumentValue },
                    },
                  ],
                  choice_index: idx,
                },
                choice_index: idx,
              },
            });
          }
          write({
            jsonrpc: "2.0",
            method: "tokenCount",
            params: {
              conversation_id: convId,
              request_id: requestId,
              prompt_tokens: 5,
              completion_tokens: 5,
              finish_reason: "tool_calls",
            },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: {
              finish_reason: "tool_calls",
            },
          });
          return;
        }

        const requestedFinish = String(process.env.FAKE_CODEX_FINISH_REASON || "stop")
          .trim()
          .toLowerCase();
        const requestedLength =
          ["length", "max_tokens", "token_limit", "token_limit_reached"].includes(
            requestedFinish
          ) || scenario === "truncation";
        let finishReason = "stop";
        if (scenario === "content_filter") {
          finishReason = "content_filter";
        } else if (
          scenario === "tool_call" ||
          scenario === "multi_tool_burst" ||
          scenario === "textual_tool" ||
          scenario === "textual_tool_tail"
        ) {
          // Tool calls take precedence over length/stop reasons.
          finishReason = "tool_calls";
        } else if (scenario === "function_call" && !requestedLength) {
          finishReason = "function_call";
        } else if (requestedLength) {
          finishReason = "length";
        }

        const parallelToolCalls = !/^false$/i.test(
          String(process.env.FAKE_CODEX_PARALLEL || "true")
        );
        const metadataMode = String(process.env.FAKE_CODEX_METADATA || "").toLowerCase();
        const metadataPayload =
          metadataMode && metadataMode !== "false"
            ? {
                rollout_path: "/app/.codex-api/sessions/fake-rollout",
                session_id: "fake-session-123",
                ...(metadataMode === "extra" ? { build_id: "fake-build" } : {}),
              }
            : null;

        const shouldEmitToolCalls =
          scenario === "tool_call" ||
          scenario === "function_then_tool" ||
          scenario === "multi_tool_burst";
        const effectiveToolCallCount =
          scenario === "multi_tool_burst" ? (toolBurstCount ?? toolCallCount) : toolCallCount;
        const toolCalls = shouldEmitToolCalls
          ? Array.from({ length: effectiveToolCallCount }).map((_, idx) => ({
              id: `tool_fake_${idx + 1}`,
              type: "function",
              function: {
                name: idx % 2 === 0 ? "lookup_user" : "send_email",
                arguments: configuredToolArgument || '{"id":"42"}',
              },
            }))
          : null;

        const functionCall =
          scenario === "function_call"
            ? {
                name: "lookup_user",
                arguments: '{"id":"42"}',
              }
            : null;

        const baseMessage = "Hello from fake-codex.";
        let messageText = "";
        const argumentValue = configuredToolArgument || '{"id":"42"}';
        if (scenario === "textual_tool") {
          messageText = `<use_tool>
  <name>lookup_user</name>
  <id>ユーザー-12345</id>
</use_tool>`;
        } else if (scenario === "textual_tool_tail") {
          messageText = `<use_tool>
  <name>lookup_user</name>
  <id>ユーザー-12345</id>
</use_tool> AFTER_TOOL_TEXT`;
        } else if (scenario === "token_count_only") {
          messageText = "Token-count only stream response.";
        } else if (
          emitTextualXml &&
          (shouldEmitToolCalls ||
            scenario === "multi_choice_tool" ||
            scenario === "multi_choice_tool_call")
        ) {
          messageText = `<use_tool>
  <name>lookup_user</name>
  <id>${argumentValue.replace(/"/g, "").replace(/[{}]/g, "").split(":").at(-1) || "42"}</id>
</use_tool>`;
        } else {
          const includeMessageText = ![
            "content_filter",
            "function_call",
            "function_then_tool",
          ].includes(scenario);
          if (includeMessageText) {
            messageText = baseMessage;
            if (metadataPayload) {
              const lines = Object.entries(metadataPayload)
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n");
              messageText = `${baseMessage}\n${lines}`;
            }
            if (scenario === "truncation" && !toolCalls && !functionCall) {
              messageText = "Hello (truncated) from fake-codex.";
            }
          }
        }
        messageText = applyToolXmlControls(messageText);
        // XML chunk emission moved after toolCalls when present
        const skipFinishOnDisconnect =
          String(process.env.FAKE_CODEX_SKIP_FINISH_ON_DISCONNECT || "").toLowerCase() === "true";

        if (toolCalls) {
          const argumentValue = configuredToolArgument || '{"id":"42"}';
          const shouldStreamArguments =
            parallelToolCalls ||
            (Number.isFinite(toolArgumentChunkSize) && toolArgumentChunkSize > 0);
          const argumentChunks = splitToolArgumentPayload(argumentValue);
          toolCalls.forEach((call, idx) => {
            write({
              jsonrpc: "2.0",
              method: "agentMessageDelta",
              params: {
                conversation_id: convId,
                request_id: params.request_id || convId,
                parallel_tool_calls: parallelToolCalls || effectiveToolCallCount > 1,
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      id: call.id,
                      type: call.type,
                      function: {
                        name: call.function.name,
                        ...(shouldStreamArguments ? {} : { arguments: argumentValue }),
                      },
                    },
                  ],
                },
              },
            });
            if (shouldStreamArguments) {
              for (const chunk of argumentChunks) {
                write({
                  jsonrpc: "2.0",
                  method: "agentMessageDelta",
                  params: {
                    conversation_id: convId,
                    request_id: params.request_id || convId,
                    delta: {
                      tool_calls: [
                        {
                          index: idx,
                          function: { arguments: chunk },
                        },
                      ],
                    },
                  },
                });
              }
            }
          });
          if (shouldEmitToolCalls) {
            await delay(10);
          }
          if (messageText) {
            const messageChunks = splitToolXmlPayload(messageText);
            for (const chunk of messageChunks) {
              write({
                jsonrpc: "2.0",
                method: "agentMessageDelta",
                params: {
                  conversation_id: convId,
                  request_id: params.request_id || convId,
                  delta: chunk,
                },
              });
            }
          }

          if (abortAfterToolXml && messageText.includes("<use_tool")) {
            clearTimers();
            scheduleExit(exitCode, 0);
            return;
          }

          if (skipFinishOnDisconnect) {
            clearTimers();
            return;
          }
        } else if (messageText) {
          const messageChunks = splitToolXmlPayload(messageText);
          for (const chunk of messageChunks) {
            write({
              jsonrpc: "2.0",
              method: "agentMessageDelta",
              params: {
                conversation_id: convId,
                request_id: params.request_id || convId,
                delta: chunk,
              },
            });
          }

          if (abortAfterToolXml && messageText.includes("<use_tool")) {
            clearTimers();
            scheduleExit(exitCode, 0);
            return;
          }
        }

        const assistantMessage = {
          role: "assistant",
          content: toolCalls || functionCall ? messageText || null : messageText || null,
        };
        if (toolCalls) assistantMessage.tool_calls = toolCalls;
        if (functionCall) assistantMessage.function_call = functionCall;
        if (metadataPayload) assistantMessage.metadata = metadataPayload;

        const messageEnvelope = {
          conversation_id: convId,
          request_id: params.request_id || convId,
          message: assistantMessage,
        };
        if (toolCalls) {
          messageEnvelope.parallel_tool_calls = parallelToolCalls;
        }
        if (scenario === "function_then_tool") {
          write({
            jsonrpc: "2.0",
            method: "agentMessage",
            params: {
              ...messageEnvelope,
              message: {
                role: "assistant",
                content: null,
                function_call: {
                  name: "lookup_user",
                  arguments: '{"id":"42"}',
                },
              },
            },
          });
        }

        write({
          jsonrpc: "2.0",
          method: "agentMessage",
          params: messageEnvelope,
        });

        let promptTokens = 8;
        let completionTokens = toolCalls
          ? 16
          : functionCall
            ? 0
            : Math.ceil(messageText.length / 4);
        if (scenario === "truncation" && !toolCalls && !functionCall) {
          promptTokens = 5;
          completionTokens = 9;
        }
        const usagePayload = {
          conversation_id: convId,
          request_id: params.request_id || convId,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
        };
        if (finishReason === "length") {
          usagePayload.finish_reason = "length";
          usagePayload.reason = "length";
          usagePayload.token_limit_reached = true;
        } else if (finishReason === "content_filter") {
          usagePayload.finish_reason = "content_filter";
        }
        if (scenario === "provider_usage") {
          write({
            jsonrpc: "2.0",
            method: "usage",
            params: usagePayload,
          });
        } else {
          write({
            jsonrpc: "2.0",
            method: "tokenCount",
            params: usagePayload,
          });
        }

        if (errorAfterFirstTool && shouldEmitToolCalls) {
          write({
            jsonrpc: "2.0",
            method: "agentMessage",
            params: {
              conversation_id: convId,
              request_id: params.request_id || convId,
              message: {
                role: "assistant",
                content: null,
                tool_calls: toolCalls,
              },
            },
          });
          write({
            jsonrpc: "2.0",
            id,
            result: {
              finish_reason: "tool_calls",
            },
          });
          clearTimers();
          scheduleExit(1);
          return;
        }

        write({
          jsonrpc: "2.0",
          id,
          result: {
            finish_reason: finishReason,
          },
        });
        break;
      }
      default: {
        write({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Unknown method: ${method}`,
          },
        });
        break;
      }
    }
  };

  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      await handleLine(line);
    }
  }

  const trailing = buffer.replace(/\r$/, "").trim();
  if (trailing) {
    await handleLine(trailing);
  }
}

function setupSignalHandlers() {
  const shutdown = (signal) => {
    write({ event: "shutdown", signal });
    clearTimers();
    scheduleExit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main() {
  setupSignalHandlers();
  await runJsonRpcWorker();
  await new Promise(() => {}); // keep alive
}

if (supervised) {
  main().catch((err) => {
    write({ event: "fatal", message: err?.message || String(err) });
    clearTimers();
    scheduleExit(1, 0);
  });
} else {
  // Fallback: emit a minimal event for direct execution
  write({ event: "fallback", mode: "jsonrpc" });
  process.stdin.resume();
}
