import {
  selectBackendMode,
  BACKEND_APP_SERVER,
  BACKEND_DISABLED,
} from "../services/backend-mode.js";
import { isWorkerSupervisorReady, getWorkerStatus } from "../services/worker/supervisor.js";
import { getJsonRpcTransport } from "../services/transport/index.js";
import { logStructured } from "../services/logging/schema.js";
import { applyCors as applyCorsUtil } from "../utils.js";
import { config as CFG } from "../config/index.js";

const CORS_ENABLED = CFG.PROXY_ENABLE_CORS.toLowerCase() !== "false";
const CORS_ALLOWED = CFG.PROXY_CORS_ALLOWED_ORIGINS;

export async function requireWorkerReady(req, res, next) {
  try {
    const reqId = res?.locals?.req_id ?? null;
    const backendMode = selectBackendMode();
    if (backendMode === BACKEND_DISABLED) {
      logStructured(
        {
          component: "worker_supervisor",
          event: "worker_gate",
          level: "warn",
          req_id: reqId,
        },
        { status: "app_server_disabled" }
      );
      applyCorsUtil(req, res, CORS_ENABLED, CORS_ALLOWED);
      return res.status(503).json({
        error: {
          message: "app-server disabled (proto deprecated)",
          type: "backend_unavailable",
          code: "app_server_disabled",
          retryable: false,
        },
      });
    }
    if (backendMode !== BACKEND_APP_SERVER) {
      return next();
    }

    if (isWorkerSupervisorReady()) {
      return next();
    }

    try {
      const transport = getJsonRpcTransport();
      const handshake = transport.ensureHandshake();
      // If the handshake is hung or slow, don't block the request on the full handshake timeout.
      let handshakeOk = false;
      handshake
        .then(() => {
          handshakeOk = true;
          return null;
        })
        .catch(() => {});
      await Promise.race([handshake, new Promise((resolve) => setTimeout(resolve, 250))]);
      if (handshakeOk || isWorkerSupervisorReady()) {
        return next();
      }
    } catch (err) {
      const safe = {
        message: err instanceof Error ? err.message : String(err || "unknown error"),
        code: err && typeof err === "object" ? err.code : undefined,
      };
      logStructured(
        {
          component: "worker_supervisor",
          event: "worker_gate",
          level: "warn",
          req_id: reqId,
        },
        { status: "handshake_failed", error: safe }
      );
    }

    logStructured(
      {
        component: "worker_supervisor",
        event: "worker_gate",
        level: "warn",
        req_id: reqId,
      },
      { status: "not_ready" }
    );
    applyCorsUtil(req, res, CORS_ENABLED, CORS_ALLOWED);
    return res.status(503).json({
      error: {
        message: "app-server worker is not ready",
        type: "backend_unavailable",
        code: "worker_not_ready",
        retryable: true,
      },
      worker_status: getWorkerStatus(),
    });
  } catch (err) {
    return next(err);
  }
}
