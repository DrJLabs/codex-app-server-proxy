# Chat Stream Modularization Follow-up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep `src/handlers/chat/stream.js` as a thin orchestrator by extracting metadata sanitization, usage tracking, and non-message event routing into focused helpers without changing behavior.

**Architecture:** Add three small factory modules in `src/handlers/chat/` that encapsulate stream metadata sanitization, usage tracking, and event routing. `stream.js` wires them together and `stream-transport.js` gains `handleParsedEvent` so parsing happens once. No changes to SSE ordering or tool-call emission.

**Tech Stack:** Node.js 22, Express SSE stream handler, Vitest unit tests.

## Goal
- Further modularize the chat stream path so `src/handlers/chat/stream.js` remains orchestration-only, while preserving existing stream behavior and usage telemetry.

## Assumptions / constraints
- Use a normal branch in the main working tree (repo forbids git worktrees for routine work).
- No changes to SSE ordering, tool-call emission, or usage/finish semantics.
- No new dependencies; keep helpers in `src/handlers/chat/`.
- Full unit and integration test gate must remain green.

## Research (current state)
- Relevant files/entrypoints:
  - `src/handlers/chat/stream.js` (usage tracking, metadata sanitization, non-message routing)
  - `src/handlers/chat/stream-runtime-emitter.js` (emits deltas/messages, uses metadata helpers)
  - `src/handlers/chat/stream-transport.js` and `src/handlers/chat/stream-event.js` (event parsing)
  - `src/handlers/chat/stream-output.js` (tool buffer and output)
  - `src/handlers/chat/nonstream.js` (similar metadata sanitizer logic)
  - `tests/unit/handlers/chat/stream.spec.js`
  - `tests/unit/handlers/chat/stream-transport.spec.js`
- Existing patterns to follow:
  - Small factory helpers like `createStreamRuntimeEmitter` and `createStreamTimers`
  - Keep logging and telemetry centralized (appendUsage, appendProtoEvent)

## Analysis
### Options
1) Minimal extraction: only usage tracking helper.
2) Balanced extraction: usage tracker, metadata sanitizer, and event router helpers, plus `handleParsedEvent` in transport.
3) Extensive extraction: additional lifecycle and finish-reason helpers.

### Decision
- Chosen: Option 2 (balanced extraction).
- Why: largest reduction in `stream.js` complexity without heavy surface area or behavior changes.

### Risks / edge cases
- Usage trigger ordering (token_count vs task_complete).
- Metadata sanitizer buffering behavior with partial lines.
- Double-parsing stream events if transport and router both parse.

### Open questions
- None.

## Q&A (answer before implementation)
- Done criteria: maximize maintainability without changing behavior.
- Scope limits: none beyond existing layout.
- Tests: infer based on codebase; run standard full gate.
- Docs: plan file only (no new design doc).

## Implementation plan
### Task 0: Create working branch
**Files:**
- Modify: none

**Step 1: Create branch**

Run: `git checkout -b chore/chat-stream-modularization-followup`
Expected: "Switched to a new branch ..."

**Step 2: Sanity check working tree**

Run: `git status --short`
Expected: clean working tree (no staged/untracked changes beyond the plan doc).

### Task 1: Add stream metadata sanitizer helper
**Files:**
- Create: `src/handlers/chat/stream-metadata-sanitizer.js`
- Test: `tests/unit/handlers/chat/stream-metadata-sanitizer.spec.js`

**Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from "vitest";
import { createStreamMetadataSanitizer } from "../../../../src/handlers/chat/stream-metadata-sanitizer.js";

describe("stream metadata sanitizer", () => {
  it("buffers, sanitizes, and emits segments", () => {
    const appendContentSegment = vi.fn();
    const appendProtoEvent = vi.fn();
    const sanitizer = createStreamMetadataSanitizer({
      sanitizeMetadata: true,
      reqId: "req-1",
      route: "/v1/chat/completions",
      mode: "chat_stream",
      appendProtoEvent,
      logSanitizerToggle: vi.fn(),
      metadataKeys: () => ["customer.id"],
      normalizeMetadataKey: (key) => key,
      sanitizeMetadataTextSegment: (segment) => ({ text: segment, removed: [] }),
      appendContentSegment,
      scheduleStopAfterTools: vi.fn(),
    });

    sanitizer.enqueueSanitizedSegment(
      "hello\n",
      { metadata: { "customer.id": "1" }, sources: ["request"] },
      { stage: "agent_message_delta", eventType: "agent_message_delta" },
      { choiceIndex: 0 }
    );

    expect(appendContentSegment).toHaveBeenCalledWith("hello\n", { choiceIndex: 0 });
    const summary = sanitizer.getSummaryData();
    expect(summary.keys).toContain("customer.id");
  });

  it("records sanitized removals", () => {
    const appendProtoEvent = vi.fn();
    const sanitizer = createStreamMetadataSanitizer({
      sanitizeMetadata: true,
      reqId: "req-1",
      route: "/v1/chat/completions",
      mode: "chat_stream",
      appendProtoEvent,
      logSanitizerToggle: vi.fn(),
      metadataKeys: () => [],
      normalizeMetadataKey: (key) => key,
      sanitizeMetadataTextSegment: (segment) => ({
        text: segment,
        removed: [{ key: "user.id", raw: "user.id:2" }],
      }),
      appendContentSegment: vi.fn(),
      scheduleStopAfterTools: vi.fn(),
    });

    sanitizer.recordSanitizedMetadata({
      stage: "agent_message_delta",
      eventType: "agent_message_delta",
      metadata: { "user.id": "2" },
      removed: [{ key: "user.id", raw: "user.id:2" }],
      sources: ["request"],
    });

    const summary = sanitizer.getSummaryData();
    expect(summary.count).toBe(1);
    expect(appendProtoEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "metadata_sanitizer" })
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-metadata-sanitizer.spec.js`
Expected: FAIL (module missing).

**Step 3: Write minimal implementation**

```js
export const createStreamMetadataSanitizer = ({
  sanitizeMetadata = false,
  reqId,
  route = "/v1/chat/completions",
  mode = "chat_stream",
  appendProtoEvent,
  logSanitizerToggle,
  metadataKeys = () => [],
  normalizeMetadataKey = (key) => key,
  sanitizeMetadataTextSegment,
  appendContentSegment = () => {},
  scheduleStopAfterTools = () => {},
} = {}) => {
  const sanitizedContentStates = new Map();
  const sanitizedMetadataSummary = { count: 0, keys: new Set(), sources: new Set() };
  const seenSanitizedRemovalSignatures = new Set();
  const mergedMetadata = { metadata: {}, sources: new Set() };
  const metadataKeyRegister = new Set(
    typeof metadataKeys === "function" ? metadataKeys() : []
  );

  if (typeof logSanitizerToggle === "function") {
    logSanitizerToggle({
      enabled: sanitizeMetadata,
      trigger: "request",
      route,
      mode,
      reqId,
    });
  }

  const getSanitizedContentState = (choiceIndex = 0) => {
    const normalized = Number.isInteger(choiceIndex) && choiceIndex >= 0 ? choiceIndex : 0;
    if (!sanitizedContentStates.has(normalized)) {
      sanitizedContentStates.set(normalized, {
        pending: "",
        lastContext: { stage: "agent_message_delta", eventType: "agent_message_delta" },
      });
    }
    return sanitizedContentStates.get(normalized);
  };

  const listChoiceIndexes = () => Array.from(sanitizedContentStates.keys());

  const mergeMetadataInfo = (info) => {
    if (!info || typeof info !== "object") {
      const hasMetadata = Object.keys(mergedMetadata.metadata).length > 0;
      const hasSources = mergedMetadata.sources.size > 0;
      if (!hasMetadata && !hasSources) return null;
      return {
        metadata: { ...mergedMetadata.metadata },
        sources: Array.from(mergedMetadata.sources),
      };
    }
    const incomingMetadata =
      info.metadata && typeof info.metadata === "object" ? info.metadata : {};
    for (const [rawKey, rawValue] of Object.entries(incomingMetadata)) {
      const normalized = normalizeMetadataKey(rawKey);
      if (!normalized) continue;
      // eslint-disable-next-line security/detect-object-injection
      mergedMetadata.metadata[normalized] = rawValue;
      metadataKeyRegister.add(normalized);
    }
    if (Array.isArray(info.sources)) {
      for (const source of info.sources) {
        if (typeof source === "string" && source) mergedMetadata.sources.add(source);
      }
    }
    const hasMetadata = Object.keys(mergedMetadata.metadata).length > 0;
    const hasSources = mergedMetadata.sources.size > 0;
    if (!hasMetadata && !hasSources) return null;
    return {
      metadata: { ...mergedMetadata.metadata },
      sources: Array.from(mergedMetadata.sources),
    };
  };

  const getSummaryData = () => ({
    count: sanitizedMetadataSummary.count,
    keys: Array.from(sanitizedMetadataSummary.keys),
    sources: Array.from(sanitizedMetadataSummary.sources),
  });

  const shouldHoldPartialLine = (candidate, keys) => {
    if (!candidate) return false;
    const trimmed = candidate.trimStart();
    if (!trimmed) return false;
    const withoutContainers = trimmed.replace(/^[[{]\\s*/, "");
    const match = withoutContainers.match(/^['"]?([A-Za-z0-9._-]+)/);
    if (!match) return false;
    const candidateKey = normalizeMetadataKey(match[1]);
    if (!candidateKey) return false;
    const hasSeparator = /[:=]/.test(withoutContainers);
    if (hasSeparator) return keys.has(candidateKey);
    for (const key of keys) {
      if (key.startsWith(candidateKey)) return true;
    }
    return false;
  };

  const recordSanitizedMetadata = ({ stage, eventType, metadata, removed, sources }) => {
    if (!sanitizeMetadata) return;
    const metadataObject =
      metadata && typeof metadata === "object" && Object.keys(metadata).length ? metadata : null;
    const removedEntries = Array.isArray(removed)
      ? removed.filter((entry) => entry && typeof entry === "object")
      : [];
    if (metadataObject) {
      for (const key of Object.keys(metadataObject)) {
        const normalizedKey = normalizeMetadataKey(key);
        if (normalizedKey) {
          sanitizedMetadataSummary.keys.add(normalizedKey);
          metadataKeyRegister.add(normalizedKey);
        }
      }
    }
    const uniqueRemovedEntries = [];
    if (removedEntries.length) {
      for (const entry of removedEntries) {
        const normalizedKey = normalizeMetadataKey(entry.key);
        const signature = `${normalizedKey || ""}::${entry.raw || ""}`;
        if (!signature.trim()) continue;
        if (seenSanitizedRemovalSignatures.has(signature)) continue;
        seenSanitizedRemovalSignatures.add(signature);
        if (normalizedKey) {
          sanitizedMetadataSummary.keys.add(normalizedKey);
          metadataKeyRegister.add(normalizedKey);
        }
        uniqueRemovedEntries.push({ ...entry, key: normalizedKey || entry.key });
      }
      sanitizedMetadataSummary.count += uniqueRemovedEntries.length;
    }
    const sourceList = Array.isArray(sources)
      ? sources.filter((source) => typeof source === "string" && source)
      : [];
    for (const source of sourceList) sanitizedMetadataSummary.sources.add(source);
    if (!metadataObject && !uniqueRemovedEntries.length) return;
    if (typeof appendProtoEvent === "function") {
      appendProtoEvent({
        ts: Date.now(),
        req_id: reqId,
        route,
        mode,
        kind: "metadata_sanitizer",
        toggle_enabled: true,
        stage,
        event_type: eventType,
        metadata: metadataObject || undefined,
        removed_lines: uniqueRemovedEntries.length ? uniqueRemovedEntries : undefined,
        metadata_sources: sourceList.length ? sourceList : undefined,
      });
    }
  };

  const applyMetadataSanitizer = (segment, metadataInfo, { stage, eventType }) => {
    if (!sanitizeMetadata) return segment;
    const metadata = metadataInfo?.metadata || {};
    const { text: sanitizedText, removed } = sanitizeMetadataTextSegment(segment ?? "", metadata);
    if (metadataInfo || (removed && removed.length)) {
      recordSanitizedMetadata({
        stage,
        eventType,
        metadata: metadataInfo ? metadata : null,
        removed,
        sources: metadataInfo?.sources,
      });
    }
    return sanitizedText;
  };

  const drainPendingSanitized = (choiceIndex = 0, { flush = false, metadataInfo = null } = {}) => {
    if (!sanitizeMetadata) return;
    const state = getSanitizedContentState(choiceIndex);
    if (!state.pending) return;
    const info = metadataInfo || mergeMetadataInfo(null);
    const emitPortion = (portion) => {
      if (!portion) return;
      const sanitizedPortion = applyMetadataSanitizer(portion, info, state.lastContext);
      if (sanitizedPortion) {
        appendContentSegment(sanitizedPortion, { choiceIndex });
      } else if (portion.trim()) {
        scheduleStopAfterTools(choiceIndex);
      }
    };
    while (state.pending) {
      if (!flush) {
        const newlineIdx = state.pending.indexOf("\\n");
        if (newlineIdx >= 0) {
          const portion = state.pending.slice(0, newlineIdx + 1);
          state.pending = state.pending.slice(newlineIdx + 1);
          emitPortion(portion);
          continue;
        }
        if (shouldHoldPartialLine(state.pending, metadataKeyRegister)) break;
      }
      const portion = state.pending;
      state.pending = "";
      emitPortion(portion);
      if (!flush) break;
    }
  };

  const enqueueSanitizedSegment = (
    segment,
    metadataInfo,
    context = {},
    { flush = false, choiceIndex = 0 } = {}
  ) => {
    if (!sanitizeMetadata) {
      if (segment) appendContentSegment(segment, { choiceIndex });
      return;
    }
    const state = getSanitizedContentState(choiceIndex);
    if (context.stage || context.eventType) {
      state.lastContext = {
        stage: context.stage || state.lastContext.stage,
        eventType: context.eventType || state.lastContext.eventType,
      };
    }
    const mergedInfo = mergeMetadataInfo(metadataInfo);
    if (segment) state.pending += segment;
    drainPendingSanitized(choiceIndex, { flush, metadataInfo: mergedInfo });
  };

  const flushSanitizedSegments = (context = {}) => {
    if (!sanitizeMetadata) return;
    const targets =
      typeof context.choiceIndex === "number"
        ? [context.choiceIndex]
        : sanitizedContentStates.size
          ? Array.from(sanitizedContentStates.keys())
          : [0];
    targets.forEach((idx) => {
      const state = getSanitizedContentState(idx);
      if (context.stage || context.eventType) {
        state.lastContext = {
          stage: context.stage || state.lastContext.stage,
          eventType: context.eventType || state.lastContext.eventType,
        };
      }
      drainPendingSanitized(idx, { flush: true });
    });
  };

  const emitSummaryProtoEvent = () => {
    if (!sanitizeMetadata) return;
    const { count, keys, sources } = getSummaryData();
    if (typeof appendProtoEvent !== "function") return;
    appendProtoEvent({
      ts: Date.now(),
      req_id: reqId,
      route,
      mode,
      kind: "metadata_sanitizer_summary",
      sanitized_count: count,
      sanitized_keys: keys,
      sanitized_sources: sources,
    });
  };

  return {
    getSanitizedContentState,
    listChoiceIndexes,
    mergeMetadataInfo,
    recordSanitizedMetadata,
    applyMetadataSanitizer,
    enqueueSanitizedSegment,
    flushSanitizedSegments,
    getSummaryData,
    emitSummaryProtoEvent,
  };
};
```

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-metadata-sanitizer.spec.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/handlers/chat/stream-metadata-sanitizer.js tests/unit/handlers/chat/stream-metadata-sanitizer.spec.js
git commit -m "refactor: add stream metadata sanitizer helper"
```

### Task 2: Add stream usage tracker helper
**Files:**
- Create: `src/handlers/chat/stream-usage-tracker.js`
- Test: `tests/unit/handlers/chat/stream-usage-tracker.spec.js`

**Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from "vitest";
import { createStreamUsageTracker } from "../../../../src/handlers/chat/stream-usage-tracker.js";

describe("stream usage tracker", () => {
  it("emits usage chunk with aggregated counts", () => {
    const sendChunk = vi.fn();
    const tracker = createStreamUsageTracker({
      includeUsage: true,
      choiceCount: 2,
      promptTokensEst: 5,
      startedAt: 1000,
      getEmittedLength: () => 8,
      getFirstTokenAt: () => 1100,
      sendChunk,
      appendUsage: vi.fn(),
      resolveFinishReason: () => ({ reason: "stop", source: "finalizer" }),
      hasToolCallEvidence: () => false,
      hasFunctionCall: false,
      toolCallAggregator: { supportsParallelCalls: () => false, hasCalls: () => false },
      getToolStats: () => ({ count: 0, truncated: 0 }),
      stopAfterToolsMode: "burst",
      outputMode: "text",
      req: { method: "POST", headers: {} },
      res: {},
      reqId: "req-1",
      route: "/v1/chat/completions",
      mode: "chat_stream",
      requestedModel: "gpt-test",
      effectiveModel: "gpt-test",
    });

    tracker.updateUsageCounts("token_count", { prompt: 5, completion: 4 });
    tracker.emitUsageChunk("token_count");

    expect(sendChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        usage: expect.objectContaining({
          prompt_tokens: 5,
          completion_tokens: 8,
          total_tokens: 13,
          emission_trigger: "token_count",
        }),
      })
    );
  });

  it("logs usage only once", () => {
    const appendUsage = vi.fn();
    const tracker = createStreamUsageTracker({
      includeUsage: false,
      choiceCount: 1,
      promptTokensEst: 2,
      startedAt: 1000,
      getEmittedLength: () => 4,
      getFirstTokenAt: () => 1100,
      sendChunk: vi.fn(),
      appendUsage,
      resolveFinishReason: () => ({ reason: "stop", source: "finalizer" }),
      hasToolCallEvidence: () => false,
      hasFunctionCall: false,
      toolCallAggregator: { supportsParallelCalls: () => false, hasCalls: () => false },
      getToolStats: () => ({ count: 0, truncated: 0 }),
      stopAfterToolsMode: "burst",
      outputMode: "text",
      req: { method: "POST", headers: {} },
      res: {},
      reqId: "req-1",
      route: "/v1/chat/completions",
      mode: "chat_stream",
      requestedModel: "gpt-test",
      effectiveModel: "gpt-test",
    });

    tracker.logUsage("token_count");
    tracker.logUsage("token_count");

    expect(appendUsage).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-usage-tracker.spec.js`
Expected: FAIL (module missing).

**Step 3: Write minimal implementation**

```js
export const createStreamUsageTracker = ({
  includeUsage = false,
  choiceCount = 1,
  promptTokensEst = 0,
  startedAt = Date.now(),
  getEmittedLength = () => 0,
  getFirstTokenAt = () => null,
  sendChunk = () => {},
  appendUsage,
  logSanitizerSummary,
  getSanitizerSummaryData,
  resolveFinishReason,
  hasToolCallEvidence,
  hasFunctionCall = false,
  toolCallAggregator,
  getToolStats = () => ({ count: 0, truncated: 0 }),
  stopAfterToolsMode,
  outputMode,
  req,
  res,
  reqId,
  route = "/v1/chat/completions",
  mode = "chat_stream",
  requestedModel,
  effectiveModel,
  getHttpContext,
  sanitizeMetadata = false,
  isDev = false,
} = {}) => {
  const usageState = {
    prompt: 0,
    completion: 0,
    emitted: false,
    logged: false,
    trigger: null,
    countsSource: "estimate",
    providerSupplied: false,
    firstTokenMs: null,
    totalDurationMs: null,
  };

  const updateUsageCounts = (trigger, { prompt, completion } = {}, { provider = false } = {}) => {
    const promptNum = Number.isFinite(prompt) ? Number(prompt) : NaN;
    const completionNum = Number.isFinite(completion) ? Number(completion) : NaN;
    let touched = false;
    if (!Number.isNaN(promptNum) && promptNum >= 0) {
      usageState.prompt = provider ? promptNum : Math.max(usageState.prompt, promptNum);
      touched = true;
    }
    if (!Number.isNaN(completionNum) && completionNum >= 0) {
      usageState.completion = provider
        ? completionNum
        : Math.max(usageState.completion, completionNum);
      touched = true;
    }
    if (touched) usageState.countsSource = "event";
    if (!usageState.trigger) usageState.trigger = trigger;
    if (provider) usageState.providerSupplied = true;
  };

  const resolveCounts = () => {
    const emittedLength = getEmittedLength();
    const estimatedCompletion = Math.ceil(emittedLength / 4);
    const usingEvent = usageState.countsSource === "event";
    const promptTokens = usingEvent ? usageState.prompt : promptTokensEst;
    const completionTokens = usingEvent ? usageState.completion : estimatedCompletion;
    const totalTokens = promptTokens + completionTokens;
    return { promptTokens, completionTokens, totalTokens, estimatedCompletion };
  };

  const emitUsageChunk = (trigger) => {
    if (usageState.emitted || !includeUsage) return false;
    const { promptTokens, completionTokens } = resolveCounts();
    const aggregatedCompletion = completionTokens * choiceCount;
    const aggregatedTotal = promptTokens + aggregatedCompletion;
    const firstTokenAt = getFirstTokenAt();
    const firstTokenMs = firstTokenAt === null ? null : Math.max(firstTokenAt - startedAt, 0);
    const totalDurationMs = Math.max(Date.now() - startedAt, 0);
    usageState.firstTokenMs = firstTokenMs;
    usageState.totalDurationMs = totalDurationMs;
    usageState.emitted = true;
    sendChunk({
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: aggregatedCompletion,
        total_tokens: aggregatedTotal,
        time_to_first_token_ms: firstTokenMs,
        total_duration_ms: totalDurationMs,
        time_to_first_token: null,
        throughput_after_first_token: null,
        emission_trigger: trigger,
      },
    });
    return true;
  };

  const logUsage = (trigger) => {
    if (usageState.logged || typeof appendUsage !== "function") return false;
    const { promptTokens, completionTokens, estimatedCompletion } = resolveCounts();
    const aggregatedCompletion = completionTokens * choiceCount;
    const aggregatedTotal = promptTokens + aggregatedCompletion;
    const aggregatedEstCompletion = estimatedCompletion * choiceCount;
    const emittedAtMs = Date.now() - startedAt;
    const firstTokenAt = getFirstTokenAt();
    const firstTokenMs =
      usageState.firstTokenMs !== null
        ? usageState.firstTokenMs
        : firstTokenAt === null
          ? null
          : Math.max(firstTokenAt - startedAt, 0);
    const totalDurationMs = usageState.totalDurationMs ?? emittedAtMs;
    const resolved = resolveFinishReason ? resolveFinishReason() : { reason: null, source: null };
    const { count, keys, sources } = getSanitizerSummaryData
      ? getSanitizerSummaryData()
      : { count: 0, keys: [], sources: [] };
    if (sanitizeMetadata && typeof logSanitizerSummary === "function") {
      logSanitizerSummary({
        enabled: true,
        route,
        mode,
        reqId,
        count,
        keys,
        sources,
      });
    }
    try {
      const httpCtx =
        typeof getHttpContext === "function" && res ? getHttpContext(res) || {} : {};
      appendUsage({
        req_id: reqId,
        route: httpCtx.route || route,
        mode: httpCtx.mode || mode,
        method: req?.method || "POST",
        status_code: 200,
        requested_model: requestedModel,
        effective_model: effectiveModel,
        stream: true,
        prompt_tokens: promptTokens,
        completion_tokens: aggregatedCompletion,
        total_tokens: aggregatedTotal,
        prompt_tokens_est: promptTokensEst,
        completion_tokens_est: aggregatedEstCompletion,
        total_tokens_est: promptTokensEst + aggregatedEstCompletion,
        duration_ms: emittedAtMs,
        total_duration_ms: totalDurationMs,
        status: 200,
        user_agent: req?.headers?.["user-agent"] || "",
        emission_trigger: trigger,
        emitted_at_ms: emittedAtMs,
        counts_source: usageState.countsSource,
        usage_included: includeUsage,
        provider_supplied: usageState.providerSupplied,
        time_to_first_token_ms: firstTokenMs,
        finish_reason: resolved.reason,
        finish_reason_source: resolved.source,
        has_tool_calls: typeof hasToolCallEvidence === "function" ? hasToolCallEvidence() : false,
        has_function_call: Boolean(hasFunctionCall),
        tool_call_parallel_supported: toolCallAggregator?.supportsParallelCalls?.() || false,
        tool_call_emitted: toolCallAggregator?.hasCalls?.() || false,
        tool_call_count_total: getToolStats().count,
        tool_call_truncated_total: getToolStats().truncated,
        stop_after_tools_mode: stopAfterToolsMode || "burst",
        choice_count: choiceCount,
        metadata_sanitizer_enabled: sanitizeMetadata,
        sanitized_metadata_count: sanitizeMetadata ? count : 0,
        sanitized_metadata_keys: sanitizeMetadata ? keys : [],
        sanitized_metadata_sources: sanitizeMetadata ? sources : [],
        output_mode: outputMode,
      });
    } catch (err) {
      if (isDev) {
        console.error("[dev][response][chat][stream] usage log error:", err);
      }
    }
    usageState.logged = true;
    return true;
  };

  const markTriggerIfMissing = (trigger) => {
    if (!usageState.trigger) usageState.trigger = trigger;
  };

  return {
    state: usageState,
    updateUsageCounts,
    resolveCounts,
    emitUsageChunk,
    logUsage,
    markTriggerIfMissing,
    hasEmitted: () => usageState.emitted,
    hasLogged: () => usageState.logged,
    getTrigger: () => usageState.trigger,
  };
};
```

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-usage-tracker.spec.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/handlers/chat/stream-usage-tracker.js tests/unit/handlers/chat/stream-usage-tracker.spec.js
git commit -m "refactor: add stream usage tracker helper"
```

### Task 3: Add stream event router helper
**Files:**
- Create: `src/handlers/chat/stream-event-router.js`
- Test: `tests/unit/handlers/chat/stream-event-router.spec.js`

**Step 1: Write the failing test**

```js
import { describe, expect, it, vi } from "vitest";
import { createStreamEventRouter } from "../../../../src/handlers/chat/stream-event-router.js";

describe("stream event router", () => {
  it("routes message events to transport", () => {
    const handleParsedEvent = vi.fn(() => true);
    const router = createStreamEventRouter({
      parseStreamEventLine: () => ({
        type: "agent_message_delta",
        payload: {},
        params: {},
        messagePayload: { delta: "hi" },
      }),
      sanitizeMetadata: false,
      handleParsedEvent,
      trackToolSignals: vi.fn(),
      extractFinishReasonFromMessage: vi.fn(),
      trackFinishReason: vi.fn(),
      updateUsageCounts: vi.fn(),
      mergeMetadataInfo: vi.fn(),
      recordSanitizedMetadata: vi.fn(),
      shouldDropFunctionCallOutput: vi.fn(),
      getUsageTrigger: () => null,
      markUsageTriggerIfMissing: vi.fn(),
      hasAnyChoiceSent: () => true,
      hasLengthEvidence: () => false,
      emitFinishChunk: vi.fn(),
      finalizeStream: vi.fn(),
    });

    router.handleLine("{\"type\":\"agent_message_delta\"}");

    expect(handleParsedEvent).toHaveBeenCalled();
  });

  it("finalizes on task_complete", () => {
    const finalizeStream = vi.fn();
    const emitFinishChunk = vi.fn();
    const updateUsageCounts = vi.fn();
    const router = createStreamEventRouter({
      parseStreamEventLine: () => ({
        type: "task_complete",
        payload: {},
        params: {},
        messagePayload: { completion_tokens: 3 },
      }),
      sanitizeMetadata: false,
      handleParsedEvent: vi.fn(),
      trackToolSignals: vi.fn(),
      extractFinishReasonFromMessage: () => "stop",
      trackFinishReason: vi.fn(),
      updateUsageCounts,
      mergeMetadataInfo: vi.fn(),
      recordSanitizedMetadata: vi.fn(),
      shouldDropFunctionCallOutput: vi.fn(),
      getUsageTrigger: () => null,
      markUsageTriggerIfMissing: vi.fn(),
      hasAnyChoiceSent: () => true,
      hasLengthEvidence: () => false,
      emitFinishChunk,
      finalizeStream,
    });

    const result = router.handleLine("{\"type\":\"task_complete\"}");
    expect(emitFinishChunk).toHaveBeenCalledWith("stop");
    expect(finalizeStream).toHaveBeenCalledWith({ reason: "stop", trigger: "task_complete" });
    expect(result.stop).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-event-router.spec.js`
Expected: FAIL (module missing).

**Step 3: Write minimal implementation**

```js
export const createStreamEventRouter = ({
  parseStreamEventLine,
  extractMetadataFromPayload,
  sanitizeMetadata = false,
  appendProtoEvent,
  reqId,
  route = "/v1/chat/completions",
  mode = "chat_stream",
  handleParsedEvent,
  trackToolSignals,
  extractFinishReasonFromMessage,
  trackFinishReason,
  updateUsageCounts,
  mergeMetadataInfo,
  recordSanitizedMetadata,
  shouldDropFunctionCallOutput,
  getUsageTrigger,
  markUsageTriggerIfMissing,
  hasAnyChoiceSent,
  hasLengthEvidence,
  emitFinishChunk,
  finalizeStream,
} = {}) => {
  const handleLine = (line) => {
    const parsed = parseStreamEventLine?.(line, {
      extractMetadataFromPayload,
      sanitizeMetadata,
    });
    if (!parsed) return { handled: false };
    const { type: t, payload, params, messagePayload, metadataInfo } = parsed;
    if (typeof appendProtoEvent === "function") {
      appendProtoEvent({
        ts: Date.now(),
        req_id: reqId,
        route,
        mode,
        kind: "event",
        event: payload,
      });
    }
    if (messagePayload) {
      if (typeof trackToolSignals === "function") trackToolSignals(messagePayload);
      const finishCandidate =
        typeof extractFinishReasonFromMessage === "function"
          ? extractFinishReasonFromMessage(messagePayload)
          : null;
      if (finishCandidate && typeof trackFinishReason === "function") {
        trackFinishReason(finishCandidate, t || "event");
      }
    }
    if (
      t === "agent_message_content_delta" ||
      t === "agent_message_delta" ||
      t === "agent_message"
    ) {
      if (typeof handleParsedEvent === "function") handleParsedEvent(parsed);
      return { handled: true };
    }
    if (t === "function_call_output") {
      if (typeof shouldDropFunctionCallOutput === "function") {
        if (shouldDropFunctionCallOutput(messagePayload)) return { handled: true };
      }
    } else if (t === "metadata") {
      if (sanitizeMetadata && metadataInfo) {
        if (typeof mergeMetadataInfo === "function") mergeMetadataInfo(metadataInfo);
        if (typeof recordSanitizedMetadata === "function") {
          recordSanitizedMetadata({
            stage: "metadata_event",
            eventType: t,
            metadata: metadataInfo.metadata,
            removed: [],
            sources: metadataInfo.sources,
          });
        }
      }
    } else if (t === "token_count") {
      const promptTokens = Number(
        messagePayload?.prompt_tokens ??
          messagePayload?.promptTokens ??
          messagePayload?.token_count?.prompt_tokens ??
          params?.prompt_tokens ??
          params?.promptTokens ??
          params?.token_count?.prompt_tokens
      );
      const completionTokens = Number(
        messagePayload?.completion_tokens ??
          messagePayload?.completionTokens ??
          messagePayload?.token_count?.completion_tokens ??
          params?.completion_tokens ??
          params?.completionTokens ??
          params?.token_count?.completion_tokens
      );
      if (typeof updateUsageCounts === "function") {
        updateUsageCounts("token_count", { prompt: promptTokens, completion: completionTokens });
      }
      const tokenFinishReason =
        typeof extractFinishReasonFromMessage === "function"
          ? extractFinishReasonFromMessage(messagePayload)
          : null;
      if (tokenFinishReason && typeof trackFinishReason === "function") {
        trackFinishReason(tokenFinishReason, "token_count");
      }
    } else if (t === "usage") {
      const promptTokens = Number(
        messagePayload?.prompt_tokens ??
          messagePayload?.usage?.prompt_tokens ??
          params?.usage?.prompt_tokens ??
          params?.prompt_tokens ??
          params?.promptTokens ??
          params?.token_count?.prompt_tokens
      );
      const completionTokens = Number(
        messagePayload?.completion_tokens ??
          messagePayload?.usage?.completion_tokens ??
          params?.usage?.completion_tokens ??
          params?.completion_tokens ??
          params?.completionTokens ??
          params?.token_count?.completion_tokens
      );
      if (typeof updateUsageCounts === "function") {
        updateUsageCounts(
          "provider",
          { prompt: promptTokens, completion: completionTokens },
          { provider: true }
        );
      }
    } else if (t === "task_complete") {
      const finishReason =
        typeof extractFinishReasonFromMessage === "function"
          ? extractFinishReasonFromMessage(messagePayload)
          : null;
      if (finishReason && typeof trackFinishReason === "function") {
        trackFinishReason(finishReason, "task_complete");
      } else if (typeof hasAnyChoiceSent === "function" && !hasAnyChoiceSent()) {
        if (typeof trackFinishReason === "function") {
          trackFinishReason("length", "task_complete");
        }
      } else if (typeof hasLengthEvidence === "function" && hasLengthEvidence()) {
        if (typeof trackFinishReason === "function") {
          trackFinishReason("length", "task_complete");
        }
      }
      const promptTokens = Number(
        messagePayload?.prompt_tokens ??
          messagePayload?.token_count?.prompt_tokens ??
          params?.token_count?.prompt_tokens ??
          params?.prompt_tokens ??
          params?.promptTokens
      );
      const completionTokens = Number(
        messagePayload?.completion_tokens ??
          messagePayload?.token_count?.completion_tokens ??
          params?.token_count?.completion_tokens ??
          params?.completion_tokens ??
          params?.completionTokens
      );
      const usageTrigger = typeof getUsageTrigger === "function" ? getUsageTrigger() : null;
      if (Number.isFinite(promptTokens) || Number.isFinite(completionTokens)) {
        if (typeof updateUsageCounts === "function") {
          updateUsageCounts(usageTrigger || "task_complete", {
            prompt: promptTokens,
            completion: completionTokens,
          });
        }
      } else if (typeof markUsageTriggerIfMissing === "function") {
        markUsageTriggerIfMissing("task_complete");
      }
      if (typeof emitFinishChunk === "function") emitFinishChunk(finishReason || undefined);
      if (typeof finalizeStream === "function") {
        finalizeStream({ reason: finishReason, trigger: usageTrigger || "task_complete" });
      }
      return { handled: true, stop: true };
    }
    return { handled: true };
  };

  return { handleLine };
};
```

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-event-router.spec.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/handlers/chat/stream-event-router.js tests/unit/handlers/chat/stream-event-router.spec.js
git commit -m "refactor: add stream event router helper"
```

### Task 4: Add parsed-event handling to stream transport
**Files:**
- Modify: `src/handlers/chat/stream-transport.js`
- Test: `tests/unit/handlers/chat/stream-transport.spec.js`

**Step 1: Write the failing test**

```js
it("handles parsed events directly", () => {
  const runtime = { handleDelta: vi.fn() };
  const { handleParsedEvent } = wireStreamTransport({ runtime });
  const handled = handleParsedEvent({
    type: "agent_message_delta",
    params: {},
    messagePayload: { delta: "hi" },
    baseChoiceIndex: 0,
  });
  expect(handled).toBe(true);
  expect(runtime.handleDelta).toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-transport.spec.js`
Expected: FAIL (handleParsedEvent missing).

**Step 3: Write minimal implementation**

```js
  const handleParsedEvent = (parsed) => {
    if (!parsed) return false;
    const { type, params, messagePayload, metadataInfo, baseChoiceIndex } = parsed;
    if (type === "agent_message_content_delta" || type === "agent_message_delta") {
      if (!runtime?.handleDelta) return false;
      const deltaPayload = messagePayload?.delta ?? messagePayload;
      const choiceIndex = resolveChoiceIndex(deltaPayload, messagePayload, params, baseChoiceIndex);
      runtime.handleDelta({
        choiceIndex,
        delta: deltaPayload,
        metadataInfo,
        eventType: type,
      });
      return true;
    }
    if (type === "agent_message") {
      if (!runtime?.handleMessage) return false;
      const finalMessage = messagePayload?.message ?? messagePayload;
      const choiceIndex = resolveChoiceIndex(finalMessage, messagePayload, params, baseChoiceIndex);
      runtime.handleMessage({
        choiceIndex,
        message: finalMessage,
        metadataInfo,
        eventType: type,
      });
      return true;
    }
    return false;
  };

  const handleLine = (line) => {
    const parsed = parseStreamEventLine(line, {
      resolveChoiceIndexFromPayload,
      extractMetadataFromPayload,
      sanitizeMetadata,
    });
    return handleParsedEvent(parsed);
  };

  return { handleLine, handleParsedEvent };
```

**Step 4: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream-transport.spec.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/handlers/chat/stream-transport.js tests/unit/handlers/chat/stream-transport.spec.js
git commit -m "refactor: add parsed-event handling to stream transport"
```

### Task 5: Wire helpers into stream.js and runtime emitter
**Files:**
- Modify: `src/handlers/chat/stream.js`
- Modify: `src/handlers/chat/stream-runtime-emitter.js`
- Modify: `tests/unit/handlers/chat/stream.spec.js`

**Step 1: Add failing test for router integration**

```js
const createStreamEventRouterMock = vi.fn(() => ({ handleLine: vi.fn(() => ({ handled: true })) }));

vi.mock("../../../../src/handlers/chat/stream-event-router.js", () => ({
  createStreamEventRouter: (...args) => createStreamEventRouterMock(...args),
}));

it("routes stdout lines through stream event router", async () => {
  const postChatStream = await loadHandler();
  const req = {
    body: { stream: true, messages: [{ role: "user", content: "hi" }] },
    headers: {},
    method: "POST",
  };
  const res = {
    locals: {},
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(),
    end: vi.fn(),
  };

  await postChatStream(req, res);
  expect(createStreamEventRouterMock).toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream.spec.js`
Expected: FAIL (router not wired).

**Step 3: Update stream.js imports and wiring**

```js
import { createStreamMetadataSanitizer } from "./stream-metadata-sanitizer.js";
import { createStreamUsageTracker } from "./stream-usage-tracker.js";
import { createStreamEventRouter } from "./stream-event-router.js";
```

**Step 4: Replace inline metadata sanitizer block with helper**

```js
let metadataSanitizer = null;

const forEachTrackedChoice = (callback) => {
  const indices = new Set();
  for (let idx = 0; idx < choiceCount; idx += 1) indices.add(idx);
  choiceStates.forEach((_state, idx) => indices.add(idx));
  if (metadataSanitizer?.listChoiceIndexes) {
    metadataSanitizer.listChoiceIndexes().forEach((idx) => indices.add(idx));
  }
  if (!indices.size) indices.add(0);
  Array.from(indices)
    .sort((a, b) => a - b)
    .forEach((idx) => callback(idx));
};
```

Create the sanitizer after `scheduleStopAfterTools` is defined:

```js
metadataSanitizer = createStreamMetadataSanitizer({
  sanitizeMetadata: SANITIZE_METADATA,
  reqId,
  route: "/v1/chat/completions",
  mode: "chat_stream",
  appendProtoEvent,
  logSanitizerToggle,
  metadataKeys,
  normalizeMetadataKey,
  sanitizeMetadataTextSegment,
  appendContentSegment: (...args) => appendContentSegment(...args),
  scheduleStopAfterTools: (...args) => scheduleStopAfterTools(...args),
});

const {
  enqueueSanitizedSegment,
  mergeMetadataInfo,
  applyMetadataSanitizer,
  recordSanitizedMetadata,
  flushSanitizedSegments,
  getSummaryData: getSanitizerSummaryData,
  emitSummaryProtoEvent,
} = metadataSanitizer;
```

Remove the old `sanitizedContentStates`, `mergeMetadataInfo`, `applyMetadataSanitizer`,
`enqueueSanitizedSegment`, `flushSanitizedSegments`, and summary helpers from `stream.js`.

**Step 5: Wire metadata helper into runtime emitter**

```js
const { emitDeltaFromRuntime, emitMessageFromRuntime } = createStreamRuntimeEmitter({
  sanitizeMetadata: SANITIZE_METADATA,
  coerceAssistantContent,
  toolCallAggregator,
  ensureChoiceState,
  isObsidianOutput,
  hasTextualToolPrefix,
  emitAggregatorToolContent,
  sendChoiceDelta,
  cloneToolCallDelta,
  logProto: LOG_PROTO,
  appendProtoEvent,
  reqId,
  enqueueSanitizedSegment,
  mergeMetadataInfo,
  applyMetadataSanitizer,
  appendContentSegment,
  emitTextualToolMetadata,
  scheduleStopAfterTools,
  markHasToolCalls: () => {
    hasToolCallsFlag = true;
  },
});
```

**Step 6: Replace usage state with helper**

```js
const usageTracker = createStreamUsageTracker({
  includeUsage,
  choiceCount,
  promptTokensEst,
  startedAt: started,
  getEmittedLength: () =>
    Array.from(choiceStates.values()).reduce((sum, state) => sum + state.emitted.length, 0),
  getFirstTokenAt: () => firstTokenAt,
  sendChunk,
  appendUsage,
  logSanitizerSummary,
  getSanitizerSummaryData,
  resolveFinishReason,
  hasToolCallEvidence,
  hasFunctionCall,
  toolCallAggregator,
  getToolStats: () => lastToolStats,
  stopAfterToolsMode: STOP_AFTER_TOOLS_MODE,
  outputMode,
  req,
  res,
  reqId,
  route: "/v1/chat/completions",
  mode: "chat_stream",
  requestedModel,
  effectiveModel,
  getHttpContext,
  sanitizeMetadata: SANITIZE_METADATA,
  isDev: IS_DEV_ENV,
});
```

Replace calls to `updateUsageCounts`, `emitUsageChunk`, `logUsage`, and `usageState.trigger`
with `usageTracker.updateUsageCounts`, `usageTracker.emitUsageChunk`, `usageTracker.logUsage`,
and `usageTracker.getTrigger()` or `usageTracker.markTriggerIfMissing(...)`.

**Step 7: Route events with new event router**

```js
const eventRouter = createStreamEventRouter({
  parseStreamEventLine,
  extractMetadataFromPayload,
  sanitizeMetadata: SANITIZE_METADATA,
  appendProtoEvent,
  reqId,
  route: "/v1/chat/completions",
  mode: "chat_stream",
  handleParsedEvent: handleTransportLine,
  trackToolSignals,
  extractFinishReasonFromMessage,
  trackFinishReason,
  updateUsageCounts: (...args) => usageTracker.updateUsageCounts(...args),
  mergeMetadataInfo,
  recordSanitizedMetadata,
  shouldDropFunctionCallOutput,
  getUsageTrigger: () => usageTracker.getTrigger(),
  markUsageTriggerIfMissing: (trigger) => usageTracker.markTriggerIfMissing(trigger),
  hasAnyChoiceSent: () => Array.from(choiceStates.values()).some((state) => state.sentAny),
  hasLengthEvidence: () => lengthEvidence,
  emitFinishChunk,
  finalizeStream,
});
```

Update the stdout loop to use `eventRouter` and stop when `stop` is true:

```js
while ((idx = buf.indexOf("\n")) >= 0) {
  const line = buf.slice(0, idx);
  buf = buf.slice(idx + 1);
  const result = eventRouter.handleLine(line);
  if (result?.stop) return;
}
```

**Step 8: Emit sanitizer summary via helper**

```js
if (SANITIZE_METADATA) {
  emitSummaryProtoEvent();
}
```

**Step 9: Run test to verify it passes**

Run: `npm run test:unit -- tests/unit/handlers/chat/stream.spec.js`
Expected: PASS.

**Step 10: Commit**

```bash
git add src/handlers/chat/stream.js src/handlers/chat/stream-runtime-emitter.js tests/unit/handlers/chat/stream.spec.js
git commit -m "refactor: modularize chat stream routing and usage"
```

### Task 6: Full verification
**Files:**
- Modify: none

**Step 1: Run full gate**

Run: `npm run verify:all`
Expected: PASS (format, lint, unit, integration, Playwright).

## Tests to run
- `npm run verify:all`
