# Chat Stream Modularization Design

**Goal:** Reduce `src/handlers/chat/stream.js` to an orchestrator while keeping stream and nonstream behavior identical and sharing tool and function-call normalization.

## Context
- `src/handlers/chat/stream.js` is still large and owns transport wiring, stream state, tool buffering, SSE ordering, and error handling.
- Recent extractions (`stream-output.js`, `stream-event.js`, `tool-output.js`) are focused, but most logic still lives in `stream.js`.
- Nonstream and stream paths still diverge for tool and legacy function_call handling.

## Constraints
- No external API changes (routes, payloads, SSE framing, output ordering).
- Preserve existing flags and behavior (`PROXY_STOP_AFTER_TOOLS`, `PROXY_SUPPRESS_TAIL_AFTER_TOOLS`, `include_usage`, etc.).
- Maintain parity between stream and nonstream output ordering and tool-call semantics.
- Keep adapter path intact for now; refactor only structure.

## Architecture (Option 2 - Medium Shrink)
- Keep `stream.js` as orchestration glue (request validation, adapter wiring, SSE setup, timers, response close).
- Add a small stream runtime module that owns stream state transitions and output actions.
- Add a transport wiring module that normalizes backend events into a single internal event shape.
- Add a shared tool and function-call normalization module used by both stream and nonstream.

## Proposed Modules
- `src/handlers/chat/stream-runtime.js`
  - Owns per-choice state (finish reason, usage placeholders, stop-after-tools state).
  - Exposes `handleDelta`, `handleMessage`, `handleUsage`, `handleResult`, `handleError`.
- `src/handlers/chat/stream-transport.js`
  - Wires `JsonRpcChildAdapter` events to the runtime using a normalized event shape.
- `src/handlers/chat/tool-call-normalizer.js`
  - Centralizes tool buffer tracking, legacy function_call compatibility, and tool XML extraction.
  - Used by both stream and nonstream handlers.
- Optional: `src/handlers/chat/stream-timers.js`
  - Owns keepalive and idle timeout handling.

## Data Flow (Stream Path)
Request -> validate/normalize -> transport wiring -> normalized events -> runtime -> output coordinator -> SSE frames.

## Error Handling
- Transport errors are mapped in the runtime using existing helpers (`mapTransportError`, `sseErrorBody`).
- Usage append on error stays intact.
- Tool buffer abort logic remains consistent with current behavior.

## Testing Strategy
- Add unit tests for the new runtime and tool normalization modules.
- Keep existing stream and nonstream unit tests green.
- Run integration and Playwright suites after modularization steps to ensure parity.

## Rollout
- No feature flag or behavior change.
- Refactor in small steps with frequent commits and targeted test runs.
