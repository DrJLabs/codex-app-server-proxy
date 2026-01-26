import { describe, test, expect, vi, beforeEach } from "vitest";
import { maybeHandleTitleSummaryIntercept } from "../../../../src/handlers/responses/title-summary-intercept.js";
import { runCodexExec } from "../../../../src/services/codex-exec.js";
import {
  logResponsesIngressRaw,
  summarizeResponsesIngress,
} from "../../../../src/handlers/responses/ingress-logging.js";
import {
  captureResponsesNonStream,
  createResponsesStreamCapture,
} from "../../../../src/handlers/responses/capture.js";
import { parseSSE } from "../../../shared/transcript-utils.js";

vi.mock("../../../../src/services/codex-exec.js", () => ({
  runCodexExec: vi.fn(),
}));
vi.mock("../../../../src/handlers/responses/ingress-logging.js", () => ({
  logResponsesIngressRaw: vi.fn(),
  summarizeResponsesIngress: vi.fn(),
  summarizeTools: vi.fn(() => ({
    tool_count: 0,
    tool_types: [],
    tool_types_truncated: false,
    tool_names: [],
    tool_names_truncated: false,
    tool_function_name_present_count: 0,
    tool_function_name_missing_count: 0,
  })),
}));
vi.mock("../../../../src/handlers/responses/capture.js", () => ({
  captureResponsesNonStream: vi.fn(),
  createResponsesStreamCapture: vi.fn(),
}));

const createRes = () => {
  const res = {
    locals: {},
    headers: {},
    chunks: [],
    statusCode: null,
    payload: null,
    writableEnded: false,
    setHeader(key, value) {
      // eslint-disable-next-line security/detect-object-injection -- test helper for headers
      this.headers[key] = value;
    },
    flushHeaders: vi.fn(),
    flush: vi.fn(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    write(chunk) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  createResponsesStreamCapture.mockReturnValue({
    record: vi.fn(),
    finalize: vi.fn(),
  });
  summarizeResponsesIngress.mockReturnValue({
    has_input: true,
    input_is_array: true,
    input_item_types: ["message"],
    input_message_count: 1,
    input_message_roles: ["user"],
    has_metadata: false,
    has_tools: false,
    has_tool_choice: false,
  });
  runCodexExec.mockResolvedValue('{"title":"Hello","summary":"World"}');
});

describe("responses title/summary intercept", () => {
  test("intercepts title+summary prompt and returns responses envelope", async () => {
    const req = { headers: {} };
    const res = createRes();
    const body = {
      input: [
        {
          type: "message",
          role: "developer",
          content:
            'Your task is to analyze a conversation and generate both a title and a summary.\n\n# OUTPUT FORMAT\nYou must return your response in the following JSON format:\n{\n  "title": "Brief 2-8 word title capturing the main user intent",\n  "summary": "2-3 sentence summary at most including key details (e.g. user facts mentioned entities), and key conclusions if there are any."\n}\n\n# RULES\n* Use the same language as the conversation',
        },
        {
          type: "message",
          role: "user",
          content: "Conversation:\nuser: hello\nai: hi",
        },
      ],
    };

    const handled = await maybeHandleTitleSummaryIntercept({
      req,
      res,
      body,
      stream: false,
    });

    expect(handled).toBe(true);
    expect(logResponsesIngressRaw).toHaveBeenCalled();
    expect(captureResponsesNonStream).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.payload.status).toBe("completed");
    expect(res.payload.model).toBe("gpt-5.2");
    expect(res.payload.output[0].content[0].text).toContain('"title"');
  });

  test("intercepts title-only prompt and returns responses envelope", async () => {
    const req = { headers: {} };
    const res = createRes();
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content:
            "Generate a concise title (max 5 words) for this conversation based on its content. Return only the title without any explanation or quotes.\n\nConversation:\nuser: hello\nai: hi",
        },
      ],
    };

    runCodexExec.mockResolvedValue("Hello conversation");

    const handled = await maybeHandleTitleSummaryIntercept({
      req,
      res,
      body,
      stream: false,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.payload.output[0].content[0].text).toBe("Hello conversation");
  });

  test("streams SSE when stream=true", async () => {
    const req = { headers: {} };
    const res = createRes();
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content:
            "Generate a concise title (max 5 words) for this conversation based on its content. Return only the title without any explanation or quotes.\n\nConversation:\nuser: hello\nai: hi",
        },
      ],
    };

    runCodexExec.mockResolvedValue("Hello conversation");

    const handled = await maybeHandleTitleSummaryIntercept({
      req,
      res,
      body,
      stream: true,
    });

    expect(handled).toBe(true);
    expect(captureResponsesNonStream).not.toHaveBeenCalled();
    expect(createResponsesStreamCapture).toHaveBeenCalled();
    const entries = parseSSE(res.chunks.join(""));
    const completed = entries.find((entry) => entry.event === "response.completed");
    expect(completed?.data?.response?.output?.[0]?.content?.[0]?.text).toBe("Hello conversation");
    const deltas = entries.filter((entry) => entry.event === "response.output_text.delta");
    const combined = deltas
      .map((entry) => (typeof entry.data?.delta === "string" ? entry.data.delta : ""))
      .join("");
    expect(combined).toBe("Hello conversation");
    expect(entries.some((entry) => entry.event === "done")).toBe(true);
  });

  test("streams created before failed on exec error", async () => {
    const req = { headers: {} };
    const res = createRes();
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content:
            "Generate a concise title (max 5 words) for this conversation based on its content. Return only the title without any explanation or quotes.\n\nConversation:\nuser: hello\nai: hi",
        },
      ],
    };

    runCodexExec.mockRejectedValue(new Error("codex exec timed out"));

    const handled = await maybeHandleTitleSummaryIntercept({
      req,
      res,
      body,
      stream: true,
    });

    expect(handled).toBe(true);
    const entries = parseSSE(res.chunks.join(""));
    expect(entries[0]?.event).toBe("response.created");
    expect(entries[1]?.event).toBe("response.failed");
    expect(entries[2]?.event).toBe("done");
    expect(entries[1]?.data?.response?.id).toBe(entries[0]?.data?.response?.id);
  });

  test("returns 502 when codex exec fails", async () => {
    const req = { headers: {} };
    const res = createRes();
    const body = {
      input: [
        {
          type: "message",
          role: "user",
          content:
            "Generate a concise title (max 5 words) for this conversation based on its content. Return only the title without any explanation or quotes.\n\nConversation:\nuser: hello\nai: hi",
        },
      ],
    };

    runCodexExec.mockRejectedValue(new Error("codex exec timed out"));

    const handled = await maybeHandleTitleSummaryIntercept({
      req,
      res,
      body,
      stream: false,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(502);
    expect(res.payload?.error).toBeDefined();
  });
});
