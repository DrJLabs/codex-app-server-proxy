/**
 * Codex App Server JSON-RPC bindings for chat.
 *
 * Generated with codex-cli/codex-rs/app-server-protocol export tooling (v0.92.0)
 * and then trimmed to the subset needed by the proxy. Regenerate when the
 * upstream protocol changes.
 */

/* eslint-disable */

export const JSONRPC_VERSION = "2.0" as const;
export const CODEX_CLI_VERSION = "0.92.0" as const;

export type JsonRpcId = number | string;

export type JsonRpcMethod = "initialize" | "thread/start" | "turn/start";

export interface JsonRpcBaseEnvelope {
  jsonrpc: typeof JSONRPC_VERSION;
}

export interface JsonRpcRequest<Method extends JsonRpcMethod, Params> extends JsonRpcBaseEnvelope {
  id: JsonRpcId;
  method: Method;
  params: Params;
}

export interface JsonRpcSuccessResponse<Result> extends JsonRpcBaseEnvelope {
  id: JsonRpcId;
  result: Result;
}

export interface JsonRpcErrorObject {
  code: number | string;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse extends JsonRpcBaseEnvelope {
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<Result> = JsonRpcSuccessResponse<Result> | JsonRpcErrorResponse;

export type JsonRpcNotificationMethod = string;

export interface JsonRpcNotification<Method extends JsonRpcNotificationMethod, Params>
  extends JsonRpcBaseEnvelope {
  method: Method;
  params: Params;
}

export interface ClientInfo {
  name: string;
  version: string;
  title?: string | null;
  [key: string]: unknown;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities?: Record<string, unknown> | null;
  protocolVersion?: string;
}

export interface InitializeResult {
  userAgent: string;
  [key: string]: unknown;
}

export type SandboxMode = "danger-full-access" | "read-only" | "workspace-write";

export type AskForApproval = "untrusted" | "on-failure" | "on-request" | "never";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";

export type FinishReason =
  | "stop"
  | "length"
  | "content_filter"
  | "tool_calls"
  | "function_call"
  | string;

export type SandboxPolicy =
  | { type: "danger-full-access" }
  | { type: "read-only" }
  | {
      type: "workspace-write";
      writable_roots?: string[];
      network_access?: boolean;
      exclude_tmpdir_env_var?: boolean;
      exclude_slash_tmp?: boolean;
    };

export type InputItem =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { image_url: string } }
  | { type: "localImage"; data: { path: string } };

export type UserInput =
  | { type: "text"; text: string; text_elements?: Array<{ byteRange: unknown }> }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string };

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  profile?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  dynamicTools?: JsonValue[] | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  experimentalRawEvents?: boolean | null;
  ephemeral?: boolean | null;
  personality?: string | null;
  [key: string]: unknown;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: JsonValue;
  cwd?: string | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
  summary?: ReasoningSummary | null;
  outputSchema?: JsonValue;
  [key: string]: unknown;
}

export type JsonObject = Record<string, unknown>;
export type JsonValue = unknown;

const APPROVAL_FALLBACK: AskForApproval = "on-request";
const SUMMARY_FALLBACK: ReasoningSummary = "auto";

export interface BuildInitializeOptions {
  clientInfo: ClientInfo;
  capabilities?: JsonObject | null;
  protocolVersion?: string;
}

export interface BuildThreadStartOptions {
  model?: string | null;
  modelProvider?: string | null;
  profile?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | string | null;
  sandbox?: SandboxMode | string | JsonObject | null;
  config?: JsonObject | null;
  dynamicTools?: JsonValue[] | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  experimentalRawEvents?: boolean | null;
  ephemeral?: boolean | null;
  personality?: string | null;
}

export interface BuildTurnStartOptions {
  threadId?: string | null;
  items?: InputItem[] | null;
  cwd?: string;
  approvalPolicy?: AskForApproval | string | null;
  sandboxPolicy?: SandboxPolicy | { type?: string; mode?: string; [key: string]: unknown } | null;
  model?: string;
  effort?: ReasoningEffort | string | null;
  summary?: ReasoningSummary | string | null;
  outputSchema?: JsonValue;
}

const VALID_APPROVAL_POLICIES: Set<string> = new Set([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);

const VALID_REASONING_SUMMARIES: Set<string> = new Set(["auto", "concise", "detailed", "none"]);

const VALID_REASONING_EFFORTS: Set<string> = new Set(["low", "medium", "high", "xhigh"]);

const VALID_SANDBOX_MODES: Set<string> = new Set([
  "danger-full-access",
  "read-only",
  "workspace-write",
]);

export function createUserMessageItem(text: string, _metadata?: JsonObject | null): InputItem {
  return {
    type: "text",
    data: { text: text ?? "" },
  };
}

export function normalizeInputItems(items: unknown, fallbackText?: string): InputItem[] {
  const result: InputItem[] = [];
  if (Array.isArray(items)) {
    for (const raw of items) {
      if (typeof raw === "string") {
        result.push(createUserMessageItem(raw));
        continue;
      }
      if (raw && typeof raw === "object") {
        const candidate = raw as Record<string, unknown>;
        if (typeof candidate.type === "string") {
          result.push({ ...candidate } as InputItem);
          continue;
        }
        const dataText =
          candidate?.data && typeof (candidate as any).data?.text === "string"
            ? (candidate as any).data.text
            : undefined;
        const directText =
          typeof (candidate as any).text === "string" ? (candidate as any).text : undefined;
        if (dataText !== undefined) {
          const data = { ...(candidate as any).data, text: dataText };
          result.push({ ...(candidate as InputItem), type: "text", data });
          continue;
        }
        if (directText !== undefined) {
          result.push(createUserMessageItem(directText));
          continue;
        }
      }
    }
  }
  if (result.length === 0 && typeof fallbackText === "string") {
    result.push(createUserMessageItem(fallbackText));
  }
  return result;
}

export function buildInitializeParams(
  options: BuildInitializeOptions
): InitializeParams & JsonObject {
  const clientInfo = { ...(options.clientInfo || {}) } as ClientInfo;
  if (!clientInfo.name) clientInfo.name = "codex-app-server-proxy";
  if (!clientInfo.version) clientInfo.version = CODEX_CLI_VERSION;
  const params: InitializeParams & JsonObject = {
    clientInfo,
  };
  if (options.capabilities !== undefined) {
    params.capabilities = options.capabilities ?? null;
  }
  if (options.protocolVersion) {
    params.protocolVersion = options.protocolVersion;
  }
  return params;
}

const toUserInput = (item: InputItem) => {
  if (!item || typeof item !== "object") return null;
  if (item.type === "text" && typeof item.data?.text === "string") {
    return {
      type: "text",
      text: item.data.text,
      text_elements: [],
    } satisfies UserInput;
  }
  if (item.type === "image" && typeof item.data?.image_url === "string") {
    return { type: "image", url: item.data.image_url } satisfies UserInput;
  }
  if (item.type === "localImage" && typeof item.data?.path === "string") {
    return { type: "localImage", path: item.data.path } satisfies UserInput;
  }
  return null;
};

export function normalizeUserInputs(items: unknown, fallbackText?: string): UserInput[] {
  const normalized = normalizeInputItems(items, fallbackText);
  const result: UserInput[] = [];
  for (const item of normalized) {
    const mapped = toUserInput(item);
    if (mapped) result.push(mapped);
  }
  if (result.length === 0 && typeof fallbackText === "string") {
    result.push({ type: "text", text: fallbackText, text_elements: [] });
  }
  return result;
}

export function buildThreadStartParams(
  options: BuildThreadStartOptions = {}
): ThreadStartParams & JsonObject {
  const params: ThreadStartParams & JsonObject = {};

  const model = toNullableString(options.model);
  if (typeof model === "string") params.model = model;

  const modelProvider = toNullableString(options.modelProvider);
  if (typeof modelProvider === "string") params.modelProvider = modelProvider;

  const profile = toNullableString(options.profile);
  if (profile !== undefined) params.profile = profile;

  const cwd = toNullableString(options.cwd);
  if (typeof cwd === "string") params.cwd = cwd;

  const approval = normalizeOptionalApprovalPolicy(options.approvalPolicy);
  if (typeof approval === "string") params.approvalPolicy = approval;

  const sandbox = normalizeSandboxModeOption(options.sandbox);
  if (typeof sandbox === "string") params.sandbox = sandbox;

  if (options.config && typeof options.config === "object") {
    params.config = options.config ?? null;
  }

  if (Array.isArray(options.dynamicTools)) {
    params.dynamicTools = options.dynamicTools;
  }

  const baseInstructions = toNullableString(options.baseInstructions);
  if (typeof baseInstructions === "string") params.baseInstructions = baseInstructions;

  const developerInstructions = toNullableString(options.developerInstructions);
  if (developerInstructions !== undefined) params.developerInstructions = developerInstructions;

  if (options.experimentalRawEvents !== undefined) {
    params.experimentalRawEvents = !!options.experimentalRawEvents;
  }

  if (options.ephemeral !== undefined) {
    params.ephemeral = !!options.ephemeral;
  }

  const personality = toNullableString(options.personality);
  if (personality !== undefined) params.personality = personality;

  return params;
}

const mapSandboxPolicyToV2 = (policy: unknown) => {
  if (!policy || typeof policy !== "object") return policy;
  const rawType =
    typeof (policy as any).type === "string"
      ? (policy as any).type
      : typeof (policy as any).mode === "string"
        ? (policy as any).mode
        : "";
  const normalized = String(rawType).trim();
  const base: Record<string, unknown> = {};

  const networkAccess = (policy as any).networkAccess ?? (policy as any).network_access;
  const writableRoots = (policy as any).writableRoots ?? (policy as any).writable_roots;
  const excludeTmpdirEnvVar =
    (policy as any).excludeTmpdirEnvVar ?? (policy as any).exclude_tmpdir_env_var;
  const excludeSlashTmp = (policy as any).excludeSlashTmp ?? (policy as any).exclude_slash_tmp;

  if (networkAccess !== undefined) base.networkAccess = networkAccess;
  if (Array.isArray(writableRoots)) base.writableRoots = writableRoots;
  if (excludeTmpdirEnvVar !== undefined) base.excludeTmpdirEnvVar = !!excludeTmpdirEnvVar;
  if (excludeSlashTmp !== undefined) base.excludeSlashTmp = !!excludeSlashTmp;

  if (normalized === "danger-full-access" || normalized === "dangerFullAccess") {
    return { type: "dangerFullAccess" };
  }
  if (normalized === "read-only" || normalized === "readOnly") {
    return { type: "readOnly" };
  }
  if (normalized === "workspace-write" || normalized === "workspaceWrite") {
    return { type: "workspaceWrite", ...base };
  }
  if (normalized === "externalSandbox" || normalized === "external-sandbox") {
    return { type: "externalSandbox", ...base };
  }
  return policy;
};

export function buildTurnStartParams(options: BuildTurnStartOptions): TurnStartParams & JsonObject {
  const input = normalizeUserInputs(options.items);
  const params: TurnStartParams & JsonObject = {
    threadId: String(options.threadId ?? ""),
    input,
  };

  const approval = normalizeOptionalApprovalPolicy(options.approvalPolicy);
  if (typeof approval === "string" || approval === null) params.approvalPolicy = approval;

  if (options.sandboxPolicy !== undefined) {
    params.sandboxPolicy = mapSandboxPolicyToV2(options.sandboxPolicy);
  }

  const cwd = toNullableString(options.cwd);
  if (typeof cwd === "string") params.cwd = cwd;

  const model = toNullableString(options.model);
  if (typeof model === "string") params.model = model;

  const effort = normalizeReasoningEffort(options.effort);
  if (effort !== undefined) params.effort = effort;

  const summary = normalizeReasoningSummary(options.summary);
  if (summary !== undefined) params.summary = summary;

  if (options.outputSchema !== undefined) {
    params.outputSchema = options.outputSchema;
  }

  return params;
}

export interface NotificationContextPayload {
  thread_id?: string;
  threadId?: string;
  request_id?: string;
  requestId?: string;
  conversation?: { id?: string | null } | null;
  context?: {
    thread_id?: string | null;
    threadId?: string | null;
    request_id?: string | null;
    requestId?: string | null;
  } | null;
  [key: string]: unknown;
}

export interface ToolCallFunctionDelta {
  name?: string;
  arguments?: string;
  arguments_chunk?: string;
  argumentsChunk?: string;
  [key: string]: unknown;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  tool_call_id?: string;
  toolCallId?: string;
  type?: string;
  function?: ToolCallFunctionDelta;
  parallel_tool_calls?: boolean;
  parallelToolCalls?: boolean;
  [key: string]: unknown;
}

export interface ToolCallFunction {
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface ToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: ToolCallFunction;
  [key: string]: unknown;
}

export interface FunctionCall {
  name?: string;
  arguments?: string;
  [key: string]: unknown;
}

export interface AgentContentPayload {
  text?: string;
  content?: string;
  type?: string;
  [key: string]: unknown;
}

export type AgentContent = string | AgentContentPayload | Array<AgentContentPayload> | null;

export type AgentMessageDelta =
  | string
  | ({
      role?: string;
      content?: AgentContent;
      text?: string | null;
      metadata?: Record<string, unknown> | null;
      tool_calls?: ToolCallDelta[] | null;
      toolCalls?: ToolCallDelta[] | null;
      parallel_tool_calls?: boolean;
      parallelToolCalls?: boolean;
      [key: string]: unknown;
    } & Record<string, unknown>);

export interface AgentMessageDeltaParams extends NotificationContextPayload {
  delta: AgentMessageDelta;
  [key: string]: unknown;
}

export interface AssistantMessage {
  role: string;
  content?: AgentContent;
  tool_calls?: ToolCall[] | null;
  toolCalls?: ToolCall[] | null;
  function_call?: FunctionCall | null;
  functionCall?: FunctionCall | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface AgentMessageParams extends NotificationContextPayload {
  message: AssistantMessage;
  parallel_tool_calls?: boolean;
  parallelToolCalls?: boolean;
  [key: string]: unknown;
}

export interface TokenCountParams extends NotificationContextPayload {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  finish_reason?: FinishReason;
  reason?: string;
  token_limit_reached?: boolean;
  [key: string]: unknown;
}

export interface RequestTimeoutParams extends NotificationContextPayload {
  reason?: string;
  [key: string]: unknown;
}

export interface TurnCompletedParams extends NotificationContextPayload {
  turn?: { status?: string | null } | null;
  finish_reason?: FinishReason;
  [key: string]: unknown;
}

export interface JsonRpcNotification<Method extends JsonRpcNotificationMethod, Params>
  extends JsonRpcBaseEnvelope {
  method: Method;
  params: Params;
}

export type AgentMessageDeltaNotification = JsonRpcNotification<
  "agentMessageDelta",
  AgentMessageDeltaParams
>;

export type AgentMessageNotification = JsonRpcNotification<"agentMessage", AgentMessageParams>;

export type TokenCountNotification = JsonRpcNotification<"tokenCount", TokenCountParams>;

export type RequestTimeoutNotification = JsonRpcNotification<
  "requestTimeout",
  RequestTimeoutParams
>;

export type TurnCompletedNotification = JsonRpcNotification<"turn/completed", TurnCompletedParams>;

export type ChatNotification =
  | AgentMessageDeltaNotification
  | AgentMessageNotification
  | TokenCountNotification
  | RequestTimeoutNotification
  | TurnCompletedNotification;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function pickString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function pickNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function hasConversationIdentifiers(params: NotificationContextPayload): boolean {
  if (!isObject(params)) return false;
  if (pickString(params.thread_id)) return true;
  if (pickString(params.threadId)) return true;
  if (isObject(params.conversation) && pickString(params.conversation.id)) return true;
  if (isObject(params.context) && pickString(params.context.thread_id)) return true;
  if (isObject(params.context) && pickString(params.context.threadId)) return true;
  if (pickString(params.request_id)) return true;
  if (pickString(params.requestId)) return true;
  return false;
}

export function extractConversationId(params: NotificationContextPayload): string | null {
  if (!isObject(params)) return null;
  return (
    pickString(params.thread_id) ||
    pickString(params.threadId) ||
    (isObject(params.conversation) ? pickString(params.conversation.id) : null) ||
    (isObject(params.context) ? pickString(params.context.thread_id) : null) ||
    (isObject(params.context) ? pickString(params.context.threadId) : null) ||
    null
  );
}

export function extractRequestId(params: NotificationContextPayload): string | null {
  if (!isObject(params)) return null;
  return (
    pickString(params.request_id) ||
    pickString(params.requestId) ||
    (isObject(params.context) ? pickString(params.context.request_id) : null) ||
    null
  );
}

export function isInitializeResult(value: unknown): value is InitializeResult {
  if (!isObject(value)) return false;
  if (value.advertised_models && !Array.isArray(value.advertised_models)) return false;
  return true;
}

export function isAgentMessageDeltaNotification(
  value: unknown
): value is AgentMessageDeltaNotification {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (value.method !== "agentMessageDelta") return false;
  if (!isObject(value.params)) return false;
  if (!hasConversationIdentifiers(value.params as NotificationContextPayload)) return false;
  if (!Object.prototype.hasOwnProperty.call(value.params, "delta")) return false;
  return true;
}

export function isAgentMessageNotification(value: unknown): value is AgentMessageNotification {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (value.method !== "agentMessage") return false;
  if (!isObject(value.params)) return false;
  if (!hasConversationIdentifiers(value.params as NotificationContextPayload)) return false;
  const { message } = value.params as Record<string, unknown>;
  if (!isObject(message)) return false;
  if (!pickString(message.role)) return false;
  return true;
}

export function isTokenCountNotification(value: unknown): value is TokenCountNotification {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (value.method !== "tokenCount") return false;
  if (!isObject(value.params)) return false;
  if (!hasConversationIdentifiers(value.params as NotificationContextPayload)) return false;
  const ctx = value.params as Record<string, unknown>;
  const hasPrompt = pickNumber(ctx.prompt_tokens) !== null;
  const hasCompletion = pickNumber(ctx.completion_tokens) !== null;
  const hasTotal = pickNumber(ctx.total_tokens) !== null;
  if (!(hasPrompt || hasCompletion || hasTotal)) return false;
  return true;
}

export function isRequestTimeoutNotification(value: unknown): value is RequestTimeoutNotification {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (value.method !== "requestTimeout") return false;
  if (!isObject(value.params)) return false;
  return hasConversationIdentifiers(value.params as NotificationContextPayload);
}

export function isTurnCompletedNotification(value: unknown): value is TurnCompletedNotification {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (value.method !== "turn/completed") return false;
  if (!isObject(value.params)) return false;
  return hasConversationIdentifiers(value.params as NotificationContextPayload);
}

export function isJsonRpcNotification(value: unknown): value is ChatNotification {
  return (
    isAgentMessageDeltaNotification(value) ||
    isAgentMessageNotification(value) ||
    isTokenCountNotification(value) ||
    isRequestTimeoutNotification(value) ||
    isTurnCompletedNotification(value)
  );
}

export function isJsonRpcErrorResponse(value: unknown): value is JsonRpcErrorResponse {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "error")) return false;
  if (!isObject(value.error)) return false;
  if (!("message" in value.error) || typeof value.error.message !== "string") return false;
  return true;
}

export function isJsonRpcSuccessResponse<Result>(
  value: unknown
): value is JsonRpcSuccessResponse<Result> {
  if (!isObject(value)) return false;
  if (value.jsonrpc !== JSONRPC_VERSION) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "result")) return false;
  return true;
}

function normalizeReasoningSummary(value: BuildTurnStartOptions["summary"]): ReasoningSummary {
  if (typeof value === "string") {
    const normalized = (value as string).trim().toLowerCase();
    if (VALID_REASONING_SUMMARIES.has(normalized)) {
      return normalized as ReasoningSummary;
    }
  }
  return SUMMARY_FALLBACK;
}

function normalizeReasoningEffort(
  value: BuildTurnStartOptions["effort"]
): ReasoningEffort | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const normalized = (value as string).trim().toLowerCase();
    if (VALID_REASONING_EFFORTS.has(normalized)) {
      return normalized as ReasoningEffort;
    }
  }
  return undefined;
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const str = String(value);
  const trimmed = str.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalApprovalPolicy(
  value: BuildTurnStartOptions["approvalPolicy"]
): AskForApproval | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const normalized = (value as string).trim().toLowerCase();
    if (VALID_APPROVAL_POLICIES.has(normalized)) {
      return normalized as AskForApproval;
    }
    return APPROVAL_FALLBACK;
  }
  return value as AskForApproval;
}

function normalizeSandboxModeOption(
  value: BuildThreadStartOptions["sandbox"]
): SandboxMode | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const normalized = (value as string).trim().toLowerCase();
    if (VALID_SANDBOX_MODES.has(normalized)) {
      return normalized as SandboxMode;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const raw =
      typeof (value as any).type === "string"
        ? (value as any).type
        : typeof (value as any).mode === "string"
          ? (value as any).mode
          : "";
    const mode = String(raw || "")
      .trim()
      .toLowerCase();
    if (VALID_SANDBOX_MODES.has(mode)) {
      return mode as SandboxMode;
    }
  }
  return undefined;
}
