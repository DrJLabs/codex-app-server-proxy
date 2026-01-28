# Task 01 — JSON-RPC `initialize` handshake (v2: `protocolVersion` + `capabilities`)

Reasoning:
- Assumption: upstream **Codex app-server** (and/or the deterministic local shim) has tightened its `initialize` schema to require `protocolVersion` and `capabilities`, similar to the MCP/LSP-style handshake.
- Goal: keep the proxy compatible with **newer v2 servers** without breaking **older v1 servers**, and make the change testable in CI.
- Constraint: this repo includes a deterministic JSON-RPC shim (`scripts/fake-codex-jsonrpc.js`) for CI/offline dev, so it must be updated alongside the real client path.

## Objective

Update the proxy’s JSON-RPC client initialization message to include:

- `protocolVersion: "v2"`
- `capabilities: { ... }` (start minimal; grow only when a server capability is required)
- preserve existing `clientInfo`

### Target payload

```json
{
  "method": "initialize",
  "id": 0,
  "params": {
    "clientInfo": { "name": "codex-app-server-proxy", "version": "x.y.z" },
    "protocolVersion": "v2",
    "capabilities": {}
  }
}
```

Then send:

```json
{ "method": "initialized", "params": {} }
```

Codex app-server expects `initialize` followed by `initialized` before any other requests.

## Spec anchors (original task file line refs)

These references map directly to the original attached task text so you can cross-check intent while implementing:

- **Objective / intent:** lines **3–7** (protocol v2 + capabilities; why it matters).
- **Search targets:** lines **11–17** (`buildInitializeParams`, `initialize`, `protocolVersion`, `capabilities`, bootstrap send path).
- **Core operations:** lines **21–30** (add fields to types + ensure they’re not stripped).
- **Example payload:** lines **33–52** (example `buildInitializeParams` returning v2 fields).
- **Validation checklist:** lines **57–65** (verify handshake + run /v1/responses with/without tools).
- **Deliverable:** lines **68–70** (PR + docs note).

## Best strategy (recommended)

### 1) Implement v2-first handshake with v1 fallback

**Why:** If some environments still run an older app-server that rejects unknown fields, v2-only can break. A v2-first attempt plus a targeted fallback preserves compatibility without requiring users to set flags.

**Decision rule:** Retry with v1 params **only** when the error is clearly “invalid params / unknown field / schema mismatch” (avoid retrying on auth errors, transport errors, etc.).

#### Suggested helper: `initializeWithFallback()`

```ts
type ClientInfo = { name: string; version: string; title?: string };

type InitializeParamsV2 = {
  clientInfo: ClientInfo;
  protocolVersion: "v2";
  capabilities: Record<string, unknown>;
};

type InitializeParamsV1 = {
  clientInfo: ClientInfo;
};

function isCompatInitError(err: unknown): boolean {
  // Keep this conservative. Match your actual error shape.
  const msg = String((err as any)?.message ?? err);
  return (
    /invalid params/i.test(msg) ||
    /unknown field/i.test(msg) ||
    /unrecognized.*field/i.test(msg) ||
    /schema/i.test(msg)
  );
}

export async function initializeWithFallback(
  rpc: { request(method: string, params: any, id?: number): Promise<any>; notify(method: string, params: any): void },
  clientInfo: ClientInfo,
  capabilities: Record<string, unknown> = {},
): Promise<{ negotiated: "v2" | "v1" }> {
  const v2: InitializeParamsV2 = { clientInfo, protocolVersion: "v2", capabilities };

  try {
    await rpc.request("initialize", v2, 0);
    rpc.notify("initialized", {});
    return { negotiated: "v2" };
  } catch (err) {
    if (!isCompatInitError(err)) throw err;

    const v1: InitializeParamsV1 = { clientInfo };
    await rpc.request("initialize", v1, 0);
    rpc.notify("initialized", {});
    return { negotiated: "v1" };
  }
}
```

**Notes:**
- Keep `capabilities` minimal (`{}`) until you confirm the server’s capabilities schema (avoid guessing keys).
- Log the negotiated version at debug level to simplify support triage.

### 2) Ensure the request builder does not strip new fields

Your task notes that the proxy may have a serializer/request-builder that whitelists fields (dropping unknown keys). The change must occur at the **source-of-truth builder** (e.g., a `buildInitializeParams()` function) and any schema/type definitions used for validation/serialization.

#### Suggested `buildInitializeParams()` shape

```ts
export function buildInitializeParams(args: {
  clientInfo: ClientInfo;
  protocolVersion?: "v2";
  capabilities?: Record<string, unknown>;
}): InitializeParamsV2 {
  return {
    clientInfo: args.clientInfo,
    protocolVersion: args.protocolVersion ?? "v2",
    capabilities: args.capabilities ?? {},
  };
}
```

### 3) Update the deterministic JSON-RPC shim to accept v2 params

The README explicitly calls out a deterministic JSON-RPC shim for CI/offline dev.  
If that shim currently validates `initialize.params` strictly, it must accept `protocolVersion` and `capabilities` (and ideally echo them back in the `initialize` result if the real server does).

#### Example: permissive shim-side validation

```js
// Pseudocode inside scripts/fake-codex-jsonrpc.js
function handleInitialize(msg) {
  const p = msg.params || {};
  if (!p.clientInfo || !p.clientInfo.name) {
    return jsonRpcError(msg.id, -32602, "initialize.params.clientInfo is required");
  }

  // v2 optional/required (depending on how strict you want the shim)
  const protocolVersion = p.protocolVersion ?? "v1";
  const capabilities = p.capabilities ?? {};

  return jsonRpcResult(msg.id, {
    serverInfo: { name: "fake-codex-jsonrpc", version: "0.0.0" },
    protocolVersion,
    capabilities,
  });
}
```

## Alternate strategies

### A) Flag-gated v2 handshake (fastest / least logic)

If you want to avoid heuristics around error matching, add an env var:

- `CODEX_RPC_PROTOCOL_VERSION=v2|v1` (default `v2`)

Pros:
- Simple behavior; no retries.
Cons:
- Requires users/ops to know they must flip a flag when connecting to older servers.

### B) Always send v2 (minimal patch, highest risk)

Pros:
- Smallest diff.
Cons:
- Breaks older servers if they reject unknown fields.

## Where to change (add exact file+line refs during implementation)

Because this task is intended to be executed inside the repo, the most reliable way to produce **exact** file+line refs is to pin them at implementation time using `rg -n` + `nl -ba`.

### Fast path to locate call-sites (copy/paste)

```bash
# 1) Find the initialize request and any builder function
rg -n 'method:\s*["\']initialize["\']|\binitialize\b\s*\(|buildInitializeParams|initialized' src scripts tests server.js

# 2) Find any schema/type that could be stripping fields
rg -n 'InitializeParams|clientInfo|params\s*:\s*\{|pick\(|omit\(|zod|ajv|schema|validate' src

# 3) Find the deterministic shim’s initialize handler
rg -n 'fake-codex-jsonrpc|handleInitialize|method\s*[:=]\s*["\']initialize["\']' scripts
```

### Files you already know exist (fill in line ranges)

- `server.js` — locate the JSON-RPC client wiring and the initial handshake send.
  - **Line refs:** `server.js:L___-L___`
- `scripts/fake-codex-jsonrpc.js` — accept/validate `protocolVersion` + `capabilities`.
  - **Line refs:** `scripts/fake-codex-jsonrpc.js:L___-L___`
- `src/**` — request builder/types/serialization; update whichever component constructs the `initialize` params.
  - **Line refs:** `src/**/____.ts:L___-L___`
- `tests/**` — add/adjust unit + integration tests.
  - **Line refs:** `tests/**/____.test.ts:L___-L___`

## Acceptance criteria

1. **Initialize payload includes v2 fields**
   - Outgoing JSON-RPC `initialize` request includes `params.protocolVersion === "v2"` and `params.capabilities` (object), alongside `params.clientInfo`.

2. **No silent field stripping**
   - Any request serialization layer preserves `protocolVersion` and `capabilities` keys end-to-end.

3. **Backward compatibility (if required)**
   - If a server rejects v2 params with a schema/invalid-params style error, the proxy retries with v1 params (`{ clientInfo }`) and still completes initialization.

4. **Shim compatibility**
   - `scripts/fake-codex-jsonrpc.js` accepts the v2 payload and does not fail strict validation.

5. **Logging/telemetry**
   - Debug logs (or structured logs) show negotiated init version (`v2` vs `v1`) and the server error when fallback occurs.

## Suggested tests

> Repo hints: there is a `tests/` directory and `vitest.config.ts`, so prefer Vitest unit tests + a small integration test that runs the shim.

### 1) Unit: `buildInitializeParams()` returns v2 fields

- Given `{ clientInfo }`, returns `{ clientInfo, protocolVersion: "v2", capabilities: {} }`.
- Given explicit capabilities, preserves them.

Example (Vitest):

```ts
import { describe, it, expect } from "vitest";
import { buildInitializeParams } from "../src/.../initialize"; // adjust path

describe("buildInitializeParams", () => {
  it("adds protocolVersion and capabilities by default", () => {
    const params = buildInitializeParams({
      clientInfo: { name: "codex-app-server-proxy", version: "test" },
    });
    expect(params.protocolVersion).toBe("v2");
    expect(params.capabilities).toEqual({});
    expect(params.clientInfo.name).toBe("codex-app-server-proxy");
  });
});
```

### 2) Unit: serializer does not strip keys

If you have a function that “normalizes” or “serializes” RPC params, assert the output includes the keys.

```ts
expect(serialize(params)).toMatchObject({
  protocolVersion: "v2",
  capabilities: {},
});
```

### 3) Integration: shim receives v2 initialize params

- Spawn `node scripts/fake-codex-jsonrpc.js` (or whatever harness exists).
- Connect via the same transport your proxy uses (stdio, TCP, etc.).
- Assert the shim logs or responds in a way that proves it received `protocolVersion` and `capabilities`.

### 4) Integration: fallback to v1 when shim rejects v2 (optional but valuable)

- Add a shim mode/flag (or a separate fixture shim) that rejects unknown fields.
- Ensure proxy retries with v1 and proceeds.

## Implementation checklist

- [ ] Update initialize params builder to include `protocolVersion` + `capabilities`
- [ ] Wire builder into the actual `initialize` send path
- [ ] Add v2-first + v1 fallback (or env-flag strategy)
- [ ] Update `scripts/fake-codex-jsonrpc.js`
- [ ] Add/adjust unit tests (Vitest)
- [ ] Add a minimal integration test for handshake against shim
- [ ] Update any docs referencing initialize payload (if present)

