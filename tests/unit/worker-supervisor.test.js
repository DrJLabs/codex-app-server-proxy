import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const mockChildren = [];

class MockChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough({ encoding: "utf8" });
    this.stderr = new PassThrough({ encoding: "utf8" });
    this.exitCode = null;
    this.signalCode = null;
    this.kill = vi.fn((signal = "SIGTERM") => {
      this.signalCode = signal;
      setImmediate(() => {
        if (this.exitCode == null) {
          this.exitCode = 0;
        }
        this.emit("exit", this.exitCode, signal);
      });
    });
  }
}

const spawnCodexSpy = vi.fn(() => {
  const child = new MockChild(1000 + mockChildren.length);
  mockChildren.push(child);
  setImmediate(() => {
    child.emit("spawn");
  });
  return child;
});

vi.mock("../../src/services/codex-runner.js", () => ({
  spawnCodex: spawnCodexSpy,
}));

let ensureWorkerSupervisor;
let getWorkerStatus;
let currentSupervisor;

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  mockChildren.splice(0, mockChildren.length);
  spawnCodexSpy.mockClear();
  vi.resetModules();
  process.env.PROXY_USE_APP_SERVER = "true";
  process.env.WORKER_BACKOFF_INITIAL_MS = "30";
  process.env.WORKER_BACKOFF_MAX_MS = "30";
  process.env.WORKER_RESTART_MAX = "3";
  process.env.CODEX_FORCE_PROVIDER = "openai";
  process.env.PROXY_ENABLE_PARALLEL_TOOL_CALLS = "true";
  process.env.PROXY_DISABLE_INTERNAL_TOOLS = "true";

  const module = await import("../../src/services/worker/supervisor.js");
  ensureWorkerSupervisor = module.ensureWorkerSupervisor;
  getWorkerStatus = module.getWorkerStatus;
  currentSupervisor = ensureWorkerSupervisor();
  await settle();
});

afterEach(async () => {
  try {
    await currentSupervisor?.shutdown({ reason: "test_teardown" });
  } catch {}
  currentSupervisor = null;
  delete process.env.PROXY_USE_APP_SERVER;
  delete process.env.WORKER_BACKOFF_INITIAL_MS;
  delete process.env.WORKER_BACKOFF_MAX_MS;
  delete process.env.WORKER_RESTART_MAX;
  delete process.env.CODEX_FORCE_PROVIDER;
  delete process.env.PROXY_ENABLE_PARALLEL_TOOL_CALLS;
  delete process.env.PROXY_DISABLE_INTERNAL_TOOLS;
  vi.clearAllMocks();
});

describe("CodexWorkerSupervisor health snapshots", () => {
  test("launch args include provider and parallel tool call flags", () => {
    const args = spawnCodexSpy.mock.calls[0]?.[0] ?? [];
    expect(args).toContain("app-server");
    expect(args).toContain('model_provider="openai"');
    expect(args).toContain("parallel_tool_calls=true");
    expect(args).toContain("tools.web_search=false");
  });

  test("readiness toggles on handshake and exit events", async () => {
    expect(spawnCodexSpy).toHaveBeenCalledTimes(1);
    const initial = getWorkerStatus();
    expect(initial.health.readiness.ready).toBe(false);
    expect(initial.health.readiness.reason).toBe("worker_launching");
    expect(initial.health.liveness.live).toBe(true);
    expect(["worker_starting", "worker_running"]).toContain(initial.health.liveness.reason);
    expect(initial.ready).toBe(initial.health.readiness.ready);

    const child = mockChildren[mockChildren.length - 1];
    child.stdout.write(`${JSON.stringify({ event: "ready", models: ["codex-5"] })}\n`);
    await settle();

    const afterReady = getWorkerStatus();
    expect(afterReady.health.readiness.ready).toBe(false);
    expect(afterReady.health.readiness.reason).toBe("handshake_pending");
    expect(afterReady.health.readiness.handshake).toBeNull();
    expect(afterReady.health.liveness.live).toBe(true);
    expect(afterReady.health.liveness.reason).toBe("worker_running");
    expect(afterReady.ready).toBe(false);
    expect(afterReady.ready).toBe(afterReady.health.readiness.ready);

    currentSupervisor.recordHandshakeSuccess({ advertised_models: ["codex-5"] });
    await settle();

    const afterHandshake = getWorkerStatus();
    expect(afterHandshake.health.readiness.ready).toBe(true);
    expect(afterHandshake.health.readiness.reason).toBe("handshake_complete");
    expect(afterHandshake.health.readiness.handshake?.models).toEqual(["codex-5"]);
    expect(afterHandshake.health.liveness.live).toBe(true);
    expect(afterHandshake.health.liveness.reason).toBe("worker_running");
    expect(afterHandshake.ready).toBe(true);
    expect(afterHandshake.ready).toBe(afterHandshake.health.readiness.ready);

    child.exitCode = 0;
    child.signalCode = null;
    child.emit("exit", 0, null);
    await settle(10);

    const afterExit = getWorkerStatus();
    expect(afterExit.health.readiness.ready).toBe(false);
    expect(afterExit.health.readiness.reason).toBe("worker_exit");
    expect(afterExit.health.readiness.details?.restarts_total).toBeGreaterThanOrEqual(1);
    expect(afterExit.health.liveness.live).toBe(true);
    expect(afterExit.health.liveness.reason).toBe("worker_restarting");
    expect(afterExit.ready).toBe(false);
    expect(afterExit.ready).toBe(afterExit.health.readiness.ready);

    // Restart should spawn a new child after backoff window passes
    await settle(45);
    expect(spawnCodexSpy).toHaveBeenCalledTimes(2);
  });

  test("waitForReady resolves once handshake completes", async () => {
    currentSupervisor.recordHandshakeSuccess({ advertised_models: ["codex-5"] });
    await settle();

    await expect(currentSupervisor.waitForReady(50)).resolves.toBeUndefined();
  });

  test("readiness flag mirrors handshake without ready event", async () => {
    expect(currentSupervisor.state.ready).toBe(false);

    currentSupervisor.recordHandshakeSuccess({ advertised_models: ["codex-5"] });
    await settle();

    const afterHandshake = getWorkerStatus();
    expect(afterHandshake.health.readiness.ready).toBe(true);
    expect(afterHandshake.ready).toBe(true);
    expect(currentSupervisor.state.ready).toBe(true);
  });

  test("start is a no-op when already running", async () => {
    expect(spawnCodexSpy).toHaveBeenCalledTimes(1);

    currentSupervisor.start();
    await settle();

    expect(spawnCodexSpy).toHaveBeenCalledTimes(1);
  });

  test("waitForReady times out without a ready signal", async () => {
    await expect(currentSupervisor.waitForReady(10)).rejects.toThrow("worker readiness timeout");
  });

  test("recordHandshakeFailure updates readiness state", async () => {
    currentSupervisor.recordHandshakeFailure(new Error("handshake exploded"));
    await settle();

    const status = getWorkerStatus();
    expect(status.health.readiness.reason).toBe("handshake_failed");
    expect(status.health.readiness.handshake?.error).toBe("handshake exploded");
  });

  test("recordHandshakePending includes extra details", async () => {
    currentSupervisor.recordHandshakePending({ note: "waiting" });
    await settle();

    const status = getWorkerStatus();
    expect(status.health.readiness.reason).toBe("handshake_pending");
    expect(status.health.readiness.details?.note).toBe("waiting");
  });

  test("shutdown short-circuits when the child already exited", async () => {
    const child = mockChildren[mockChildren.length - 1];
    child.exitCode = 0;
    child.signalCode = null;

    await currentSupervisor.shutdown({ reason: "already_done" });

    const status = getWorkerStatus();
    expect(status.health.liveness.reason).toBe("shutdown_complete");
  });

  test("shutdown completes when child is missing", async () => {
    currentSupervisor.state.child = null;
    currentSupervisor.state.running = true;

    await currentSupervisor.shutdown({ reason: "no_child" });

    const status = getWorkerStatus();
    expect(status.running).toBe(false);
    expect(status.health.liveness.reason).toBe("shutdown_complete");
  });

  test("stops restarting after exceeding restart limit", async () => {
    expect(spawnCodexSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 4; i += 1) {
      const child = mockChildren[mockChildren.length - 1];
      child.exitCode = 1;
      child.signalCode = null;
      child.emit("exit", 1, null);
      await settle(45);
    }

    expect(spawnCodexSpy).toHaveBeenCalledTimes(4);
    const status = getWorkerStatus();
    expect(status.running).toBe(false);
    expect(status.health.liveness.reason).toBe("restart_limit_exceeded");
  });
});
