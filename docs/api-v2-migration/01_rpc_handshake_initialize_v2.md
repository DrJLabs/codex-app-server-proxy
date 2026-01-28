# Task 01 — JSON-RPC `initialize` handshake (v2: `protocolVersion` + `capabilities`)

Reasoning:
- Assumption (verified vs repo): this proxy already *supports* `protocolVersion` + `capabilities` in the JSON-RPC schema layer, but it does **not** currently send them during the worker handshake.
- Goal: explicitly opt into v2 behavior when talking to newer Codex app-server workers **without** breaking older workers that may reject unknown fields.
- Constraint: the repo includes a deterministic stdio worker shim (`scripts/fake-codex-jsonrpc.js`) used by tests; any handshake change must remain compatible (or be updated in lockstep).

## Objective

Update the proxy’s JSON-RPC client initialization request (sent by the transport) to include:

- `protocolVersion: "v2"`
- `capabilities: {}` (start minimal; grow only when a server capability is required)
- preserve existing `clientInfo`

### Target payload (what the worker should receive)

> Note: the real proxy uses an incrementing numeric RPC id (see `#nextRpcId()`); the exact number is not important.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "codex-app-server-proxy", "version": "x.y.z" },
    "protocolVersion": "v2",
    "capabilities": {}
  }
}
```

### Important compatibility detail (repo-specific)

`buildInitializeParams()` intentionally emits **camelCase + snake_case mirrors** for compatibility with multiple worker versions:

- `clientInfo` **and** `client_info`
- `protocolVersion` **and** `protocol_version` (when provided)

This is implemented in `src/lib/json-rpc/schema.ts` inside `buildInitializeParams()`.

## What’s currently true in the codebase (baseline)

### Schema already supports v2 fields (but does not default them)

- `InitializeParams` includes optional `capabilities` and `protocolVersion`.
- `buildInitializeParams(options)` only includes these keys when `options.capabilities !== undefined` and/or `options.protocolVersion` is truthy.
- There are existing unit tests that assert **no default** protocol version is set when not provided.

Implication: **do not** change the builder to default to `"v2"` unless you also update the unit tests and any downstream assumptions. The safest change is to set v2 defaults at the **call site** that performs the handshake.

### Transport currently sends `initialize` with clientInfo only

Handshake is performed in `src/services/transport/index.js` inside `ensureHandshake()`, currently:

```js
const initParams = buildInitializeParams({ clientInfo: DEFAULT_CLIENT_INFO });
this.#write({ jsonrpc: "2.0", id: rpcId, method: "initialize", params: initParams });
```

## Best strategy (recommended)

### 1) Set v2 params at the handshake call site (minimal diff, aligned with current tests)

**Change:** update the `buildInitializeParams()` call in `ensureHandshake()` to pass:

- `protocolVersion: "v2"`
- `capabilities: {}`

This keeps the builder behavior unchanged (and keeps existing unit tests valid), while achieving the goal that the proxy negotiates v2 during actual runtime handshake.

#### Suggested patch shape (transport)

```js
const initParams = buildInitializeParams({
  clientInfo: DEFAULT_CLIENT_INFO,
  protocolVersion: "v2",
  capabilities: {},
});
```

### 2) Optional: v2-first with v1 fallback (only if you must support older workers)

**Reality check vs repo:** The transport wraps RPC errors into `TransportError` inside `#handleRpcResponse()`. The error you can reliably match is:

- `err.code` (string/number, from JSON-RPC error code)
- `err.message` (string)

**Decision rule (conservative):** retry with v1 only if the worker indicates a schema/params failure, e.g.:

- `code === -32602` (JSON-RPC “Invalid params”) **or**
- message contains `invalid params`, `unknown field`, `schema`

**Fallback behavior:** retry with *no* `protocolVersion` and *no* `capabilities` keys (omit them entirely). Do **not** send `capabilities: null` because that still sends the field.

#### Minimal approach (no big refactor)

Instead of a full rewrite of `ensureHandshake()`, introduce a small helper inside it (or as a private method) that attempts initialize with a given params object, and wire a retry when the failure matches the compat condition.

Pseudo-structure:

```js
const tryInitialize = (params) => new Promise((resolve, reject) => {
  // register pending for rpcId, set timeout, write request, resolve/reject on response
});

try {
  return await tryInitialize(v2Params);
} catch (err) {
  if (!isCompatInitError(err)) throw err;
  return await tryInitialize(v1Params /* clientInfo only */);
}
```

### 3) Do NOT send `"initialized"` in this repo (unless you add protocol support)

Your suggested plan included an `"initialized"` notification after `"initialize"`.

**Repo verification:** this proxy’s JSON-RPC method set does **not** include `"initialized"` (see `JsonRpcMethod` union in `src/lib/json-rpc/schema.ts`), and the deterministic shim returns `-32601` for unknown methods.

So sending `"initialized"` would break the shim (and potentially older real workers). If upstream later requires `"initialized"`, that change must be done deliberately by:
- adding it to the schema/types
- teaching the shim to accept it
- validating the upstream server actually requires it

## Shim compatibility and testability

### Current state (shim)

- `scripts/fake-codex-jsonrpc.js` accepts the `initialize` method and does not validate params strictly.
- It can emit captured RPC payloads to **stderr** when `FAKE_CODEX_CAPTURE_RPCS=true`.

### Recommended testing approach (least invasive)

Prefer using the existing capture mechanism (stderr) to assert the outgoing handshake contains `protocolVersion:"v2"` and `capabilities:{}` — no need to modify shim behavior.

### Optional shim enhancement (if you want easier assertions)

Add `receivedParams: params` to the initialize **result** payload to simplify assertions:

```js
result: {
  advertised_models: ["codex-5"],
  capabilities: { tools: {} },
  receivedParams: params,
}
```

This is not required for functionality, but makes integration tests simpler.

## Where to change (exact file+line refs from current repo snapshot)

### Handshake call site (actual behavior)

- `src/services/transport/index.js`
  - `ensureHandshake()` starts around `L263`
  - `buildInitializeParams({ clientInfo: DEFAULT_CLIENT_INFO })` occurs at `L329`
  - request write occurs at `L338–L343`

### Schema support for `InitializeParams`

- `src/lib/json-rpc/schema.ts`
  - `InitializeParams` interface: `L66–L70`
  - `buildInitializeParams()` implementation: `L332–L356`

### Shim initialize handler

- `scripts/fake-codex-jsonrpc.js`
  - `case "initialize"`: `L248–L279`
  - capture emission uses `FAKE_CODEX_CAPTURE_RPCS`: `L98–L104`

### Existing tests you must keep in mind

- `tests/unit/json-rpc-schema.helpers.spec.ts`
  - verifies `buildInitializeParams` sets protocol/capabilities when provided: `L128–L138`
  - verifies defaults do **not** implicitly set protocol: `L140–L152`
- `tests/unit/json-rpc-schema.test.ts`
  - expects `protocolVersion` undefined when not provided: `L434–L440`
- `tests/integration/json-rpc-schema-validation.int.test.js`
  - already builds `InitializeParams` with `capabilities: {}` but no `protocolVersion`: `L85–L89`

## Acceptance criteria

1. **Initialize payload includes v2 fields (runtime handshake)**
   - Outgoing JSON-RPC `initialize` request sent by the proxy includes:
     - `protocolVersion === "v2"`
     - `capabilities` is an object (default `{}`)
     - `clientInfo` remains present

2. **No silent field stripping**
   - The JSON written to worker stdio preserves both keys in the outbound payload.

3. **Backward compatibility (if implemented)**
   - If a worker rejects v2 params with a schema/invalid-params style error, the proxy retries with v1 params (clientInfo only) and still completes initialization.

4. **Shim compatibility**
   - The deterministic shim continues to work with the new handshake payload (no `-32601` errors due to unexpected post-initialize methods).

5. **Logging/telemetry**
   - When fallback triggers, logs show: negotiated version (`v2` vs `v1`) and the error cause.

## Suggested tests (aligned to existing repo patterns)

### 1) Unit: keep existing schema tests (no changes expected)

Do **not** change builder defaults unless you intentionally update:
- `tests/unit/json-rpc-schema.test.ts` (`protocolVersion` currently expected to be undefined when not provided).

### 2) New integration: assert transport sends v2 handshake params (via shim capture)

Create a new test like:

- `tests/integration/json-rpc-handshake.int.test.js`

Approach:
1. Spawn `node scripts/fake-codex-jsonrpc.js` with env:
   - `CODEX_WORKER_SUPERVISED=true`
   - `FAKE_CODEX_CAPTURE_RPCS=true`
2. Start the transport (or the minimal component that triggers `ensureHandshake()`).
3. Read shim **stderr**, parse capture payload, assert `initialize.params.protocolVersion === "v2"` and `capabilities` is `{}`.

### 3) Optional integration: fallback path (if implemented)

If you implement fallback, you’ll need a shim mode that rejects v2. Add one env flag, e.g.:

- `FAKE_CODEX_REJECT_PROTOCOL_V2=true`

Behavior: in initialize handler, if `params.protocolVersion === "v2"`, return JSON-RPC error `-32602` (invalid params). Then your test asserts the proxy retries without those keys.

## Implementation checklist

- [ ] **Src:** Update `src/services/transport/index.js` handshake call to pass `protocolVersion:"v2"` and `capabilities:{}` to `buildInitializeParams`.
- [ ] **Src (optional):** Add v2-first → v1 fallback in `ensureHandshake()` (conservative error matching).
- [ ] **Shim (optional):** Add a mode to reject v2 (for fallback tests) OR use existing capture mode.
- [ ] **Test:** Add integration test asserting initialize params include v2 keys (capture via stderr).
