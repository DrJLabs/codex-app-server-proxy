# Subtask 03 — Request Path: `sendUserTurn` vs `sendUserMessage` (V2 streaming refactor)

## Reasoning:
- **Assumptions**
  - `codex-app-server-proxy` speaks to a Codex app-server over **JSON-RPC**, and exposes an **OpenAI-compatible** HTTP surface (e.g., `/v1/responses`, possibly `/v1/chat/completions`).
  - The proxy currently uses (or still contains) a `sendUserTurn` path to kick off a “turn”, but **v2 semantics treat `sendUserMessage` as the canonical “start a turn” submission**, with `sendUserTurn` being legacy/compat-only.
  - Streaming to the HTTP client is implemented via SSE, and the app-server provides an event stream (typically via a “listener/subscription” RPC + notifications) that the proxy forwards.
- **Logic**
  - The lowest-risk refactor is: **keep the existing event subscription/streaming machinery unchanged**, and swap only the “submit user input” method from `sendUserTurn` → `sendUserMessage` behind a capability gate/feature flag.
  - Tools/tool_choice/parallel_tool_calls must be **forwarded as metadata** (if the app-server supports per-request tool injection) but the proxy must **never execute tools**—only surface tool calls back to the caller.

---

## Objective
Align request flow with v2 semantics:
- Prefer the **v2-supported submission** mechanism: `sendUserMessage` (streaming handled via the existing event stream/subscription pattern).
- Preserve backward compatibility (temporary) via a **feature flag + runtime fallback**.
- Ensure per-request **tool injection + tool_choice + parallel_tool_calls** are forwarded (but tool execution remains client-side).

---

## Protocol references (ground truth fields & JSON shapes)

> These line references are to the upstream protocol types so the proxy implementation can be validated against actual wire shapes.

### `SendUserMessageParams` vs `SendUserTurnParams`
- `SendUserMessageParams` is minimal: `{ conversationId, items }`  
  - `codex-app-server-protocol/src/protocol/v1.rs` **L846–L849**
- `SendUserTurnParams` includes per-turn overrides (cwd/policies/model/etc.)  
  - `codex-app-server-protocol/src/protocol/v1.rs` **L852–L861**
- `SendUserMessageResponse` and `SendUserTurnResponse` are empty structs (turn output is delivered via events/notifications)  
  - `SendUserTurnResponse`: **L862–L865**  
  - `SendUserMessageResponse`: **L877–L880**
- `InputItem` enum wire format uses `type` + `data` (serde `tag`/`content`)  
  - `InputItem`: **L893–L900**
- Listener/subscription params (likely the existing streaming backbone)  
  - `AddConversationListenerParams`: **L882–L886**
- Interrupt support (needed for client disconnect + AbortController semantics)  
  - `InterruptConversationParams`: **L868–L875**

---

## Where to look in `codex-app-server-proxy` (replace with exact file+line refs in your repo)

### Search strings
- `sendUserTurn` / `SendUserTurnParams`
- `sendUserMessage` / `SendUserMessageParams`
- `addConversationListener` / `subscription_id` / `experimental_raw_events`
- `interruptConversation`
- `createChatRequest` / `createResponsesRequest` / `/v1/responses`
- `SSE` / `text/event-stream` / `EventSource` / `res.write`

### Recommended commands (to capture **real** file:line refs)
```bash
# 1) Find the submission call sites
rg -n "sendUserTurn\b|SendUserTurnParams\b" .
rg -n "sendUserMessage\b|SendUserMessageParams\b" .

# 2) Find the streaming backbone
rg -n "addConversationListener\b|RemoveConversationListener\b|subscription_id\b" .

# 3) Find tools/tool_choice plumbing
rg -n "toolsPayload\b|tool_choice\b|parallel_tool_calls\b|parallelToolCalls\b" .

# 4) Find interrupt/cancel behavior
rg -n "interruptConversation\b|AbortController\b|req\.on\('close'\)" .
```

> **Deliverable requirement**: After running the searches above, paste the exact file:line ranges into the “Patch map” section below.

---

## Patch map (fill in exact file+line refs after inventory)

### A) HTTP request handler path
- **File:** `[...]`  
  **Lines:** `[...]`  
  **Purpose:** Receives `/v1/responses` (and/or `/v1/chat/completions`) and chooses the app-server submission path.

### B) JSON-RPC client wrapper
- **File:** `[...]`  
  **Lines:** `[...]`  
  **Purpose:** Owns `rpc.call(method, params)` and any response/notification routing.

### C) Streaming bridge (app-server events → SSE)
- **File:** `[...]`  
  **Lines:** `[...]`  
  **Purpose:** Translates app-server notifications into OpenAI-compatible SSE events.

### D) Tools mapping
- **File:** `[...]`  
  **Lines:** `[...]`  
  **Purpose:** Maps OpenAI request `{ tools, tool_choice, parallel_tool_calls }` → app-server tool payload (if supported).

---

## Recommended implementation strategy (best option)

### 1) Introduce a single “submit user input” adapter
Create a single internal function that the HTTP handlers call:

- `submitUserInput({ conversationId, items, stream, toolSpec, turnOverrides })`
- It chooses the method (`sendUserMessage` vs `sendUserTurn`) based on:
  1) **Feature flag** (opt-in at first), and
  2) **Runtime fallback** (retry on “method not found” / “invalid params”)

**Key point:** the rest of the pipeline (listener setup, SSE forwarding) stays the same.

#### Example (TypeScript)
```ts
type InputItem =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { imageUrl: string } }
  | { type: "localImage"; data: { path: string } };

// Narrowly model only what you actually send.
// Keep experimental fields optional so you can omit them if the server rejects them.
type SendUserMessageParams = {
  conversationId: string;
  items: InputItem[];
  // Optional/experimental v2 extensions (ONLY include if negotiated/supported):
  stream?: boolean;
  tools?: {
    definitions?: unknown[];
    choice?: unknown;
    parallelToolCalls?: boolean;
  };
};

type SendUserTurnParams = {
  conversationId: string;
  items: InputItem[];
  cwd: string;
  approvalPolicy: unknown;
  sandboxPolicy: unknown;
  model: string;
  effort?: unknown;
  summary: unknown;
};

async function submitUserInput(
  rpc: { call: (m: string, p: any) => Promise<any> },
  args: {
    conversationId: string;
    items: InputItem[];
    stream: boolean;
    tools?: SendUserMessageParams["tools"];
    // If your proxy currently supports per-request overrides, keep them here for sendUserTurn fallback:
    turnOverrides?: Partial<Omit<SendUserTurnParams, "conversationId" | "items">>;
    flags: { preferSendUserMessage: boolean };
  },
) {
  // Prefer v2 path.
  if (args.flags.preferSendUserMessage) {
    const params: SendUserMessageParams = {
      conversationId: args.conversationId,
      items: args.items,
      ...(args.stream ? { stream: true } : {}),
      ...(args.tools ? { tools: args.tools } : {}),
    };

    try {
      return await rpc.call("sendUserMessage", params);
    } catch (err: any) {
      // If server doesn’t recognize fields/method, fall through to legacy.
      // (Match your app-server error shape here.)
      if (!isRetryableProtocolMismatch(err)) throw err;
    }
  }

  // Legacy/compat path: sendUserTurn
  if (!args.turnOverrides) {
    throw new Error("sendUserTurn fallback requires turnOverrides (cwd/policies/model/summary).");
  }

  const legacyParams: SendUserTurnParams = {
    conversationId: args.conversationId,
    items: args.items,
    cwd: String(args.turnOverrides.cwd ?? process.cwd()),
    approvalPolicy: args.turnOverrides.approvalPolicy ?? "ask",
    sandboxPolicy: args.turnOverrides.sandboxPolicy ?? "default",
    model: String(args.turnOverrides.model ?? "gpt-5-codex"),
    effort: args.turnOverrides.effort,
    summary: args.turnOverrides.summary ?? "auto",
  };

  return rpc.call("sendUserTurn", legacyParams);
}

function isRetryableProtocolMismatch(err: any): boolean {
  const msg = String(err?.message ?? "");
  return (
    msg.includes("Method not found") ||
    msg.includes("Unknown method") ||
    msg.includes("invalid params") ||
    msg.includes("unknown field")
  );
}
```

**Why this is optimized:** You isolate risk to one small compatibility seam and avoid refactoring the rest of your streaming pipeline.

---

### 2) Streaming: keep the subscription-first pattern
For streaming requests, do **not** depend on `sendUserMessage(stream=true)` unless you have confirmed the app-server supports it. Instead:

1. **Add listener/subscription** for the conversation.
2. **Submit user input** (`sendUserMessage` preferred).
3. **Forward notifications** as SSE deltas.
4. **On client disconnect**, call `interruptConversation`.

#### Example SSE guard for disconnect
```ts
function wireAbortToInterrupt(req: any, rpc: any, conversationId: string) {
  const onClose = async () => {
    try {
      await rpc.call("interruptConversation", { conversationId });
    } catch {
      // swallow: client is gone; best-effort interrupt
    }
  };
  req.on("close", onClose);
  req.on("aborted", onClose);
}
```

---

### 3) Tools forwarding (without proxy executing tools)
**Goal:** if a caller sends tools/tool_choice/parallel_tool_calls, preserve those semantics.

Because app-server tool schemas can vary, implement a **typed mapping layer** that:
- Accepts OpenAI `/v1/responses` request fields.
- Produces an internal canonical `ToolSpec`.
- Then maps that to the app-server’s expected shape (v2 if supported; otherwise store for later or ignore with a controlled warning).

#### Example canonicalization
```ts
type ResponsesTool = unknown; // Replace with your request schema
type ToolChoice = "auto" | "none" | { type: "function"; function: { name: string } };

type CanonicalToolSpec = {
  definitions: ResponsesTool[];
  choice?: ToolChoice;
  parallelToolCalls?: boolean;
};

function canonicalizeTools(req: any): CanonicalToolSpec | undefined {
  const hasAny =
    (Array.isArray(req.tools) && req.tools.length > 0) ||
    req.tool_choice != null ||
    req.parallel_tool_calls != null;

  if (!hasAny) return undefined;

  return {
    definitions: Array.isArray(req.tools) ? req.tools : [],
    choice: req.tool_choice,
    parallelToolCalls: req.parallel_tool_calls,
  };
}
```

#### Example mapping into `sendUserMessage` params
```ts
function mapCanonicalToolsToAppServer(spec?: CanonicalToolSpec) {
  if (!spec) return undefined;
  return {
    definitions: spec.definitions,
    choice: spec.choice,
    parallelToolCalls: spec.parallelToolCalls,
  };
}
```

---

### 4) Tool-call handling behavior in streaming
When the app-server emits a **tool call** item/event:
- **Emit** an OpenAI-compatible “tool_call” output item to the client.
- **Stop streaming** further assistant output for that request.
- Leave it to the client to call back with tool results in a follow-up request.

#### Suggested behavior (SSE pseudocode)
```ts
function onAppServerEvent(ev: any, sse: any, state: any) {
  if (ev.type === "tool_call") {
    sse.send("response.output_item.added", { item: mapToolCall(ev) });
    sse.send("response.completed", { status: "requires_action" });
    state.close(); // end SSE stream
    return;
  }

  // Normal token deltas
  if (ev.type === "assistant_text_delta") {
    sse.send("response.output_text.delta", { delta: ev.delta });
  }
}
```

---

## Alternative strategies (only if needed)

### Alternative A — Keep `sendUserTurn` as the default, add `sendUserMessage` only for v2 servers
Use this if you discover (via real traffic) that older app-server versions reject `sendUserMessage` for turns or don’t emit equivalent streaming events.

### Alternative B — Two-step compatibility shim
If the legacy path sets per-turn policy/model via `sendUserTurn`, but v2 wants session-level config:
- On the first request, set config via `newConversation` or a `setDefaultModel`/config RPC (if present),
- Then only use `sendUserMessage` for subsequent turns.

---

## Acceptance criteria
1. **Streaming parity**
   - A streaming `/v1/responses` call produces SSE deltas as before (no missing/duplicated chunks).
2. **Non-streaming parity**
   - A non-streaming request returns a complete JSON response consistent with the proxy’s previous behavior.
3. **Correct method selection**
   - With the feature flag enabled, proxy prefers `sendUserMessage`.
   - If the app-server rejects the method/params, proxy **falls back** to `sendUserTurn` (and logs a structured warning).
4. **Tools forwarding**
   - If request includes `tools`, `tool_choice`, `parallel_tool_calls`, they are forwarded (or explicitly rejected with a clear error), and never silently dropped.
5. **Tool calls are surfaced, not executed**
   - When a tool call is produced, the proxy returns it to the client and ends the stream with a “requires_action”-style termination.
6. **Cancellation works**
   - Client disconnect triggers `interruptConversation` best-effort.
7. **No double-send**
   - No duplicate “assistant start” / “completed” events due to old two-step flows.

---

## Suggested tests (add/expand as needed)

### Unit tests
- **Tool mapping**
  - Given a `/v1/responses` request with `tools`, `tool_choice`, `parallel_tool_calls`, verify the canonicalized tool spec and the mapped app-server payload.
- **InputItem serialization**
  - Given user text/image inputs, verify the JSON produced matches the `InputItem` `type`+`data` shape (Text/Image/LocalImage).
- **Method selection fallback**
  - Simulate `rpc.call("sendUserMessage")` throwing “method not found”; verify proxy calls `sendUserTurn` next.

### Integration tests (recommended: mock JSON-RPC app-server)
Build a tiny in-process JSON-RPC stub that:
- Accepts `addConversationListener`, returns a subscription id.
- On `sendUserMessage` or `sendUserTurn`, emits a scripted sequence of notifications:
  - text deltas
  - optional tool call event
  - completed

Test matrix:
1. `stream=true` + no tools → emits deltas → completes
2. `stream=false` + no tools → returns aggregated response
3. `stream=true` + tools, tool call occurs → emits tool_call → terminates stream with requires_action
4. client disconnect mid-stream → proxy calls `interruptConversation`

### Regression test
- Existing `sendUserTurn` path remains functional when the feature flag is off.

---

## Rollout plan
1. **Phase 1 (opt-in)**
   - Add `preferSendUserMessage` flag (env var/config).
   - Enable only in CI or a dev environment.
2. **Phase 2 (default-on with fallback)**
   - Default to `sendUserMessage` while retaining automatic fallback.
3. **Phase 3 (cleanup)**
   - Remove `sendUserTurn` usage when all supported app-server versions have v2 semantics.

---

## Deliverable
- Updated request pipeline (submission adapter + wiring), plus test coverage from the matrix above.
- This doc updated with **real file:line references** in the Patch map section.
