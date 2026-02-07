# Chat Stream Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce conditional complexity in the chat streaming handler while preserving externally observable behavior for both stream and nonstream paths.

**Architecture:** Extract focused helper modules for tool output formatting (shared), stream event parsing, and stream output coordination. The stream handler becomes orchestration glue, while nonstream reuses the shared helper to keep tool-call formatting parity.

**Tech Stack:** Node.js (ESM), Express handlers, Vitest unit tests.

### Task 1: Add shared tool output helpers (stream + nonstream)

**Files:**
- Create: `src/handlers/chat/tool-output.js`
- Test: `tests/unit/handlers/chat/tool-output.spec.js`

**Step 1: Write the failing test**

```javascript
import { describe, expect, it } from "vitest";
import {
  normalizeToolCallSnapshot,
  buildCanonicalXml,
  extractTextualUseToolBlock,
  trimTrailingTextAfterToolBlocks,
} from "../../../../src/handlers/chat/tool-output.js";

const buildRecord = (name, args, id = `tool_${name}`) => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

describe("tool output helpers", () => {
  it("dedupes and truncates tool call snapshots", () => {
    const snapshot = [
      buildRecord("alpha", JSON.stringify({ id: 1 }), "dup"),
      buildRecord("alpha", JSON.stringify({ id: 1 }), "dup"),
      buildRecord("beta", JSON.stringify({ id: 2 }), "beta"),
    ];

    const result = normalizeToolCallSnapshot(snapshot, { maxBlocks: 1, dedupe: true });

    expect(result.records).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.observedCount).toBe(2);
  });

  it("builds canonical xml with a custom serializer", () => {
    const snapshot = [buildRecord("lookup", JSON.stringify({ id: 1 }))];

    const xml = buildCanonicalXml(snapshot, {
      delimiter: "\n",
      toXml: (record) => `<use_tool>${record.function.name}</use_tool>`,
    });

    expect(xml).toBe("<use_tool>lookup</use_tool>");
  });

  it("extracts textual tool blocks and trims trailing text", () => {
    const text = "<use_tool>one</use_tool><use_tool>two</use_tool> trailing";
    const extractBlocks = () => ({
      blocks: [
        { start: 0, end: "<use_tool>one</use_tool>".length },
        {
          start: "<use_tool>one</use_tool>".length,
          end: "<use_tool>one</use_tool><use_tool>two</use_tool>".length,
        },
      ],
      nextPos: text.length,
    });

    const extracted = extractTextualUseToolBlock(text, {
      delimiter: "\n\n",
      dedupe: false,
      extractBlocks,
    });

    expect(extracted.split("\n\n")).toHaveLength(2);
    expect(trimTrailingTextAfterToolBlocks(text)).toBe(
      "<use_tool>one</use_tool><use_tool>two</use_tool>"
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/chat/tool-output.spec.js`
Expected: FAIL with "Cannot find module" or "module not found" for `tool-output.js`.

**Step 3: Write minimal implementation**

```javascript
import { config as CFG } from "../../config/index.js";
import { extractUseToolBlocks } from "../../dev-logging.js";
import { toObsidianXml } from "../../lib/tool-call-aggregator.js";

export const getToolOutputOptions = () => ({
  maxBlocks: Number(CFG.PROXY_TOOL_BLOCK_MAX || 0),
  dedupe: !!CFG.PROXY_TOOL_BLOCK_DEDUP,
  delimiter:
    typeof CFG.PROXY_TOOL_BLOCK_DELIMITER === "string"
      ? CFG.PROXY_TOOL_BLOCK_DELIMITER
      : "",
});

const fingerprintToolCall = (record) => {
  if (!record || typeof record !== "object") return null;
  if (record.id && typeof record.id === "string") return `id:${record.id}`;
  const fn = record.function && typeof record.function === "object" ? record.function : {};
  const name = typeof fn.name === "string" ? fn.name : "";
  const args = typeof fn.arguments === "string" ? fn.arguments : "";
  return `fn:${name}:${args}`;
};

export const normalizeToolCallSnapshot = (snapshot = [], options = getToolOutputOptions()) => {
  const list = Array.isArray(snapshot) ? snapshot.slice() : [];
  const dedupe = !!options.dedupe;
  const maxBlocks = Number(options.maxBlocks || 0);
  let next = list;
  if (dedupe && next.length) {
    const seen = new Set();
    next = next.filter((record) => {
      const fingerprint = fingerprintToolCall(record);
      if (!fingerprint) return true;
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
  }
  const truncated = maxBlocks > 0 && next.length > maxBlocks;
  const records = truncated ? next.slice(0, maxBlocks) : next;
  return { records, truncated, observedCount: next.length };
};

const joinToolBlocks = (blocks = [], delimiter = "") => {
  if (!blocks.length) return null;
  if (!delimiter) return blocks.join("");
  return blocks.join(delimiter);
};

export const buildObsidianXmlRecord = (record = null, { toXml = toObsidianXml } = {}) => {
  if (!record) return null;
  const args = record?.function?.arguments || "";
  if (!args) return null;
  try {
    JSON.parse(args);
  } catch {
    return null;
  }
  return toXml(record);
};

export const buildCanonicalXml = (snapshot = [], options = getToolOutputOptions()) => {
  if (!Array.isArray(snapshot) || !snapshot.length) return null;
  const { records } = normalizeToolCallSnapshot(snapshot, options);
  const xmlBlocks = [];
  for (const record of records) {
    const xml = buildObsidianXmlRecord(record, { toXml: options.toXml || toObsidianXml });
    if (xml) xmlBlocks.push(xml);
  }
  return joinToolBlocks(xmlBlocks, options.delimiter || "");
};

export const extractTextualUseToolBlock = (text, options = getToolOutputOptions()) => {
  if (!text || !text.length) return null;
  try {
    const extractBlocks = options.extractBlocks || extractUseToolBlocks;
    const { blocks } = extractBlocks(text, 0);
    if (!blocks || !blocks.length) return null;
    const seen = options.dedupe ? new Set() : null;
    const results = [];
    for (const block of blocks) {
      const start = Number.isInteger(block.start)
        ? block.start
        : Number.isInteger(block.indexStart)
          ? block.indexStart
          : 0;
      const end = Number.isInteger(block.end)
        ? block.end
        : Number.isInteger(block.indexEnd)
          ? block.indexEnd
          : text.length;
      const literal = text.slice(start, end);
      if (!literal) continue;
      if (seen) {
        if (seen.has(literal)) continue;
        seen.add(literal);
      }
      results.push(literal);
    }
    return joinToolBlocks(results, options.delimiter || "");
  } catch {
    return null;
  }
};

export const trimTrailingTextAfterToolBlocks = (content = "") => {
  if (!content || typeof content !== "string") return content;
  const lastClose = content.lastIndexOf("</use_tool>");
  if (lastClose === -1) return content;
  return content.slice(0, lastClose + "</use_tool>".length).trim();
};
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/chat/tool-output.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/chat/tool-output.spec.js src/handlers/chat/tool-output.js
git commit -m "refactor: add shared tool output helpers"
```

### Task 2: Extract stream event parsing helper

**Files:**
- Create: `src/handlers/chat/stream-event.js`
- Test: `tests/unit/handlers/chat/stream-event.spec.js`

**Step 1: Write the failing test**

```javascript
import { describe, expect, it } from "vitest";
import { parseStreamEventLine } from "../../../../src/handlers/chat/stream-event.js";

const resolveChoiceIndexFromPayload = () => 2;
const extractMetadataFromPayload = () => ({ metadata: { project: "alpha" }, sources: ["prompt"] });

describe("stream event parsing", () => {
  it("parses event type and payload metadata", () => {
    const line = JSON.stringify({
      msg: {
        type: "codex/event/agent_message_delta",
        msg: { delta: { content: "hello" } },
      },
    });

    const parsed = parseStreamEventLine(line, {
      resolveChoiceIndexFromPayload,
      extractMetadataFromPayload,
      sanitizeMetadata: true,
    });

    expect(parsed.type).toBe("agent_message_delta");
    expect(parsed.messagePayload.delta.content).toBe("hello");
    expect(parsed.baseChoiceIndex).toBe(2);
    expect(parsed.metadataInfo.metadata.project).toBe("alpha");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/chat/stream-event.spec.js`
Expected: FAIL with "Cannot find module" for `stream-event.js`.

**Step 3: Write minimal implementation**

```javascript
export const parseStreamEventLine = (
  line,
  {
    resolveChoiceIndexFromPayload,
    extractMetadataFromPayload,
    sanitizeMetadata = false,
  } = {}
) => {
  if (!line || typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  let evt;
  try {
    evt = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const rawType = (evt && (evt.msg?.type || evt.type)) || "";
  const type = typeof rawType === "string" ? rawType.replace(/^codex\/event\//i, "") : "";
  const payload = evt && typeof evt === "object" ? evt : {};
  const params = payload.msg && typeof payload.msg === "object" ? payload.msg : payload;
  const messagePayload =
    params.msg && typeof params.msg === "object" ? params.msg : params;
  const metadataInfo =
    sanitizeMetadata && typeof extractMetadataFromPayload === "function"
      ? extractMetadataFromPayload(params)
      : null;
  const baseChoiceIndex =
    typeof resolveChoiceIndexFromPayload === "function"
      ? resolveChoiceIndexFromPayload(params, messagePayload)
      : null;

  return {
    type,
    payload,
    params,
    messagePayload,
    metadataInfo,
    baseChoiceIndex,
  };
};
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/chat/stream-event.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/chat/stream-event.spec.js src/handlers/chat/stream-event.js
git commit -m "refactor: add stream event parser"
```

### Task 3: Extract stream output coordinator

**Files:**
- Create: `src/handlers/chat/stream-output.js`
- Test: `tests/unit/handlers/chat/stream-output.spec.js`

**Step 1: Write the failing test**

```javascript
import { describe, expect, it, vi } from "vitest";
import { createStreamOutputCoordinator } from "../../../../src/handlers/chat/stream-output.js";

describe("stream output coordinator", () => {
  it("emits text delta in text mode", () => {
    const state = {
      emitted: "",
      forwardedUpTo: 0,
      scanPos: 0,
      lastToolEnd: -1,
      textualToolContentSeen: false,
      dropAssistantContentAfterTools: false,
      sentAny: false,
      hasToolEvidence: false,
      structuredCount: 0,
      forwardedToolCount: 0,
      toolBuffer: { active: false },
    };

    const sendChoiceDelta = vi.fn();
    const coordinator = createStreamOutputCoordinator({
      isObsidianOutput: false,
      outputMode: "text",
      stopAfterTools: false,
      suppressTailAfterTools: false,
      toolCallAggregator: { snapshot: () => [] },
      toolBufferMetrics: { start: vi.fn(), flush: vi.fn(), abort: vi.fn() },
      ensureChoiceState: () => state,
      sendChoiceDelta,
      emitTextualToolMetadata: vi.fn(() => false),
      scheduleStopAfterTools: vi.fn(),
      extractUseToolBlocks: () => ({ blocks: [], nextPos: 0 }),
      trackToolBufferOpen: () => -1,
      detectNestedToolBuffer: () => -1,
      clampEmittableIndex: (_buffer, _forwarded, end) => end,
      completeToolBuffer: vi.fn(),
      abortToolBuffer: () => ({ literal: "" }),
      shouldSkipBlock: () => false,
      trimTrailingTextAfterToolBlocks: (text) => text,
      buildObsidianXmlRecord: () => null,
      logToolBufferWarning: vi.fn(),
    });

    coordinator.appendContentSegment("hello", { choiceIndex: 0 });

    expect(sendChoiceDelta).toHaveBeenCalledWith(0, { content: "hello" });
    expect(state.emitted).toBe("hello");
    expect(state.sentAny).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/chat/stream-output.spec.js`
Expected: FAIL with "Cannot find module" for `stream-output.js`.

**Step 3: Write minimal implementation**

```javascript
const TOOL_XML_PREFIXES = ["<use_tool", "</use_tool"]; // shared literal for prefix matching

export const createStreamOutputCoordinator = ({
  isObsidianOutput,
  outputMode,
  stopAfterTools,
  suppressTailAfterTools,
  toolCallAggregator,
  toolBufferMetrics,
  ensureChoiceState,
  sendChoiceDelta,
  emitTextualToolMetadata,
  scheduleStopAfterTools,
  extractUseToolBlocks,
  trackToolBufferOpen,
  detectNestedToolBuffer,
  clampEmittableIndex,
  completeToolBuffer,
  abortToolBuffer,
  shouldSkipBlock,
  trimTrailingTextAfterToolBlocks,
  buildObsidianXmlRecord,
  logToolBufferWarning,
}) => {
  const hasTextualToolPrefix = (state, textDelta = "") => {
    if (!isObsidianOutput || !state) return false;
    if (state.toolBuffer?.active) return true;
    const emitted = typeof state.emitted === "string" ? state.emitted : "";
    const combined = `${emitted}${textDelta || ""}`;
    if (!combined) return false;
    if (combined.includes("<use_tool") || combined.includes("</use_tool")) return true;
    for (const prefix of TOOL_XML_PREFIXES) {
      const maxLen = Math.min(prefix.length, combined.length);
      for (let len = maxLen; len > 0; len -= 1) {
        const suffix = combined.slice(combined.length - len);
        if (prefix.startsWith(suffix)) {
          return true;
        }
      }
    }
    return false;
  };

  const findToolPrefixHoldback = (emitted, forwardedUpTo) => {
    if (!isObsidianOutput) return -1;
    const text = typeof emitted === "string" ? emitted : "";
    if (!text) return -1;
    const startFloor = Number.isInteger(forwardedUpTo) ? forwardedUpTo : 0;
    let holdbackStart = -1;
    for (const prefix of TOOL_XML_PREFIXES) {
      const maxLen = Math.min(prefix.length, text.length);
      for (let len = maxLen; len > 0; len -= 1) {
        const suffix = text.slice(text.length - len);
        if (prefix.startsWith(suffix)) {
          const start = text.length - len;
          if (start >= startFloor) {
            if (holdbackStart === -1 || start < holdbackStart) holdbackStart = start;
          }
          break;
        }
      }
    }
    return holdbackStart;
  };

  const emitToolContentChunk = (content, { source = "aggregator", choiceIndex = 0 } = {}) => {
    if (!isObsidianOutput) return false;
    const state = ensureChoiceState(choiceIndex);
    if (source === "aggregator" && state.textualToolContentSeen) return false;
    const text = typeof content === "string" ? content : "";
    if (!text) return false;
    emitTextualToolMetadata(choiceIndex, text);
    state.dropAssistantContentAfterTools = true;
    state.hasToolEvidence = true;
    sendChoiceDelta(choiceIndex, { content: text });
    state.sentAny = true;
    state.forwardedToolCount = Math.max(0, (state.forwardedToolCount || 0) + 1);
    if (source === "textual") state.textualToolContentSeen = true;
    scheduleStopAfterTools(choiceIndex);
    return true;
  };

  const flushActiveToolBuffer = (state, choiceIndex, reason = "abort") => {
    if (!isObsidianOutput) return false;
    if (!state?.toolBuffer?.active) return false;
    const emittedText = typeof state.emitted === "string" ? state.emitted : "";
    const lastClose = emittedText.lastIndexOf("</use_tool>");
    if (lastClose >= 0) {
      completeToolBuffer(state.toolBuffer, lastClose + "</use_tool>".length);
      return false;
    }
    const { literal } = abortToolBuffer(state.toolBuffer, state.emitted);
    toolBufferMetrics.abort({ output_mode: outputMode, reason });
    logToolBufferWarning(reason, { choice_index: choiceIndex });
    if (!literal) return false;
    const emitted = emitToolContentChunk(literal, { source: "textual", choiceIndex });
    if (emitted) {
      state.textualToolContentSeen = true;
      state.sentAny = true;
      state.forwardedUpTo = state.emitted.length;
      state.scanPos = state.emitted.length;
      state.dropAssistantContentAfterTools = true;
    }
    return emitted;
  };

  const flushDanglingToolBuffers = (reason = "finalize") => {
    if (!isObsidianOutput) return;
    const indices = Array.from(new Set([0]));
    indices.forEach((idx) => {
      const state = ensureChoiceState(idx);
      flushActiveToolBuffer(state, idx, reason);
    });
  };

  const emitAggregatorToolContent = (choiceIndex = 0, snapshot = null) => {
    if (!isObsidianOutput) return false;
    const state = ensureChoiceState(choiceIndex);
    if (state.textualToolContentSeen) {
      const size = Array.isArray(snapshot)
        ? snapshot.length
        : toolCallAggregator.snapshot({ choiceIndex }).length;
      state.forwardedToolCount = Math.max(state.forwardedToolCount || 0, size);
      return false;
    }
    try {
      const records = Array.isArray(snapshot)
        ? snapshot
        : toolCallAggregator.snapshot({ choiceIndex });
      let emitted = false;
      while (state.forwardedToolCount < records.length) {
        const ordinal = state.forwardedToolCount;
        const xml = buildObsidianXmlRecord(records[ordinal]);
        if (!xml) break;
        if (!emitToolContentChunk(xml, { source: "aggregator", choiceIndex })) break;
        emitted = true;
      }
      if (!emitted && state.forwardedToolCount > records.length) {
        state.forwardedToolCount = records.length;
      }
      return emitted;
    } catch {
      return false;
    }
  };

  const appendContentSegment = (text, { choiceIndex = 0 } = {}) => {
    const state = ensureChoiceState(choiceIndex);
    if (state.dropAssistantContentAfterTools) {
      scheduleStopAfterTools(choiceIndex);
      return;
    }
    if (!text) return;
    let emittedTextualTool = false;
    let appendText = text;
    if (state.emitted) {
      if (appendText.startsWith(state.emitted)) {
        appendText = appendText.slice(state.emitted.length);
      } else {
        const maxOverlap = Math.min(state.emitted.length, appendText.length);
        let overlap = 0;
        for (let i = maxOverlap; i > 0; i -= 1) {
          if (state.emitted.slice(state.emitted.length - i) === appendText.slice(0, i)) {
            overlap = i;
            break;
          }
        }
        appendText = appendText.slice(overlap);
        if (!appendText && state.emitted.includes(text)) {
          appendText = "";
        }
      }
    }
    if (!appendText) {
      scheduleStopAfterTools(choiceIndex);
      return;
    }
    state.emitted += appendText;
    if (isObsidianOutput) {
      const startedAt = trackToolBufferOpen(state.toolBuffer, state.emitted, state.forwardedUpTo);
      if (startedAt >= 0) {
        toolBufferMetrics.start({ output_mode: outputMode });
      }
      const nestedAt = detectNestedToolBuffer(state.toolBuffer, state.emitted);
      if (nestedAt >= 0) {
        flushActiveToolBuffer(state, choiceIndex, "nested_open");
      }
    }
    try {
      const { blocks, nextPos } = extractUseToolBlocks(state.emitted, state.scanPos);
      if (blocks && blocks.length) {
        state.hasToolEvidence = true;
        state.lastToolEnd = blocks[blocks.length - 1].end;
        state.scanPos = nextPos;
        for (const block of blocks) {
          if (block.end <= state.forwardedUpTo) continue;
          if (shouldSkipBlock(state.toolBuffer, block.end)) continue;
          const literal = state.emitted.slice(block.start, block.end);
          if (!literal) continue;
          if (isObsidianOutput) {
            if (emitToolContentChunk(literal, { source: "textual", choiceIndex })) {
              emittedTextualTool = true;
              state.forwardedUpTo = block.end;
              completeToolBuffer(state.toolBuffer, block.end);
              toolBufferMetrics.flush({ output_mode: outputMode });
              continue;
            }
          } else {
            state.forwardedUpTo = block.end;
            state.dropAssistantContentAfterTools = true;
            break;
          }
        }
      }
    } catch {}
    const limitTail = suppressTailAfterTools || stopAfterTools;
    if (emittedTextualTool && limitTail) {
      scheduleStopAfterTools(choiceIndex);
      return;
    }
    const allowUntil = clampEmittableIndex(
      state.toolBuffer,
      state.forwardedUpTo,
      state.emitted.length,
      state.lastToolEnd,
      limitTail
    );
    const holdbackStart = findToolPrefixHoldback(state.emitted, state.forwardedUpTo);
    const finalUntil = holdbackStart >= 0 ? Math.min(allowUntil, holdbackStart) : allowUntil;
    let segment = state.emitted.slice(state.forwardedUpTo, finalUntil);
    if (segment) {
      if (limitTail) {
        segment = trimTrailingTextAfterToolBlocks(segment);
      }
      let segmentHasToolBlock = false;
      if (segment && limitTail && state.textualToolContentSeen) {
        try {
          const { blocks } = extractUseToolBlocks(segment, 0);
          segmentHasToolBlock = Boolean(blocks && blocks.length);
        } catch {}
      }
      if (segment && limitTail && state.textualToolContentSeen && segmentHasToolBlock) {
        state.forwardedUpTo = finalUntil;
        scheduleStopAfterTools(choiceIndex);
        return;
      }
      if (segment) {
        sendChoiceDelta(choiceIndex, { content: segment });
      }
      state.sentAny = true;
      state.forwardedUpTo = finalUntil;
    }
    scheduleStopAfterTools(choiceIndex);
  };

  return {
    appendContentSegment,
    emitToolContentChunk,
    emitAggregatorToolContent,
    flushDanglingToolBuffers,
    hasTextualToolPrefix,
  };
};
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/chat/stream-output.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/unit/handlers/chat/stream-output.spec.js src/handlers/chat/stream-output.js
git commit -m "refactor: extract stream output coordinator"
```

### Task 4: Wire stream + nonstream to new helpers

**Files:**
- Modify: `src/handlers/chat/stream.js`
- Modify: `src/handlers/chat/nonstream.js`
- Modify: `tests/unit/handlers/chat/stream.spec.js`

**Step 1: Write the failing test**

Add a regression test that asserts `parseStreamEventLine` is called when a JSON event line arrives.

```javascript
// Inside tests/unit/handlers/chat/stream.spec.js
import { parseStreamEventLine } from "../../../../src/handlers/chat/stream-event.js";

vi.mock("../../../../src/handlers/chat/stream-event.js", () => ({
  parseStreamEventLine: vi.fn(() => null),
}));

it("routes event lines through parseStreamEventLine", async () => {
  const { postChatStream } = await import("../../../../src/handlers/chat/stream.js");
  const child = createMockChild();
  createJsonRpcChildAdapterMock.mockReturnValue(child);
  setupStreamGuardMock.mockReturnValue({ acquired: true, token: "token", release: vi.fn() });
  requireModelMock.mockReturnValue("gpt-test");
  acceptedModelIdsMock.mockReturnValue(new Set(["gpt-test"]));
  resolveOutputModeMock.mockReturnValue("text");
  validateOptionalChatParamsMock.mockReturnValue({ ok: true });
  normalizeModelMock.mockReturnValue({ requested: "gpt-test", effective: "gpt-test" });
  normalizeChatJsonRpcRequestMock.mockReturnValue({});
  buildBackendArgsMock.mockReturnValue([]);
  joinMessagesMock.mockReturnValue("hi");
  estTokensForMessagesMock.mockReturnValue(1);

  const req = { body: { messages: [{ role: "user", content: "hi" }], stream: true }, headers: {} };
  const res = { locals: {}, setHeader: vi.fn(), status: vi.fn(() => res), json: vi.fn(), on: vi.fn() };

  await postChatStream(req, res);
  child.stdout.emit("data", Buffer.from("{\"msg\":{\"type\":\"codex/event/task_complete\"}}\n"));

  expect(parseStreamEventLine).toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/handlers/chat/stream.spec.js`
Expected: FAIL because `parseStreamEventLine` is never called before wiring.

**Step 3: Write minimal implementation**

Update `src/handlers/chat/stream.js` imports and wiring:

```javascript
import { parseStreamEventLine } from "./stream-event.js";
import { createStreamOutputCoordinator } from "./stream-output.js";
import {
  buildObsidianXmlRecord,
  trimTrailingTextAfterToolBlocks,
} from "./tool-output.js";
```

Create the output coordinator once `toolCallAggregator` and helpers exist:

```javascript
const outputCoordinator = createStreamOutputCoordinator({
  isObsidianOutput,
  outputMode,
  stopAfterTools: Boolean(STOP_AFTER_TOOLS),
  suppressTailAfterTools: Boolean(SUPPRESS_TAIL_AFTER_TOOLS),
  toolCallAggregator,
  toolBufferMetrics,
  ensureChoiceState,
  sendChoiceDelta,
  emitTextualToolMetadata,
  scheduleStopAfterTools,
  extractUseToolBlocks,
  trackToolBufferOpen,
  detectNestedToolBuffer,
  clampEmittableIndex,
  completeToolBuffer,
  abortToolBuffer,
  shouldSkipBlock,
  trimTrailingTextAfterToolBlocks,
  buildObsidianXmlRecord,
  logToolBufferWarning,
});
```

Replace local calls with coordinator methods:

```javascript
outputCoordinator.appendContentSegment(textDelta, { choiceIndex });
outputCoordinator.emitAggregatorToolContent(choiceIndex, snapshot);
outputCoordinator.emitToolContentChunk(literal, { source: "textual", choiceIndex });
outputCoordinator.flushDanglingToolBuffers("finalize");
const hasTextualToolPrefix = outputCoordinator.hasTextualToolPrefix;
```

Replace the JSON parsing block in `child.stdout.on("data")` with the helper:

```javascript
const parsed = parseStreamEventLine(line, {
  resolveChoiceIndexFromPayload,
  extractMetadataFromPayload,
  sanitizeMetadata: SANITIZE_METADATA,
});
if (!parsed) continue;
const { type: t, payload, params, messagePayload, metadataInfo, baseChoiceIndex } = parsed;
```

Update `src/handlers/chat/nonstream.js` to use shared tool-output helpers and keep exports:

```javascript
import {
  getToolOutputOptions,
  normalizeToolCallSnapshot,
  buildCanonicalXml,
  extractTextualUseToolBlock,
  trimTrailingTextAfterToolBlocks,
} from "./tool-output.js";

const TOOL_OUTPUT_OPTIONS = getToolOutputOptions();

// Re-export for existing unit tests.
export { buildCanonicalXml, extractTextualUseToolBlock } from "./tool-output.js";
```

Then wire the options in `buildAssistantMessage`:

```javascript
const { records: toolCallRecords, truncated: toolCallsTruncated } =
  normalizeToolCallSnapshot(snapshot, TOOL_OUTPUT_OPTIONS);

assistantContent = isObsidianOutput
  ? buildCanonicalXml(toolCallRecords, TOOL_OUTPUT_OPTIONS) ||
    extractTextualUseToolBlock(choiceContent, TOOL_OUTPUT_OPTIONS) ||
    normalizedContent ||
    choiceContent
  : null;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/handlers/chat/stream.spec.js`
Expected: PASS

**Step 5: Commit**

```bash
git add src/handlers/chat/stream.js src/handlers/chat/nonstream.js tests/unit/handlers/chat/stream.spec.js
git commit -m "refactor: wire stream helpers"
```

## Tests to run

- `npx vitest run tests/unit/handlers/chat/tool-output.spec.js`
- `npx vitest run tests/unit/handlers/chat/stream-event.spec.js`
- `npx vitest run tests/unit/handlers/chat/stream-output.spec.js`
- `npx vitest run tests/unit/handlers/chat/stream.spec.js`
