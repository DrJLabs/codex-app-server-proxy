import { describe, expect, test, vi, beforeEach } from "vitest";

const selectBackendModeMock = vi.fn();
const isWorkerSupervisorReadyMock = vi.fn();
const getWorkerStatusMock = vi.fn();
const ensureHandshakeMock = vi.fn();
const applyCorsMock = vi.fn();

vi.mock("../../../src/services/backend-mode.js", () => ({
  selectBackendMode: () => selectBackendModeMock(),
  BACKEND_APP_SERVER: "app-server",
  BACKEND_DISABLED: "disabled",
}));

vi.mock("../../../src/services/worker/supervisor.js", () => ({
  isWorkerSupervisorReady: () => isWorkerSupervisorReadyMock(),
  getWorkerStatus: () => getWorkerStatusMock(),
}));

vi.mock("../../../src/services/transport/index.js", () => ({
  getJsonRpcTransport: () => ({ ensureHandshake: ensureHandshakeMock }),
}));

vi.mock("../../../src/utils.js", () => ({
  applyCors: (...args) => applyCorsMock(...args),
}));

const { requireWorkerReady } = await import("../../../src/middleware/worker-ready.js");

const createRes = () => ({
  status: vi.fn(function status(code) {
    this.statusCode = code;
    return this;
  }),
  json: vi.fn(),
});

describe("requireWorkerReady", () => {
  beforeEach(() => {
    selectBackendModeMock.mockReset();
    isWorkerSupervisorReadyMock.mockReset();
    getWorkerStatusMock.mockReset();
    ensureHandshakeMock.mockReset();
    applyCorsMock.mockReset();
  });

  test("returns 503 when app-server is disabled", () => {
    selectBackendModeMock.mockReturnValue("disabled");
    const req = {};
    const res = createRes();
    const next = vi.fn();

    requireWorkerReady(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(applyCorsMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          type: "backend_unavailable",
          code: "app_server_disabled",
        }),
      })
    );
  });

  test("passes through when supervisor is ready", () => {
    selectBackendModeMock.mockReturnValue("app-server");
    isWorkerSupervisorReadyMock.mockReturnValue(true);
    const req = {};
    const res = createRes();
    const next = vi.fn();

    requireWorkerReady(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("attempts handshake before allowing request when supervisor is not ready", async () => {
    selectBackendModeMock.mockReturnValue("app-server");
    isWorkerSupervisorReadyMock.mockReturnValue(false);
    ensureHandshakeMock.mockResolvedValue({ ok: true });
    const req = {};
    const res = createRes();
    const next = vi.fn();

    await requireWorkerReady(req, res, next);

    expect(ensureHandshakeMock).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test("returns 503 when handshake attempt fails", async () => {
    selectBackendModeMock.mockReturnValue("app-server");
    isWorkerSupervisorReadyMock.mockReturnValue(false);
    ensureHandshakeMock.mockRejectedValue(new Error("handshake failed"));
    const statusPayload = { ready: false };
    getWorkerStatusMock.mockReturnValue(statusPayload);
    const req = {};
    const res = createRes();
    const next = vi.fn();

    await requireWorkerReady(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(applyCorsMock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          type: "backend_unavailable",
          code: "worker_not_ready",
        }),
        worker_status: statusPayload,
      })
    );
  });
});
