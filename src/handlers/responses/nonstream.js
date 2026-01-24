import { postChatNonStream } from "../chat/nonstream.js";
import {
  applyDefaultProxyOutputModeHeader,
  coerceInputToChatMessages,
  convertChatResponseToResponses,
  resolveResponsesOutputMode,
} from "./shared.js";
import { config as CFG } from "../../config/index.js";
import { logResponsesIngressRaw, summarizeResponsesIngress } from "./ingress-logging.js";
import { captureResponsesNonStream } from "./capture.js";
import { logStructured, sha256 } from "../../services/logging/schema.js";
import {
  summarizeTextParts,
  summarizeToolUseItems,
} from "../../lib/observability/transform-summary.js";
import { invalidRequestBody } from "../../lib/errors.js";
import { applyProxyTraceHeaders } from "../../lib/request-context.js";
import { detectCopilotRequest as detectCopilotRequestV2 } from "../../lib/copilot-detect.js";

const MAX_RESP_CHOICES = Math.max(1, Number(CFG.PROXY_MAX_CHAT_CHOICES || 1));
const buildInvalidChoiceError = (value) =>
  invalidRequestBody(
    "n",
    `n must be an integer between 1 and ${MAX_RESP_CHOICES}; received ${value}`
  );
const normalizeChoiceCount = (raw) => {
  if (raw === undefined || raw === null) return { ok: true, value: 1 };
  if (typeof raw === "number" && Number.isInteger(raw)) {
    return { ok: true, value: raw };
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isInteger(parsed)) {
      return { ok: true, value: parsed };
    }
  }
  return { ok: false, error: buildInvalidChoiceError(raw) };
};

export async function postResponsesNonStream(req, res) {
  applyProxyTraceHeaders(res);
  const originalBody = req.body || {};
  const chatBody = { ...originalBody };
  chatBody.messages = coerceInputToChatMessages(originalBody);
  chatBody.stream = false;
  const fallbackMax = CFG.PROXY_RESPONSES_DEFAULT_MAX_TOKENS || 0;
  if (
    fallbackMax > 0 &&
    chatBody.max_tokens === undefined &&
    chatBody.max_completion_tokens === undefined &&
    chatBody.maxOutputTokens === undefined
  ) {
    chatBody.max_tokens = fallbackMax;
  }
  delete chatBody.instructions;
  delete chatBody.input;
  delete chatBody.previous_response_id;

  res.locals = res.locals || {};
  const locals = res.locals;
  locals.endpoint_mode = "responses";
  locals.routeOverride = "/v1/responses";
  locals.modeOverride = "responses_nonstream";
  const ingressSummary = summarizeResponsesIngress(originalBody, req);
  const copilotDetection = detectCopilotRequestV2({
    headers: req?.headers,
    markers: ingressSummary,
    responsesSummary: ingressSummary,
  });
  locals.copilot_detected = copilotDetection.copilot_detected;
  locals.copilot_detect_tier = copilotDetection.copilot_detect_tier;
  locals.copilot_detect_reasons = copilotDetection.copilot_detect_reasons;
  let outputModeEffective = null;
  let captureEmitted = false;
  let summaryEmitted = false;
  const transform = (payload, statusCode) => {
    if (statusCode >= 400 || payload === undefined || payload === null) {
      return payload;
    }
    const transformed = convertChatResponseToResponses(payload, originalBody);
    if (!captureEmitted) {
      captureEmitted = true;
      captureResponsesNonStream({
        req,
        res,
        requestBody: originalBody,
        responseBody: transformed,
        outputModeEffective,
      });
    }
    try {
      const prev = originalBody?.previous_response_id;
      const usage = transformed?.usage || null;
      logStructured(
        {
          component: "responses",
          event: "responses_nonstream_summary",
          level: "debug",
          req_id: locals.req_id,
          trace_id: locals.trace_id,
          route: locals.routeOverride || "/v1/responses",
          mode: locals.modeOverride || locals.mode,
          model: transformed?.model ?? null,
        },
        {
          endpoint_mode: locals.endpoint_mode || "responses",
          copilot_trace_id: locals.copilot_trace_id || null,
          status_emitted: transformed?.status ?? null,
          usage_input_tokens: usage?.input_tokens ?? null,
          usage_output_tokens: usage?.output_tokens ?? null,
          usage_total_tokens: usage?.total_tokens ?? null,
          previous_response_id_hash: prev ? sha256(prev) : null,
          output_mode_effective: locals.output_mode_effective ?? null,
          response_shape_version: "responses_v0_nonstream_openai_json",
        }
      );
    } catch {}
    if (!summaryEmitted) {
      summaryEmitted = true;
      try {
        const textParts = [];
        const outputItems = Array.isArray(transformed?.output) ? transformed.output : [];
        for (const item of outputItems) {
          if (!item || typeof item !== "object") continue;
          if (item.type === "message" && Array.isArray(item.content)) {
            for (const contentItem of item.content) {
              if (!contentItem || typeof contentItem !== "object") continue;
              if (contentItem.type === "output_text" && typeof contentItem.text === "string") {
                textParts.push(contentItem.text);
              } else if (typeof contentItem.text === "string") {
                textParts.push(contentItem.text);
              }
            }
          }
        }
        const textSummary = summarizeTextParts(textParts);
        const toolUseSummary = summarizeToolUseItems(outputItems);
        logStructured(
          {
            component: "responses",
            event: "responses_transform_summary",
            level: "info",
            req_id: locals.req_id,
            trace_id: locals.trace_id,
            route: locals.routeOverride || "/v1/responses",
            mode: locals.modeOverride || locals.mode,
            model: transformed?.model ?? null,
          },
          {
            endpoint_mode: locals.endpoint_mode || "responses",
            copilot_trace_id: locals.copilot_trace_id || null,
            output_mode_requested: locals.output_mode_requested ?? null,
            output_mode_effective: locals.output_mode_effective ?? null,
            response_shape_version: "responses_v0_nonstream_openai_json",
            status: transformed?.status ?? null,
            finish_reason: null,
            tool_calls_detected: toolUseSummary.tool_use_count,
            tool_calls_emitted: toolUseSummary.tool_use_count,
            tool_names: toolUseSummary.tool_use_names,
            tool_names_truncated: toolUseSummary.tool_use_names_truncated,
            tool_use_items: toolUseSummary.tool_use_count,
            output_text_bytes: textSummary.output_text_bytes,
            output_text_hash: textSummary.output_text_hash,
            xml_in_text: textSummary.xml_in_text,
          }
        );
      } catch {}
    }
    return transformed;
  };

  const outputModeRequested = req.headers["x-proxy-output-mode"]
    ? String(req.headers["x-proxy-output-mode"])
    : null;
  const { effective: resolvedOutputMode } = resolveResponsesOutputMode({
    req,
    defaultValue: CFG.PROXY_RESPONSES_OUTPUT_MODE,
  });
  outputModeEffective = resolvedOutputMode;
  const restoreOutputMode = applyDefaultProxyOutputModeHeader(req, outputModeEffective);
  locals.output_mode_requested = outputModeRequested;
  locals.output_mode_effective = outputModeEffective;

  logResponsesIngressRaw({
    req,
    res,
    body: originalBody,
    outputModeRequested,
    outputModeEffective,
    ingressSummary,
    copilotDetection,
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (locals.responseTransform === transform) {
      delete locals.responseTransform;
    }
    if (locals.routeOverride === "/v1/responses") delete locals.routeOverride;
    if (locals.modeOverride === "responses_nonstream") delete locals.modeOverride;
    if (typeof res.off === "function") {
      res.off("finish", cleanup);
      res.off("close", cleanup);
    } else {
      res.removeListener?.("finish", cleanup);
      res.removeListener?.("close", cleanup);
    }
  };

  locals.responseTransform = transform;
  res.once("finish", cleanup);
  res.once("close", cleanup);

  const { ok: nOk, value: nValue = 1, error: nError } = normalizeChoiceCount(originalBody?.n);
  if (!nOk || nValue < 1 || nValue > MAX_RESP_CHOICES) {
    const choiceError = nError || buildInvalidChoiceError(originalBody?.n);
    res.status(400).json(choiceError);
    cleanup();
    return;
  }

  try {
    chatBody.n = nValue;
    req.body = chatBody;
    await postChatNonStream(req, res);
  } catch (error) {
    // Align with chat handler semantics: propagate the same error status when available,
    // otherwise return a generic server_error without double-writing.
    console.error("[responses][nonstream] failed to process request", {
      message: error?.message,
      code: error?.code,
      type: error?.type,
      status: error?.status || error?.statusCode,
      stack: error?.stack,
      request_body_kind: typeof originalBody,
    });
    if (!res.headersSent) {
      const status = error?.statusCode || error?.status || 500;
      res.status(status).json({
        error: {
          message: error?.message || "Internal server error",
          type: error?.type || "server_error",
          code: error?.code || "internal_error",
        },
      });
    }
    cleanup();
  } finally {
    req.body = originalBody;
    restoreOutputMode();
  }
}
