import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInitializeParams,
  buildNewConversationParams,
  buildAddConversationListenerParams,
  buildRemoveConversationListenerParams,
  buildSendUserMessageParams,
  buildSendUserTurnParams,
} from "../../src/lib/json-rpc/schema.ts";
import { normalizeChatJsonRpcRequest } from "../../src/handlers/chat/request.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const SCHEMA_PATH = resolve(
  PROJECT_ROOT,
  "docs",
  "reference",
  "app-server-protocol.schema.json"
);

async function loadValidator() {
  const raw = await readFile(SCHEMA_PATH, "utf8");
  const bundle = JSON.parse(raw);
  const ajv = new Ajv2020({ strict: false, allowUnionTypes: true });
  const schemaId = "codex-jsonrpc-schema";
  const bundleCopy = { ...bundle, $id: schemaId };
  ajv.addSchema(bundleCopy, schemaId);
  return {
    validate(typeName, value) {
      return ajv.validate({ $ref: `${schemaId}#/definitions/${typeName}` }, value);
    },
  };
}

describe("json-rpc payload schema", () => {
  it("produces initialize/sendUserTurn/sendUserMessage payloads that satisfy schema", async () => {
    const validator = await loadValidator();

    const sampleBody = {
      model: "codex-5",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 256,
      parallel_tool_calls: true,
      user: "validator",
      reasoning: { effort: "high" },
      messages: [
        { role: "system", content: "You are a tester" },
        { role: "user", content: "Echo data" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "echo arguments",
            parameters: { type: "object", properties: { text: { type: "string" } } },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "echo" } },
    };

    const normalized = normalizeChatJsonRpcRequest({
      body: sampleBody,
      messages: sampleBody.messages,
      prompt: sampleBody.messages.map((m) => m.content).join("\n"),
      reqId: "test-request",
      requestedModel: sampleBody.model,
      effectiveModel: "gpt-5.2",
      choiceCount: 1,
      stream: true,
      reasoningEffort: "high",
      sandboxMode: "danger-full-access",
      codexWorkdir: "/tmp",
      approvalMode: "never",
    });

    const initializeParams = buildInitializeParams({
      clientInfo: { name: "schema-validator", version: "1.0.0" },
      capabilities: {},
    });
    const newConversationParams = buildNewConversationParams({
      model: normalized.turn.model,
      modelProvider: null,
      profile: null,
      cwd: normalized.turn.cwd,
      approvalPolicy: normalized.turn.approvalPolicy,
      sandbox: normalized.turn.sandboxPolicy,
      baseInstructions: normalized.turn.baseInstructions ?? undefined,
    });
    const turnParams = buildSendUserTurnParams({
      ...normalized.turn,
      conversationId: "conv-validator",
      requestId: "req-validator",
    });
    expect(turnParams.choiceCount).toBe(1);
    expect(turnParams.choice_count).toBe(1);
    const messageParams = buildSendUserMessageParams({
      ...normalized.message,
      conversationId: "conv-validator",
      requestId: "req-validator",
    });
    const addListenerParams = buildAddConversationListenerParams({
      conversationId: "conv-validator",
      experimentalRawEvents: false,
    });
    const removeListenerParams = buildRemoveConversationListenerParams({
      subscriptionId: "sub-validator",
    });

    expect(validator.validate("InitializeParams", initializeParams)).toBe(true);
    expect(validator.validate("NewConversationParams", newConversationParams)).toBe(true);
    expect(validator.validate("AddConversationListenerParams", addListenerParams)).toBe(true);
    expect(validator.validate("RemoveConversationListenerParams", removeListenerParams)).toBe(true);
    expect(validator.validate("SendUserTurnParams", turnParams)).toBe(true);
    expect(validator.validate("SendUserMessageParams", messageParams)).toBe(true);
  });
});
