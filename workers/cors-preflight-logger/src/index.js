const STATIC_ALLOWED = [
  "app://obsidian.md",
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
];

const DEFAULT_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "OpenAI-Organization",
  "OpenAI-Beta",
  "OpenAI-Version",
  "OpenAI-Project",
  "X-Requested-With",
  "X-Stainless-OS",
  "X-Stainless-Lang",
  "X-Stainless-Arch",
  "X-Stainless-Runtime",
  "X-Stainless-Runtime-Version",
  "X-Stainless-Package-Version",
  "X-Stainless-Timeout",
  "X-Stainless-Retry-Count",
  "dangerously-allow-browser",
];

const stripTrailingSlashes = (value) => value.replace(/\/+$/, "");

function normalizeOrigin(origin) {
  if (!origin) return "";
  const input = String(origin).trim().toLowerCase();
  if (!input) return "";

  const trimmed = stripTrailingSlashes(input);

  const canonicalCustomSchemes = [
    { scheme: "capacitor", host: "localhost" },
    { scheme: "app", host: "obsidian.md" },
  ];

  for (const { scheme, host } of canonicalCustomSchemes) {
    const prefix = `${scheme}://`;
    if (!trimmed.startsWith(prefix)) continue;

    const withoutScheme = trimmed.slice(prefix.length);
    const authority = withoutScheme.split("/")[0];
    const [hostname] = authority.split(":");

    if (hostname === host) {
      return `${scheme}://${host}`;
    }

    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const { protocol, hostname, port } = parsed;

    if (!protocol || !hostname) return trimmed;

    if (
      (protocol === "http:" || protocol === "https:") &&
      (hostname === "localhost" || hostname === "127.0.0.1")
    ) {
      return `${protocol}//${hostname}`;
    }

    return port ? `${protocol}//${hostname}:${port}` : `${protocol}//${hostname}`;
  } catch {
    return trimmed;
  }
}

const parseAllowedOrigins = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const buildNormalizedAllowList = (env) =>
  [...parseAllowedOrigins(env?.ALLOWED_ORIGINS), ...STATIC_ALLOWED].map((value) =>
    normalizeOrigin(value)
  );

function mergeAllowedHeaders(rawRequested = "") {
  const seen = new Map(DEFAULT_ALLOWED_HEADERS.map((header) => [header.toLowerCase(), header]));
  const requested = rawRequested
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const header of requested) {
    const lower = header.toLowerCase();
    if (!seen.has(lower)) {
      seen.set(lower, header);
    }
  }

  return Array.from(seen.values()).join(", ");
}

function buildCorsHeaders(request, normalizedAllowList) {
  const origin = request.headers.get("Origin") ?? "";
  const normalized = normalizeOrigin(origin);
  const allow = normalized && normalizedAllowList.includes(normalized) ? origin : "";
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers") ?? "";

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": mergeAllowedHeaders(requestedHeaders),
    "Access-Control-Max-Age": "600",
    "Access-Control-Expose-Headers": "Content-Type",
    Vary: "Origin, Access-Control-Request-Headers, Access-Control-Request-Method",
    "X-CORS-Worker": "1",
  };

  if (allow) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

function logRequest(request) {
  const origin = request.headers.get("Origin") ?? "";
  const acrMethod = request.headers.get("Access-Control-Request-Method") ?? "";
  const acrHeaders = request.headers.get("Access-Control-Request-Headers") ?? "";
  const ua = request.headers.get("User-Agent") ?? "";
  const url = new URL(request.url);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      host: url.host,
      path: url.pathname + url.search,
      method: request.method,
      origin,
      acrMethod,
      acrHeaders,
      ua,
    })
  );
}

export default {
  async fetch(request, env) {
    const normalizedAllowList = buildNormalizedAllowList(env);
    logRequest(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request, normalizedAllowList),
      });
    }

    const response = await fetch(request);
    const corsHeaders = buildCorsHeaders(request, normalizedAllowList);
    const newHeaders = new Headers(response.headers);

    for (const [key, value] of Object.entries(corsHeaders)) {
      if (value) newHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  },
};
