# Subtask 02 — Conversation Bootstrap: `newConversation` params for V2

## Reasoning:
- **Assumptions**
  - `codex-app-server-proxy` constructs and sends a `newConversation` request (JSON-RPC or wrapper) during “conversation bootstrap”.
  - Upstream has introduced a **v2 schema** that adds *optional* conversation-level fields:
    - `baseInstructions`, `developerInstructions`
    - `userProfile`, `conversationContext`, `toolConfig`
  - The proxy must remain compatible with older upstreams that either **ignore** unknown keys or **reject** them.
- **Logic**
  - Solve this as **schema evolution**: add v2 fields as *pass-through* and gate emission behind a capability/version check.
  - Preserve prior semantics for existing fields (notably instructions + sandbox), because upstream validators are often strict.

---

## Recommended strategy (best path)
### 1) Centralize payload construction in a versioned builder
Create one “source of truth” function:

- `buildNewConversationParams(opts, serverCaps)` → `{ params, schemaVersionUsed }`

Rules:
- **V2**: emit v2-only keys only when provided.
- **V1**: omit v2-only keys. If you must preserve developer-instruction behavior, *merge* developer → base as a fallback.

> Why: strict upstreams can hard-fail on unknown keys.

### 2) Correct `sandbox` typing and instruction defaults
**Do not treat `sandbox` as boolean.** Public Codex payloads show `sandbox` as a **string mode** (e.g., `"danger-full-access"`), and `baseInstructions` is commonly `null` rather than `""`.  
Reference: openai/codex issue **#4541**, log payload in the description (view lines ~**218–221**).  

Implications for the proxy:
- `sandbox` should be an enum-like string type (e.g., `"read-only" | "workspace-write" | "danger-full-access"`).
- Instructions should default to **omitted** / `undefined` (or `null` if your proxy previously used null), **not** `""`.

### 3) Normalize conversation id from upstream responses
Implement a helper that accepts:
- `conversationId`
- `conversation_id`
(and returns a single internal `conversationId` string)

---

## Alternatives (only if needed)
### A) Always send v2 keys
Fast but risky: if older upstream rejects unknown keys, conversation start fails.

### B) Optimistic v2 then retry as v1 on failure
Works even without an explicit handshake, but adds a second request path and needs careful “don’t double-create tasks” handling.

---

## Where to look
You need **repo-specific** `path:line` references for the actual patch. Generate them locally and paste into the table below.

```bash
# 1) Who builds the request payload
rg -n "newConversation" -S .

# 2) The request/response types
rg -n "NewConversationParams|ConversationBootstrap|Conversation.*Bootstrap" -S .

# 3) Instruction mapping (system/developer → base/developer)
rg -n "baseInstructions|developerInstructions|system.*instructions|developer.*instructions" -S .

# 4) Response parsing (conversationId vs conversation_id)
rg -n "conversationId|conversation_id" -S .

# 5) Tool flags that might move into toolConfig
rg -n "includePlanTool|includeApplyPatchTool|applyPatchTool|toolConfig" -S .
```

### Fill-in table (replace placeholders with real hits)
| Concern | File + line(s) to edit | Notes |
|---|---|---|
| `NewConversationParams` type definition | `PATH:LINE-LINE` | Add v2 optional fields + fix `sandbox` type |
| Builder for `newConversation` params | `PATH:LINE-LINE` | Centralize mapping + gating |
| Conversation bootstrap call site | `PATH:LINE-LINE` | Ensure builder is used consistently |
| Response parsing / conversation id normalization | `PATH:LINE-LINE` | Support both `conversationId` and `conversation_id` |

---

## V2 schema deltas to support
### New optional fields (conversation scope)
Add as optional pass-through:

- `baseInstructions?: string | null`
- `developerInstructions?: string | null`
- `userProfile?: unknown`
- `conversationContext?: unknown`
- `toolConfig?: unknown`

Recommendation: keep `userProfile`, `conversationContext`, and `toolConfig` typed as `unknown`/`Record<string, unknown>` initially to avoid overfitting to a moving schema.

### Existing fields to preserve (typical)
From public `newConversation` payloads, expect at least:
- `cwd`, `model`, `config`, `approvalPolicy`, `sandbox`, `profile`
- optional tool toggles like `includePlanTool`, `includeApplyPatchTool`  
(Reference: openai/codex issue **#4541**, lines ~**218–221**.)

---

## Suggested patch (TypeScript) — drop-in patterns

### 1) Types: `rpcTypes.ts` (or equivalent)
```ts
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";

/**
 * Keep forward-compatible: upstream may expand toolConfig/userProfile shapes.
 */
export interface NewConversationParams {
  // existing/common
  cwd?: string;
  model?: string | null;
  config?: Record<string, unknown>;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxMode;
  profile?: string | null;

  // tool toggles (keep if still used by your upstream)
  includePlanTool?: boolean;
  includeApplyPatchTool?: boolean | null;

  // v2 additions (pass-through)
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  userProfile?: unknown;
  conversationContext?: unknown;
  toolConfig?: unknown;
}

export interface ServerCapabilities {
  // map this from your handshake/init response
  schemaVersion?: 1 | 2;
}
```

### 2) Builder: `conversationBootstrap.ts` (or equivalent)
```ts
import type { NewConversationParams, ServerCapabilities, SandboxMode } from "./rpcTypes";

// Avoid sending undefined keys (important for strict upstream validators)
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function mergeInstructionsForV1(base?: string | null, dev?: string | null): string | null | undefined {
  const parts = [base, dev].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  if (parts.length === 0) return base ?? dev; // preserve null/undefined semantics
  return parts.join("\n\n");
}

export function buildNewConversationParams(
  opts: {
    cwd?: string;
    model?: string | null;
    config?: Record<string, unknown>;
    approvalPolicy?: NewConversationParams["approvalPolicy"];
    sandbox?: SandboxMode;
    profile?: string | null;

    // instructions
    baseInstructions?: string | null;
    developerInstructions?: string | null;

    // v2 extras
    userProfile?: unknown;
    conversationContext?: unknown;
    toolConfig?: unknown;

    // legacy toggles
    includePlanTool?: boolean;
    includeApplyPatchTool?: boolean | null;
  },
  caps: ServerCapabilities
): { params: NewConversationParams; schemaVersionUsed: 1 | 2 } {
  const schemaVersionUsed: 1 | 2 = caps.schemaVersion === 2 ? 2 : 1;

  // V1 baseline (safe for older upstreams)
  const paramsV1: NewConversationParams = compact({
    cwd: opts.cwd,
    model: opts.model,
    config: opts.config,
    approvalPolicy: opts.approvalPolicy,
    sandbox: opts.sandbox,
    profile: opts.profile,

    includePlanTool: opts.includePlanTool,
    includeApplyPatchTool: opts.includeApplyPatchTool,

    // V1 fallback behavior
    baseInstructions: mergeInstructionsForV1(opts.baseInstructions, opts.developerInstructions),
  });

  if (schemaVersionUsed === 1) return { params: paramsV1, schemaVersionUsed };

  // V2: separation + pass-through extras
  const paramsV2: NewConversationParams = compact({
    ...paramsV1,
    baseInstructions: opts.baseInstructions,
    developerInstructions: opts.developerInstructions,
    userProfile: opts.userProfile,
    conversationContext: opts.conversationContext,
    toolConfig: opts.toolConfig,
  });

  return { params: paramsV2, schemaVersionUsed };
}
```

### 3) Response normalization helper
```ts
export function normalizeConversationId(result: any): string | undefined {
  return result?.conversationId ?? result?.conversation_id ?? result?.conversation?.id;
}
```

---

## Acceptance criteria
### Functional
- **V2 upstream**: `newConversation` succeeds when any subset of v2 optional fields is provided:
  - `baseInstructions`, `developerInstructions`, `userProfile`, `conversationContext`, `toolConfig`
- **V1 upstream**:
  - Conversation creation still succeeds.
  - No v2-only keys are emitted.
  - If developer instructions are present, behavior is preserved via merge-into-base fallback (or explicitly documented if you choose to drop dev instructions in v1).
- **Instruction semantics**
  - system → `baseInstructions`
  - developer → `developerInstructions` (v2) or merged (v1 fallback)
  - no accidental empty-string injection
- **Response parsing**
  - Both `conversationId` and `conversation_id` are accepted and normalized.

### Non-functional
- No regression for “no-tools” conversations.
- Debug logging (if present) indicates schema v1 vs v2 used.

---

## Suggested tests
Use your repo’s existing runner (Jest/Vitest/node:test).

### Unit tests: `buildNewConversationParams`
1. **V1 gating**
   - `caps.schemaVersion = 1` → no `developerInstructions`, `userProfile`, `conversationContext`, `toolConfig` keys.
2. **V1 merge behavior**
   - base `"A"`, dev `"B"` → `baseInstructions === "A\n\nB"` and no `developerInstructions`.
3. **V2 separation**
   - `caps.schemaVersion = 2` → keep both `baseInstructions` + `developerInstructions`.
4. **Compaction**
   - `undefined` inputs are absent from serialized JSON.
5. **Sandbox modes**
   - Ensure only allowed string modes can be set (runtime validation optional).

### Unit tests: `normalizeConversationId`
- Accept `{ conversationId: "abc" }`
- Accept `{ conversation_id: "abc" }`
- Accept `{ conversation: { id: "abc" } }` if relevant.

### Contract snapshot test (recommended)
- Snapshot v1 payload vs v2 payload for the same input.

### Integration test (if you already mock upstream)
- Mock v1 strict mode (reject unknown keys) to verify gating.
- Mock v2 mode to verify new keys are accepted and forwarded.

---

## Deliverable
- Updated `NewConversationParams` type(s) + builder + response id normalization.
- Tests covering v1/v2 gating, instruction mapping, sandbox typing, and id normalization.
- Documentation note describing the instruction mapping and v1 fallback behavior.
