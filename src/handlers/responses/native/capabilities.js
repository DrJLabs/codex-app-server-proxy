import { invalidRequestBody } from "../../../lib/errors.js";
import { getJsonRpcTransport, mapTransportError } from "../../../services/transport/index.js";

const resolveCapabilities = (handshake) => {
  const raw = handshake?.raw;
  const capabilities = raw?.capabilities;
  if (capabilities && typeof capabilities === "object") return capabilities;
  return {};
};

const supportsTools = (capabilities) => {
  if (!capabilities || typeof capabilities !== "object") return true;
  if (!Object.prototype.hasOwnProperty.call(capabilities, "tools")) return true;
  const value = capabilities.tools;
  if (value === false) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === "object") return true;
  return Boolean(value);
};

export const ensureResponsesCapabilities = async ({ toolsRequested = false } = {}) => {
  try {
    const transport = getJsonRpcTransport();
    const handshake = await transport.ensureHandshake();
    const capabilities = resolveCapabilities(handshake);

    if (toolsRequested && !supportsTools(capabilities)) {
      return {
        ok: false,
        statusCode: 400,
        body: invalidRequestBody("tools", "tools are not supported by backend"),
      };
    }

    return { ok: true, capabilities };
  } catch (error) {
    const mapped = mapTransportError(error);
    if (mapped) {
      return { ok: false, statusCode: mapped.statusCode, body: mapped.body };
    }
    return {
      ok: false,
      statusCode: 500,
      body: {
        error: {
          message: error?.message || "Internal server error",
          type: error?.type || "server_error",
          code: error?.code || "internal_error",
        },
      },
    };
  }
};
