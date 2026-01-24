import { config as CFG } from "../../config/index.js";
import { runCodexExec } from "../../services/codex-exec.js";
import { applyProxyTraceHeaders } from "../../lib/request-context.js";
import { serverErrorBody } from "../../lib/errors.js";
import { detectCopilotRequest as detectCopilotRequestV2 } from "../../lib/copilot-detect.js";
import {
  collectPromptText,
  isTitleOnlyPrompt,
  isTitleSummaryPrompt,
} from "../../lib/title-prompt-utils.js";
import { logStructured, sha256 } from "../../services/logging/schema.js";
import { recordResponsesSseEvent } from "../../services/metrics/index.js";
import { setSSEHeaders, writeSseChunk } from "../../services/sse.js";
import { captureResponsesNonStream, createResponsesStreamCapture } from "./capture.js";
import { logResponsesIngressRaw, summarizeResponsesIngress } from "./ingress-logging.js";
import { normalizeMessageId, normalizeResponseId, resolveResponsesOutputMode } from "./shared.js";

const TITLE_INTERCEPT_ENABLED = CFG.PROXY_TITLE_GEN_INTERCEPT;
const DEFAULT_MODEL = CFG.PROXY_TITLE_SUMMARY_EXEC_MODEL;

const buildResponsesEnvelope = ({ text, model, requestBody, responseId, messageId }) => {
  const resolvedResponseId = responseId || normalizeResponseId();
  const resolvedMessageId = messageId || normalizeMessageId();
  const output = [
    {
      id: resolvedMessageId,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ];
  const payload = {
    id: resolvedResponseId,
    status: "completed",
    model,
    output,
  };
  if (requestBody?.previous_response_id) {
    payload.previous_response_id = requestBody.previous_response_id;
  }
  return payload;
};

export async function maybeHandleTitleSummaryIntercept({ req, res, body = {}, stream } = {}) {
  if (!TITLE_INTERCEPT_ENABLED) return false;
  if (!req || !res) return false;

  const promptText = collectPromptText(body);
  const isSummary = isTitleSummaryPrompt(promptText);
  const isTitle = !isSummary && isTitleOnlyPrompt(promptText);
  if (!isSummary && !isTitle) return false;

  applyProxyTraceHeaders(res);
  res.locals = res.locals || {};
  const locals = res.locals;
  locals.endpoint_mode = "responses";
  locals.routeOverride = "/v1/responses";
  locals.modeOverride = "responses_intercept";

  const ingressSummary = summarizeResponsesIngress(body, req);
  const copilotDetection = detectCopilotRequestV2({
    headers: req?.headers,
    markers: ingressSummary,
    responsesSummary: ingressSummary,
  });
  locals.copilot_detected = copilotDetection.copilot_detected;
  locals.copilot_detect_tier = copilotDetection.copilot_detect_tier;
  locals.copilot_detect_reasons = copilotDetection.copilot_detect_reasons;

  const outputModeRequested = req.headers["x-proxy-output-mode"]
    ? String(req.headers["x-proxy-output-mode"])
    : null;
  const { effective: outputModeEffective } = resolveResponsesOutputMode({
    req,
    defaultValue: CFG.PROXY_RESPONSES_OUTPUT_MODE,
  });
  locals.output_mode_requested = outputModeRequested;
  locals.output_mode_effective = outputModeEffective;

  logResponsesIngressRaw({
    req,
    res,
    body,
    outputModeRequested,
    outputModeEffective,
    ingressSummary,
    copilotDetection,
  });

  const execModel = DEFAULT_MODEL;
  try {
    const outputText = await runCodexExec({
      prompt: promptText,
      model: execModel,
      reqId: locals.req_id,
      route: locals.routeOverride,
      mode: locals.modeOverride,
    });

    const responseBody = buildResponsesEnvelope({
      text: outputText,
      model: execModel,
      requestBody: body,
    });

    logStructured(
      {
        component: "responses",
        event: "responses_title_summary_intercept",
        level: "info",
        req_id: locals.req_id,
        trace_id: locals.trace_id,
        route: locals.routeOverride,
        mode: locals.modeOverride,
        model: execModel,
      },
      {
        kind: isSummary ? "title_summary" : "title",
        copilot_trace_id: locals.copilot_trace_id || null,
        output_text_bytes: Buffer.byteLength(outputText, "utf8"),
        output_text_hash: sha256(outputText),
        output_mode_effective: outputModeEffective,
        stream: Boolean(stream),
      }
    );

    if (stream) {
      res.status(200);
      setSSEHeaders(res);
      const streamCapture = createResponsesStreamCapture({
        req,
        res,
        requestBody: body,
        outputModeEffective,
      });
      const writeEvent = async (event, payload) => {
        if (streamCapture) streamCapture.record(event, payload);
        recordResponsesSseEvent({
          route: locals.routeOverride,
          model: execModel,
          event,
        });
        const data = event === "done" && payload === "[DONE]" ? "[DONE]" : JSON.stringify(payload);
        await writeSseChunk(res, `event: ${event}\ndata: ${data}\n\n`);
      };

      await writeEvent("response.created", {
        type: "response.created",
        response: { id: responseBody.id, status: "in_progress" },
      });
      if (outputText) {
        await writeEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          delta: outputText,
          output_index: 0,
        });
      }
      await writeEvent("response.output_text.done", { type: "response.output_text.done" });
      await writeEvent("response.completed", {
        type: "response.completed",
        response: responseBody,
      });
      await writeEvent("done", "[DONE]");
      if (streamCapture) streamCapture.finalize("completed");
      res.end();
      return true;
    }

    captureResponsesNonStream({
      req,
      res,
      requestBody: body,
      responseBody,
      outputModeEffective,
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(responseBody);
    return true;
  } catch (err) {
    logStructured(
      {
        component: "responses",
        event: "responses_title_summary_intercept_error",
        level: "error",
        req_id: locals.req_id,
        trace_id: locals.trace_id,
        route: locals.routeOverride,
        mode: locals.modeOverride,
        model: execModel,
      },
      {
        kind: isSummary ? "title_summary" : "title",
        message: err?.message || String(err || "exec failed"),
      }
    );

    if (stream) {
      res.status(200);
      setSSEHeaders(res);
      const streamCapture = createResponsesStreamCapture({
        req,
        res,
        requestBody: body,
        outputModeEffective,
      });
      const responseId = normalizeResponseId();
      const createdPayload = {
        type: "response.created",
        response: { id: responseId, status: "in_progress" },
      };
      await writeSseChunk(
        res,
        `event: response.created\ndata: ${JSON.stringify(createdPayload)}\n\n`
      );
      recordResponsesSseEvent({
        route: locals.routeOverride,
        model: execModel,
        event: "response.created",
      });
      if (streamCapture) streamCapture.record("response.created", createdPayload);
      const failurePayload = {
        type: "response.failed",
        response: { id: responseId, status: "failed" },
        error: {
          message: err?.message || "exec failed",
          code: "title_summary_intercept_failed",
        },
      };
      await writeSseChunk(
        res,
        `event: response.failed\ndata: ${JSON.stringify(failurePayload)}\n\n`
      );
      recordResponsesSseEvent({
        route: locals.routeOverride,
        model: execModel,
        event: "response.failed",
      });
      if (streamCapture) streamCapture.record("response.failed", failurePayload);
      await writeSseChunk(res, "event: done\ndata: [DONE]\n\n");
      recordResponsesSseEvent({
        route: locals.routeOverride,
        model: execModel,
        event: "done",
      });
      if (streamCapture) {
        streamCapture.record("done", "[DONE]");
        streamCapture.finalize("failed");
      }
      res.end();
      return true;
    }

    res.status(502).json(serverErrorBody("title/summary exec failed"));
    return true;
  }
}
