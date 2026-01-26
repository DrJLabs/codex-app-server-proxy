import { normalizeResponseId } from "./shared.js";
import { buildResponsesEnvelope } from "./native/envelope.js";
import { createToolCallAggregator } from "../../lib/tool-call-aggregator.js";
import { createToolCallParser } from "./tool-call-parser.js";
import { recordResponsesSseEvent } from "../../services/metrics/index.js";
import { writeSseChunk } from "../../services/sse.js";
import { appendProtoEvent, LOG_PROTO } from "../../dev-logging.js";
import { ensureReqId } from "../../lib/request-context.js";
import { logStructured, sha256, shouldLogVerbose, preview } from "../../services/logging/schema.js";
import { createResponsesStreamCapture } from "./capture.js";
import {
  summarizeTextParts,
  summarizeToolCalls,
  summarizeToolUseItems,
} from "../../lib/observability/transform-summary.js";

const DEFAULT_ROLE = "assistant";
const OUTPUT_DELTA_EVENT = "response.output_text.delta";
const RESPONSES_ROUTE = "/v1/responses";
const RESPONSE_SHAPE_VERSION = "responses_v0_typed_sse_openai_json";

const mapFinishStatus = (reasons) => {
  const normalized = new Set(
    (Array.isArray(reasons) ? reasons : [reasons])
      .filter(Boolean)
      .map((reason) => String(reason).toLowerCase())
  );

  if (
    normalized.has("failed") ||
    normalized.has("error") ||
    normalized.has("cancelled") ||
    normalized.has("canceled")
  ) {
    return "failed";
  }

  if (normalized.has("length") || normalized.has("content_filter")) {
    return "incomplete";
  }

  if (normalized.size === 0) return "completed";
  return "completed";
};

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

const normalizeToolType = (value) => {
  if (typeof value === "string" && value) {
    const lower = value.toLowerCase();
    if (lower === "function") return "function_call";
    return value;
  }
  return "function_call";
};

const getDeltaBytes = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  const delta =
    typeof payload.delta === "string"
      ? payload.delta
      : typeof payload.arguments === "string"
        ? payload.arguments
        : null;
  return delta ? Buffer.byteLength(delta, "utf8") : null;
};

const asTrimmedString = (value) => (typeof value === "string" ? value.trim() : "");

const normalizeFunctionTool = (tool) => {
  if (!tool || typeof tool !== "object") return null;
  const rawType = typeof tool.type === "string" ? tool.type.trim().toLowerCase() : "";
  const fn = tool.function || tool.fn;
  const name = asTrimmedString(fn?.name) || asTrimmedString(tool?.name);
  if (rawType && rawType !== "function" && !fn && !name) return null;
  if (!name) return null;
  return {
    name,
    description: fn?.description ?? tool.description,
    parameters: fn?.parameters ?? tool.parameters,
    strict: fn?.strict ?? tool.strict,
  };
};

const normalizeToolChoice = (value) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "none" || normalized === "auto" || normalized === "required") {
      return { mode: normalized, forcedName: null };
    }
  }
  if (value && typeof value === "object") {
    const name =
      asTrimmedString(value.name) ||
      asTrimmedString(value.function?.name) ||
      asTrimmedString(value.fn?.name);
    if (name) {
      return { mode: "forced", forcedName: name };
    }
  }
  return { mode: "auto", forcedName: null };
};

const buildToolRegistry = (requestBody = {}) => {
  const rawTools = Array.isArray(requestBody?.tools) ? requestBody.tools : [];
  const functionTools = rawTools.map(normalizeFunctionTool).filter(Boolean);
  const allowedTools = new Set(functionTools.map((tool) => tool.name));
  const strictTools = new Map(functionTools.map((tool) => [tool.name, tool.strict === true]));
  const toolSchemas = new Map(functionTools.map((tool) => [tool.name, tool.parameters ?? null]));
  const toolChoice = normalizeToolChoice(requestBody?.tool_choice ?? requestBody?.toolChoice);

  if (toolChoice.mode === "none") {
    return { allowedTools: new Set(), strictTools, toolSchemas, toolChoice, enabled: false };
  }

  if (toolChoice.mode === "forced" && toolChoice.forcedName) {
    return {
      allowedTools: new Set([toolChoice.forcedName]),
      strictTools,
      toolSchemas,
      toolChoice,
      enabled: true,
    };
  }

  return {
    allowedTools,
    strictTools,
    toolSchemas,
    toolChoice,
    enabled: toolChoice.mode !== "none",
  };
};

export function createResponsesStreamAdapter(res, requestBody = {}, req = null) {
  const toolCallAggregator = createToolCallAggregator();
  const toolRegistry = buildToolRegistry(requestBody);
  const toolCallParser = toolRegistry.enabled
    ? createToolCallParser({
        allowedTools: toolRegistry.allowedTools,
        strictTools: toolRegistry.strictTools,
        toolSchemas: toolRegistry.toolSchemas,
      })
    : null;
  const choiceStates = new Map();
  const eventCounts = new Map();
  const streamCapture = createResponsesStreamCapture({
    req: req || res?.req,
    res,
    requestBody,
    outputModeEffective: res?.locals?.output_mode_effective ?? null,
  });
  const state = {
    responseId: null,
    model: requestBody?.model ?? null,
    finishReasons: new Set(),
    status: "completed",
    usage: null,
    createdEmitted: false,
    finished: false,
    eventSeq: 0,
    toolCallSeq: 0,
    outputTextHasUseTool: false,
    transformSummaryEmitted: false,
    createdAt: null,
  };

  const recordEvent = (event) => {
    eventCounts.set(event, (eventCounts.get(event) || 0) + 1);
    recordResponsesSseEvent({
      route: res.locals?.routeOverride || RESPONSES_ROUTE,
      model: state.model || requestBody?.model,
      event,
    });
  };

  const logEventSummary = (outcome, extra = {}) => {
    try {
      const events = Object.fromEntries(
        Array.from(eventCounts.entries()).sort(([a], [b]) => a.localeCompare(b))
      );
      const usage = state.usage;
      logStructured(
        {
          component: "responses",
          event: "sse_summary",
          level: outcome === "failed" ? "error" : "debug",
          req_id: res.locals?.req_id,
          trace_id: res.locals?.trace_id,
          route: res.locals?.routeOverride || RESPONSES_ROUTE,
          mode: res.locals?.modeOverride || res.locals?.mode,
          model: state.model || requestBody?.model,
          response_id: state.responseId,
          status: state.status,
        },
        {
          endpoint_mode: res.locals?.endpoint_mode || "responses",
          copilot_trace_id: res.locals?.copilot_trace_id || null,
          outcome,
          events,
          finish_reasons: Array.from(state.finishReasons),
          usage_input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? null,
          usage_output_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? null,
          usage_total_tokens: usage?.total_tokens ?? null,
          output_mode_effective: res.locals?.output_mode_effective ?? null,
          response_shape_version: RESPONSE_SHAPE_VERSION,
          ...extra,
        }
      );
    } catch {
      // logging failures are non-critical
    }
  };

  const emitTransformSummary = (outcome, responsePayload = null) => {
    if (state.transformSummaryEmitted) return;
    state.transformSummaryEmitted = true;
    try {
      const textParts = [];
      for (const choiceState of choiceStates.values()) {
        if (choiceState?.textParts?.length) {
          textParts.push(...choiceState.textParts);
        } else if (choiceState?.textDeltas?.length) {
          textParts.push(...choiceState.textDeltas);
        }
      }
      const textSummary = summarizeTextParts(textParts);
      const flattened = [];
      for (const [index] of choiceStates.entries()) {
        const snapshot = toolCallAggregator.snapshot({ choiceIndex: index });
        snapshot.forEach((record) => flattened.push(record));
      }
      const toolSummary = summarizeToolCalls(flattened);
      const toolUseSummary = responsePayload
        ? summarizeToolUseItems(responsePayload.output)
        : { tool_use_count: 0, tool_use_names: [] };
      const finishReasons = Array.from(state.finishReasons);
      logStructured(
        {
          component: "responses",
          event: "responses_transform_summary",
          level: outcome === "failed" ? "error" : "info",
          req_id: res.locals?.req_id || ensureReqId(res),
          trace_id: res.locals?.trace_id,
          route: res.locals?.routeOverride || RESPONSES_ROUTE,
          mode: res.locals?.modeOverride || res.locals?.mode || "responses_stream",
          model: state.model || requestBody?.model,
        },
        {
          endpoint_mode: res.locals?.endpoint_mode || "responses",
          copilot_trace_id: res.locals?.copilot_trace_id || null,
          output_mode_requested: res.locals?.output_mode_requested ?? null,
          output_mode_effective: res.locals?.output_mode_effective ?? null,
          response_shape_version: RESPONSE_SHAPE_VERSION,
          status: responsePayload?.status || state.status || null,
          finish_reason: finishReasons[0] || null,
          tool_calls_detected: toolSummary.tool_call_count,
          tool_calls_emitted: toolSummary.tool_call_count,
          tool_names: toolSummary.tool_names,
          tool_names_truncated: toolSummary.tool_names_truncated,
          tool_use_items: toolUseSummary.tool_use_count,
          tool_use_names: toolUseSummary.tool_use_names,
          output_text_bytes: textSummary.output_text_bytes,
          output_text_hash: textSummary.output_text_hash,
          xml_in_text: state.outputTextHasUseTool || textSummary.xml_in_text,
        }
      );
    } catch {}
  };

  let writeChain = Promise.resolve();
  let endScheduled = false;
  const writeEventInternal = async (event, payload) => {
    if (res.writableEnded) return;
    try {
      state.eventSeq += 1;
      const sequenceNumber = state.eventSeq;
      const enrichedPayload =
        event === "done" && payload === "[DONE]"
          ? payload
          : payload && typeof payload === "object"
            ? { ...payload, sequence_number: sequenceNumber }
            : payload;
      if (streamCapture) streamCapture.record(event, enrichedPayload);
      const data =
        event === "done" && payload === "[DONE]" ? "[DONE]" : JSON.stringify(enrichedPayload);
      if (LOG_PROTO) {
        const reqId = ensureReqId(res);
        const deltaBytes = getDeltaBytes(enrichedPayload);
        const verbose = shouldLogVerbose();

        const debugExtras = {};
        if (verbose && event === OUTPUT_DELTA_EVENT && typeof enrichedPayload?.delta === "string") {
          const sample = preview(enrichedPayload.delta, 160);
          debugExtras.delta_preview = sample.preview;
          debugExtras.content_truncated = sample.truncated;
          debugExtras.content_preview_len = sample.preview.length;
        }

        appendProtoEvent({
          phase: "responses_sse_out",
          req_id: reqId,
          route: res.locals?.routeOverride || RESPONSES_ROUTE,
          mode: res.locals?.modeOverride || res.locals?.mode || "responses_stream",
          endpoint_mode: res.locals?.endpoint_mode || "responses",
          copilot_trace_id: res.locals?.copilot_trace_id || null,
          trace_id: res.locals?.trace_id || null,
          stream: true,
          stream_protocol: "sse",
          stream_event_seq: state.eventSeq,
          stream_event_type: event,
          delta_bytes: deltaBytes,
          event_bytes: Buffer.byteLength(data, "utf8"),
          response_shape_version: RESPONSE_SHAPE_VERSION,
          ...debugExtras,
        });
      }
      await writeSseChunk(res, `event: ${event}\ndata: ${data}\n\n`);
      recordEvent(event);
    } catch (error) {
      console.error("[proxy][responses.stream-adapter] failed to write SSE event", error);
    }
  };
  const writeEvent = (event, payload) => {
    writeChain = writeChain.then(() => writeEventInternal(event, payload));
    return writeChain;
  };
  const scheduleEnd = () => {
    if (endScheduled) return writeChain;
    endScheduled = true;
    writeChain = writeChain.then(() => {
      res.end?.();
      return null;
    });
    return writeChain;
  };

  const ensureCreated = () => {
    if (state.createdEmitted) return;
    if (!state.responseId) {
      state.responseId = normalizeResponseId(requestBody?.id);
    }
    if (!state.createdAt) {
      state.createdAt = Math.floor(Date.now() / 1000);
    }
    state.createdEmitted = true;
    writeEvent("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        status: "in_progress",
      },
    });
  };

  const ensureChoiceState = (index) => {
    if (!choiceStates.has(index)) {
      choiceStates.set(index, {
        index,
        role: DEFAULT_ROLE,
        textParts: [],
        textDeltas: [],
        hasDelta: false,
        toolCalls: new Map(),
        toolCallOrdinals: new Map(),
      });
    }
    return choiceStates.get(index);
  };

  const ensureToolCallTracking = (choiceState) => {
    if (!choiceState.toolCalls) {
      choiceState.toolCalls = new Map();
    }
    if (!choiceState.toolCallOrdinals) {
      choiceState.toolCallOrdinals = new Map();
    }
    return {
      toolCalls: choiceState.toolCalls,
      ordinals: choiceState.toolCallOrdinals,
    };
  };

  const resolveToolCallState = (choiceState, index, { id, ordinal, fallbackId, type, name }) => {
    const { toolCalls, ordinals } = ensureToolCallTracking(choiceState);

    let existing = null;
    if (id && toolCalls.has(id)) {
      existing = toolCalls.get(id);
    }

    if (!existing && Number.isInteger(ordinal)) {
      const priorId = ordinals.get(ordinal);
      if (priorId && toolCalls.has(priorId)) {
        existing = toolCalls.get(priorId);
      }
    }

    if (!existing && fallbackId && toolCalls.has(fallbackId)) {
      existing = toolCalls.get(fallbackId);
    }

    if (!existing) {
      const resolvedOrdinal = Number.isInteger(ordinal) ? ordinal : toolCalls.size;
      existing = {
        id: fallbackId || id || `tool_${index}_${resolvedOrdinal}`,
        ordinal: resolvedOrdinal,
        type: normalizeToolType(type),
        name: name || fallbackId || id || `tool_${index}_${resolvedOrdinal}`,
        lastArgs: "",
        added: false,
        doneArguments: false,
        outputDone: false,
      };
    }

    if (Number.isInteger(ordinal) && existing.ordinal !== ordinal) {
      existing.ordinal = ordinal;
    }

    const resolvedId = id || existing.id;
    if (resolvedId !== existing.id) {
      toolCalls.delete(existing.id);
      existing.id = resolvedId;
    }

    if (type) existing.type = normalizeToolType(type);
    if (name) existing.name = name;

    toolCalls.set(existing.id, existing);
    if (Number.isInteger(existing.ordinal)) {
      ordinals.set(existing.ordinal, existing.id);
    }

    return existing;
  };

  const emitToolCallDeltas = (choiceState, index, deltas = []) => {
    if (!choiceState || !Array.isArray(deltas) || deltas.length === 0) return;
    const responseId = state.responseId;
    const { toolCalls } = ensureToolCallTracking(choiceState);
    deltas.forEach((toolDelta) => {
      if (!toolDelta) return;
      const ordinal = Number.isInteger(toolDelta.index) ? toolDelta.index : null;
      const fallbackOrdinal = ordinal ?? toolCalls.size;
      const fallbackId = toolDelta.id || `tool_${index}_${fallbackOrdinal}`;
      const existing = resolveToolCallState(choiceState, index, {
        id: toolDelta.id,
        ordinal,
        fallbackId,
        type: toolDelta.type,
        name: toolDelta.function?.name,
      });

      if (!existing.added) {
        writeEvent("response.output_item.added", {
          type: "response.output_item.added",
          response_id: responseId,
          output_index: index,
          item: {
            id: existing.id,
            call_id: existing.id,
            type: existing.type,
            name: existing.name,
            status: "in_progress",
          },
        });
        existing.added = true;
      }

      if (typeof toolDelta.function?.arguments === "string") {
        const incoming = toolDelta.function.arguments;
        const previous = existing.lastArgs || "";
        const chunk =
          incoming.length >= previous.length ? incoming.slice(previous.length) : incoming;
        if (chunk) {
          writeEvent("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            response_id: responseId,
            output_index: index,
            item_id: existing.id,
            delta: chunk,
          });
          existing.lastArgs = incoming;
        }
      }
    });
  };

  const finalizeToolCalls = (choiceState, index, snapshot = []) => {
    if (!choiceState || !Array.isArray(snapshot) || snapshot.length === 0) return;
    const responseId = state.responseId;
    snapshot.forEach((call, ordinal) => {
      if (!call) return;
      const fallbackId = call.id || `tool_${index}_${ordinal}`;
      const existing = resolveToolCallState(choiceState, index, {
        id: call.id,
        ordinal,
        fallbackId,
        type: call.type,
        name: call.function?.name,
      });

      if (!existing.added) {
        writeEvent("response.output_item.added", {
          type: "response.output_item.added",
          response_id: responseId,
          output_index: index,
          item: {
            id: existing.id,
            call_id: existing.id,
            type: existing.type,
            name: existing.name,
            status: "in_progress",
          },
        });
        existing.added = true;
      }

      const argumentsText = call.function?.arguments ?? "";
      if (argumentsText && argumentsText !== existing.lastArgs) {
        const previous = existing.lastArgs || "";
        const chunk = argumentsText.slice(previous.length);
        if (chunk) {
          writeEvent("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            response_id: responseId,
            output_index: index,
            item_id: existing.id,
            delta: chunk,
          });
        }
        existing.lastArgs = argumentsText;
      }

      if (!existing.doneArguments) {
        const args = argumentsText || "";
        const argsBytes = Buffer.byteLength(args, "utf8");
        let jsonValid = false;
        let parsedArgs = null;
        try {
          parsedArgs = args ? JSON.parse(args) : null;
          jsonValid = Boolean(parsedArgs) && typeof parsedArgs === "object";
        } catch {
          parsedArgs = null;
          jsonValid = false;
        }

        try {
          const toolArgsKeys =
            parsedArgs && typeof parsedArgs === "object" ? Object.keys(parsedArgs) : [];
          const queryValue =
            parsedArgs &&
            typeof parsedArgs === "object" &&
            typeof parsedArgs.query === "string" &&
            parsedArgs.query.trim()
              ? parsedArgs.query
              : null;
          const chatHistoryValue =
            parsedArgs && typeof parsedArgs === "object" && Array.isArray(parsedArgs.chatHistory)
              ? parsedArgs.chatHistory
              : null;
          logStructured(
            {
              component: "responses",
              event: "tool_call_arguments_done",
              level: "debug",
              req_id: res.locals?.req_id || ensureReqId(res),
              trace_id: res.locals?.trace_id,
              route: res.locals?.routeOverride || RESPONSES_ROUTE,
              mode: res.locals?.modeOverride || res.locals?.mode || "responses_stream",
              model: state.model || requestBody?.model,
              response_id: state.responseId,
            },
            {
              endpoint_mode: res.locals?.endpoint_mode || "responses",
              copilot_trace_id: res.locals?.copilot_trace_id || null,
              tool_call_id: existing.id,
              tool_name: existing.name,
              tool_args_bytes: argsBytes,
              tool_args_json_valid: jsonValid,
              tool_args_hash: args ? sha256(args) : null,
              tool_args_key_count: toolArgsKeys.length,
              tool_args_keys: toolArgsKeys.slice(0, 20).sort(),
              tool_args_keys_truncated: toolArgsKeys.length > 20,
              tool_args_query_len: queryValue ? queryValue.length : null,
              tool_args_query_hash: queryValue ? sha256(queryValue) : null,
              tool_args_chat_history_len: chatHistoryValue ? chatHistoryValue.length : null,
              response_shape_version: RESPONSE_SHAPE_VERSION,
            }
          );
        } catch {}

        if (LOG_PROTO) {
          const debugExtras = {};
          if (shouldLogVerbose() && args && !jsonValid) {
            const sample = preview(args, 160);
            debugExtras.args_preview = sample.preview;
            debugExtras.content_truncated = sample.truncated;
            debugExtras.content_preview_len = sample.preview.length;
          }

          appendProtoEvent({
            phase: "tool_call_arguments_done",
            endpoint_mode: res.locals?.endpoint_mode || "responses",
            req_id: res.locals?.req_id || ensureReqId(res),
            trace_id: res.locals?.trace_id,
            route: res.locals?.routeOverride || RESPONSES_ROUTE,
            mode: res.locals?.modeOverride || res.locals?.mode || "responses_stream",
            response_id: state.responseId,
            tool_call_id: existing.id,
            tool_name: existing.name,
            tool_args_bytes: argsBytes,
            tool_args_json_valid: jsonValid,
            tool_args_hash: args ? sha256(args) : null,
            response_shape_version: RESPONSE_SHAPE_VERSION,
            ...debugExtras,
          });
        }

        writeEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          response_id: responseId,
          output_index: index,
          item_id: existing.id,
          arguments: args,
        });
        existing.doneArguments = true;
      }

      if (!existing.outputDone) {
        writeEvent("response.output_item.done", {
          type: "response.output_item.done",
          response_id: responseId,
          output_index: index,
          item: {
            id: existing.id,
            call_id: existing.id,
            type: existing.type,
            name: existing.name,
            arguments: existing.lastArgs || "",
            status: "completed",
          },
        });
        existing.outputDone = true;
      }
    });
  };

  const emitFailure = (error) => {
    if (res.writableEnded) return false;
    if (state.finished) return false;
    state.finished = true;
    ensureCreated();
    const message = error?.message || "stream adapter error";
    writeEvent("response.failed", {
      type: "response.failed",
      response: {
        id: state.responseId,
        status: "failed",
      },
      error: {
        message,
        code: "stream_adapter_error",
      },
    });
    writeEvent("done", "[DONE]");
    if (streamCapture) streamCapture.finalize("failed");
    emitTransformSummary("failed");
    logEventSummary("failed", { message });
    scheduleEnd();
    return false;
  };

  const nextToolCallId = () => {
    state.toolCallSeq += 1;
    return `fc_${String(state.toolCallSeq).padStart(3, "0")}`;
  };

  const emitTextDelta = (choiceState, choiceIndex, text) => {
    if (!isNonEmptyString(text)) return;
    if (!state.outputTextHasUseTool && text.toLowerCase().includes("<use_tool")) {
      state.outputTextHasUseTool = true;
    }
    choiceState.textDeltas.push(text);
    choiceState.hasDelta = true;
    ensureCreated();
    writeEvent(OUTPUT_DELTA_EVENT, {
      type: OUTPUT_DELTA_EVENT,
      delta: text,
      output_index: choiceIndex,
    });
  };

  const emitTextPart = (choiceState, choiceIndex, text) => {
    if (!isNonEmptyString(text)) return;
    choiceState.textParts.push(text);
    if (!choiceState.hasDelta) {
      emitTextDelta(choiceState, choiceIndex, text);
    }
  };

  const emitToolCallComplete = (choiceState, choiceIndex, toolCall) => {
    if (!toolCall || typeof toolCall !== "object") return;
    const { toolCalls } = ensureToolCallTracking(choiceState);
    const name = toolCall.function?.name || toolCall.name || toolCall.id || "tool";
    const fallbackId = toolCall.id || `tool_${choiceIndex}_${toolCalls.size}`;
    const existing = resolveToolCallState(choiceState, choiceIndex, {
      id: toolCall.id,
      ordinal: toolCalls.size,
      fallbackId,
      type: toolCall.type || "function",
      name,
    });

    if (!existing.added) {
      writeEvent("response.output_item.added", {
        type: "response.output_item.added",
        response_id: state.responseId,
        output_index: choiceIndex,
        item: {
          id: existing.id,
          call_id: existing.id,
          type: existing.type,
          name: existing.name,
          status: "in_progress",
        },
      });
      existing.added = true;
    }

    const argumentsText = toolCall.function?.arguments ?? toolCall.arguments ?? "";
    if (argumentsText && argumentsText !== existing.lastArgs) {
      writeEvent("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        response_id: state.responseId,
        output_index: choiceIndex,
        item_id: existing.id,
        delta: argumentsText,
      });
      existing.lastArgs = argumentsText;
    }

    if (!existing.doneArguments) {
      writeEvent("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        response_id: state.responseId,
        output_index: choiceIndex,
        item_id: existing.id,
        arguments: argumentsText,
      });
      existing.doneArguments = true;
    }

    if (!existing.outputDone) {
      writeEvent("response.output_item.done", {
        type: "response.output_item.done",
        response_id: state.responseId,
        output_index: choiceIndex,
        item: {
          id: existing.id,
          call_id: existing.id,
          type: existing.type,
          name: existing.name,
          arguments: existing.lastArgs || "",
          status: "completed",
        },
      });
      existing.outputDone = true;
    }
  };

  const handleParsedToolCalls = (choiceState, choiceIndex, parsedCalls = []) => {
    if (!choiceState || !Array.isArray(parsedCalls) || parsedCalls.length === 0) return;
    parsedCalls.forEach((call) => {
      if (!call || typeof call !== "object") return;
      const id = nextToolCallId();
      const toolCall = {
        id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      };
      toolCallAggregator.ingestMessage({ tool_calls: [toolCall] }, { choiceIndex });
      ensureCreated();
      emitToolCallComplete(choiceState, choiceIndex, toolCall);
    });
  };

  const shouldFailParserErrors = (errors = []) => errors.some((err) => err?.strict === true);

  const handleEvent = (event) => {
    try {
      if (!event || typeof event !== "object") return true;
      const choiceIndex = Number.isInteger(event.choiceIndex) ? event.choiceIndex : 0;
      if (event.type === "text_delta") {
        const choiceState = ensureChoiceState(choiceIndex);
        if (!isNonEmptyString(event.delta)) return true;
        if (toolCallParser) {
          const parsed = toolCallParser.ingest(event.delta);
          if (parsed.errors?.length && shouldFailParserErrors(parsed.errors)) {
            return emitFailure(new Error("strict tool_call parse failure"));
          }
          parsed.visibleTextDeltas.forEach((chunk) =>
            emitTextDelta(choiceState, choiceIndex, chunk)
          );
          handleParsedToolCalls(choiceState, choiceIndex, parsed.parsedToolCalls);
          return true;
        }
        emitTextDelta(choiceState, choiceIndex, event.delta);
        return true;
      }
      if (event.type === "text") {
        const choiceState = ensureChoiceState(choiceIndex);
        if (!isNonEmptyString(event.text)) return true;
        if (toolCallParser) {
          const parsed = toolCallParser.ingest(event.text);
          if (parsed.errors?.length && shouldFailParserErrors(parsed.errors)) {
            return emitFailure(new Error("strict tool_call parse failure"));
          }
          parsed.visibleTextDeltas.forEach((chunk) =>
            emitTextPart(choiceState, choiceIndex, chunk)
          );
          handleParsedToolCalls(choiceState, choiceIndex, parsed.parsedToolCalls);
          return true;
        }
        emitTextPart(choiceState, choiceIndex, event.text);
        return true;
      }
      if (event.type === "tool_calls_delta") {
        if (Array.isArray(event.tool_calls)) {
          const choiceState = ensureChoiceState(choiceIndex);
          const result = toolCallAggregator.ingestDelta(
            { tool_calls: event.tool_calls },
            { choiceIndex }
          );
          if (result?.updated) {
            ensureCreated();
            emitToolCallDeltas(choiceState, choiceIndex, result?.deltas);
          }
        }
        return true;
      }
      if (event.type === "tool_calls") {
        if (Array.isArray(event.tool_calls)) {
          const choiceState = ensureChoiceState(choiceIndex);
          const result = toolCallAggregator.ingestMessage(
            { tool_calls: event.tool_calls },
            { choiceIndex, emitIfMissing: true }
          );
          if (result?.updated) {
            ensureCreated();
            emitToolCallDeltas(choiceState, choiceIndex, result?.deltas);
          }
        }
        return true;
      }
      if (event.type === "function_call_delta") {
        if (event.function_call && typeof event.function_call === "object") {
          const choiceState = ensureChoiceState(choiceIndex);
          const result = toolCallAggregator.ingestDelta(
            { function_call: event.function_call },
            { choiceIndex }
          );
          if (result?.updated) {
            ensureCreated();
            emitToolCallDeltas(choiceState, choiceIndex, result?.deltas);
          }
        }
        return true;
      }
      if (event.type === "function_call") {
        if (event.function_call && typeof event.function_call === "object") {
          const choiceState = ensureChoiceState(choiceIndex);
          const result = toolCallAggregator.ingestMessage(
            { function_call: event.function_call },
            { choiceIndex, emitIfMissing: true }
          );
          if (result?.updated) {
            ensureCreated();
            emitToolCallDeltas(choiceState, choiceIndex, result?.deltas);
          }
        }
        return true;
      }
      if (event.type === "usage" && event.usage && typeof event.usage === "object") {
        state.usage = event.usage;
        return true;
      }
      if (event.type === "finish") {
        if (event.reason) state.finishReasons.add(event.reason);
        state.status = mapFinishStatus(Array.from(state.finishReasons));
        return true;
      }
      return true;
    } catch (error) {
      console.error("[proxy][responses.stream-adapter] handleEvent error", error);
      return emitFailure(error);
    }
  };

  const finalize = async () => {
    try {
      if (state.finished) return true;
      state.finished = true;
      ensureCreated();

      const indices = Array.from(choiceStates.keys()).sort((a, b) => a - b);
      if (indices.length === 0) {
        indices.push(0);
        choiceStates.set(0, {
          index: 0,
          role: DEFAULT_ROLE,
          textParts: [],
          textDeltas: [],
          hasDelta: false,
          toolCalls: new Map(),
          toolCallOrdinals: new Map(),
        });
      }

      const choiceState = choiceStates.get(0);
      if (toolCallParser && choiceState) {
        const parsed = toolCallParser.flush();
        if (parsed.errors?.length && shouldFailParserErrors(parsed.errors)) {
          return emitFailure(new Error("strict tool_call parse failure"));
        }
        parsed.visibleTextDeltas.forEach((chunk) => emitTextPart(choiceState, 0, chunk));
        handleParsedToolCalls(choiceState, 0, parsed.parsedToolCalls);
      }

      writeEvent("response.output_text.done", { type: "response.output_text.done" });
      const outputText =
        choiceState && choiceState.textParts.length
          ? choiceState.textParts.join("")
          : (choiceState?.textDeltas?.join("") ?? "");
      const functionCalls = toolCallAggregator.snapshot({ choiceIndex: 0 });

      if (choiceState) {
        finalizeToolCalls(choiceState, 0, functionCalls);
      }

      const responsePayload = buildResponsesEnvelope({
        responseId: state.responseId || requestBody?.id,
        created: state.createdAt,
        model: state.model || requestBody?.model,
        outputText,
        functionCalls,
        usage: state.usage || undefined,
        status: state.status || "completed",
      });

      emitTransformSummary("completed", responsePayload);
      writeEvent("response.completed", {
        type: "response.completed",
        response: responsePayload,
      });
      writeEvent("done", "[DONE]");
      if (streamCapture) streamCapture.finalize("completed");
      logEventSummary("completed", { finish_reasons: Array.from(state.finishReasons) });
      await scheduleEnd();
      return true;
    } catch (error) {
      console.error("[proxy][responses.stream-adapter] finalize error", error);
      return emitFailure(error);
    }
  };

  return {
    handleEvent,
    finalize,
    fail: (error) => emitFailure(error),
    toolCallAggregator,
  };
}
