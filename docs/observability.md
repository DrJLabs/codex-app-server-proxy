# Observability

This proxy is designed to be debuggable in production-like environments without changing API shapes.

## Request IDs

- Each request gets a `req_id` and returns `X-Request-Id`.
- Use the request ID to correlate access logs, dev tracing, and usage events.

## Logs

- Structured JSON access logs are emitted to stdout.
- Usage events are written as NDJSON (see `/v1/usage` and `/v1/usage/raw`).

## Metrics

- Enable Prometheus metrics with `PROXY_ENABLE_METRICS=true`.
- `/metrics` access is restricted by default (loopback and/or bearer), see [`../src/routes/metrics.js`](../src/routes/metrics.js).

## Tracing (optional)

Set:

```bash
PROXY_ENABLE_OTEL=true
PROXY_OTEL_EXPORTER_URL=http://localhost:4318/v1/traces
```

Spans are emitted for HTTP ingress and backend invocation (see [`../src/services/tracing.js`](../src/services/tracing.js)).

## Runbook

For the internal end-to-end tracing runbook, see the internal runbook (not published here).
