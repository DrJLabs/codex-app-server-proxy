import fetch from "node-fetch";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, stopServer } from "./helpers.js";

describe("metrics endpoint", () => {
  let child;
  let PORT;

  afterEach(async () => {
    await stopServer(child);
  });

  it("exposes Prometheus metrics with bounded labels", async () => {
    ({ PORT, child } = await startServer({
      PROXY_ENABLE_METRICS: "true",
      PROXY_TEST_ENDPOINTS: "true",
    }));

    await fetch(`http://127.0.0.1:${PORT}/healthz`);
    const responsesStream = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-sk-ci",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-5",
        stream: true,
        input: "metrics smoke",
      }),
    });
    expect(responsesStream.ok).toBeTruthy();
    await responsesStream.text();
    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/codex_http_requests_total/);
    expect(text).toMatch(/route="\/healthz"/);
    expect(text).toMatch(/codex_streams_active/);
    expect(text).toMatch(/codex_stream_ttfb_ms/);
    expect(text).toMatch(/codex_stream_duration_ms/);
    expect(text).toMatch(/codex_stream_end_total/);
    expect(text).toMatch(/codex_responses_sse_event_total/);
    expect(text).toContain('codex_responses_sse_event_total{route="/v1/responses"');
    expect(text).toMatch(/codex_worker_restarts_(total|inc_total)/);
    expect(text).toMatch(/codex_maintenance_mode/);
    expect(text).not.toMatch(/request_id/);
  });

  it("requires bearer when loopback is disabled", async () => {
    ({ PORT, child } = await startServer({
      PROXY_ENABLE_METRICS: "true",
      PROXY_METRICS_ALLOW_LOOPBACK: "false",
      PROXY_METRICS_TOKEN: "secret-token",
    }));

    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    expect(res.status).toBe(403);

    const authed = await fetch(`http://127.0.0.1:${PORT}/metrics`, {
      headers: { Authorization: "Bearer secret-token" },
    });
    expect(authed.status).toBe(200);
    const text = await authed.text();
    expect(text).toMatch(/codex_http_requests_total/);
  });

  it("surfaces maintenance flag in metrics", async () => {
    ({ PORT, child } = await startServer({
      PROXY_ENABLE_METRICS: "true",
      PROXY_MAINTENANCE_MODE: "true",
    }));
    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const maintenanceLine = text
      .split("\n")
      .find((line) => line.trim().startsWith("codex_maintenance_mode"));
    expect(maintenanceLine).toBeTruthy();
    expect(maintenanceLine.trim().endsWith(" 1")).toBe(true);
  });
});
