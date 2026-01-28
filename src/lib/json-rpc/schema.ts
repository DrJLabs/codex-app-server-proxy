/**
 * Codex App Server JSON-RPC bindings for chat.
 *
 * Generated with codex-cli/codex-rs/app-server-protocol export tooling (v0.89.0)
 * and then trimmed to the subset needed by the proxy. Regenerate when the
 * upstream protocol changes.
 */

/* eslint-disable */

export const JSONRPC_VERSION = "2.0" as const;
export const CODEX_CLI_VERSION = "0.89.0" as const;

export type JsonRpcId = number | string;

export type JsonRpcMethod =
  | "initialize"
  | "newConversation"
  | "addConversationListener"
  | "removeConversationListener"
  | "sendUserTurn"
  | "sendUserMessage";

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

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

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

export interface NewConversationParams {
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
  compactPrompt?: string | null;
  includeApplyPatchTool?: boolean | null;
  [key: string]: unknown;
}

export interface NewConversationResult {
  conversationId: string;
  model: string;
  reasoningEffort?: ReasoningEffort | null;
  rolloutPath?: string;
  [key: string]: unknown;
}

export interface AddConversationListenerParams {
  conversationId: string;
  experimentalRawEvents?: boolean;
  [key: string]: unknown;
}

export interface AddConversationListenerResult {
  subscriptionId: string;
  [key: string]: unknown;
}

export interface SendUserTurnParams {
  conversationId: string;
  items: InputItem[];
  cwd: string;
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
  model: string;
  choiceCount?: number;
  choice_count?: number;
  effort?: ReasoningEffort | null;
  summary: ReasoningSummary;
  outputSchema?: JsonValue;
  output_schema?: JsonValue;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface SendUserTurnResult {
  [key: string]: unknown;
}

export interface SendUserMessageParams {
  conversationId: string;
  items: InputItem[];
  includeUsage?: boolean;
  include_usage?: boolean;
  metadata?: JsonValue;
  stream?: boolean;
  temperature?: number;
  topP?: number;
  top_p?: number;
  maxOutputTokens?: number;
  max_output_tokens?: number;
  responseFormat?: JsonValue;
  response_format?: JsonValue;
  reasoning?: JsonValue;
  finalOutputJsonSchema?: JsonValue;
  final_output_json_schema?: JsonValue;
  [key: string]: unknown;
}

export interface SendUserMessageResult {
  finish_reason?: FinishReason;
  status?: FinishReason;
  usage?: TokenUsage;
  response?: JsonValue;
  [key: string]: unknown;
}

export interface RemoveConversationListenerParams {
  subscriptionId: string;
  [key: string]: unknown;
}

export interface RemoveConversationListenerResult {
  [key: string]: unknown;
}

export type JsonObject = Record<string, unknown>;
export type JsonValue = unknown;

const APPROVAL_FALLBACK: AskForApproval = "on-request";
const SUMMARY_FALLBACK: ReasoningSummary = "auto";

const SANDBOX_FALLBACK: SandboxPolicy = { type: "read-only" };

export interface BuildInitializeOptions {
  clientInfo: ClientInfo;
  capabilities?: JsonObject | null;
  protocolVersion?: string;
}

export interface BuildNewConversationOptions {
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
  compactPrompt?: string | null;
  includeApplyPatchTool?: boolean | null;
}

export interface BuildSendUserTurnOptions {
  conversationId?: string | null;
  items?: InputItem[] | null;
  cwd?: string;
  approvalPolicy?: AskForApproval | string | null;
  sandboxPolicy?: SandboxPolicy | { type?: string; mode?: string; [key: string]: unknown } | null;
  model?: string;
  choiceCount?: number | string | null;
  choice_count?: number | string | null;
  effort?: ReasoningEffort | string | null;
  summary?: ReasoningSummary | string | null;
  outputSchema?: JsonValue;
  output_schema?: JsonValue;
  finalOutputJsonSchema?: JsonValue;
}

export interface BuildSendUserMessageOptions {
  conversationId?: string | null;
  items?: InputItem[] | null;
  includeUsage?: boolean;
  metadata?: JsonValue;
  stream?: boolean;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  responseFormat?: JsonValue;
  reasoning?: JsonValue;
  finalOutputJsonSchema?: JsonValue;
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
  // Maintain backward compatibility with older CLI versions that expected snake_case.
  params.client_info = clientInfo;
  if (options.capabilities !== undefined) {
    params.capabilities = options.capabilities ?? null;
  }
  if (options.protocolVersion) {
    params.protocol_version = options.protocolVersion;
  }
  return params;
}

export function buildNewConversationParams(
  options: BuildNewConversationOptions = {}
): NewConversationParams & JsonObject {
  const params: NewConversationParams & JsonObject = {};

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

  const compactPrompt = toNullableString(options.compactPrompt);
  if (typeof compactPrompt === "string") params.compactPrompt = compactPrompt;

  if (typeof options.includeApplyPatchTool === "boolean") {
    params.includeApplyPatchTool = options.includeApplyPatchTool;
  }

  return params;
}

export function buildSendUserTurnParams(
  options: BuildSendUserTurnOptions
): SendUserTurnParams & JsonObject {
  const items: InputItem[] = normalizeInputItems(options.items);

  const sandbox = normalizeSandboxPolicy(options.sandboxPolicy);
  const approval = normalizeApprovalPolicy(options.approvalPolicy);
  const effort = normalizeReasoningEffort(options.effort);
  const summary = normalizeReasoningSummary(options.summary);

  const params: SendUserTurnParams & JsonObject = {
    conversationId: String(options.conversationId ?? ""),
    items,
    cwd: String(options.cwd ?? ""),
    approvalPolicy: approval,
    sandboxPolicy: sandbox,
    model: String(options.model ?? ""),
    summary,
  };

  const rawChoiceCount = options.choiceCount ?? (options as any).choice_count;
  if (rawChoiceCount !== undefined && rawChoiceCount !== null) {
    let parsed;
    if (typeof rawChoiceCount === "number") {
      parsed = rawChoiceCount;
    } else if (typeof rawChoiceCount === "string" && rawChoiceCount.trim() !== "") {
      const numeric = Number(rawChoiceCount);
      if (Number.isFinite(numeric)) parsed = numeric;
    }
    if (parsed !== undefined && Number.isInteger(parsed) && parsed > 0) {
      params.choiceCount = parsed;
      params.choice_count = parsed;
    }
  }

  if (effort !== undefined) {
    params.effort = effort;
  }

  const rawOutputSchema =
    options.outputSchema ?? options.output_schema ?? options.finalOutputJsonSchema;
  if (rawOutputSchema !== undefined) {
    params.outputSchema = rawOutputSchema;
    params.output_schema = rawOutputSchema;
  }

  return params;
}

export function buildSendUserMessageParams(
  options: BuildSendUserMessageOptions
): SendUserMessageParams & JsonObject {
  const items: InputItem[] = normalizeInputItems(options.items);

  const params: SendUserMessageParams & JsonObject = {
    conversationId: String(options.conversationId ?? ""),
    items,
  };

  if (options.includeUsage !== undefined) {
    const value = !!options.includeUsage;
    params.includeUsage = value;
    params.include_usage = value;
  }

  if (options.metadata !== undefined) {
    params.metadata = options.metadata ?? null;
  }

  if (options.stream !== undefined) {
    params.stream = options.stream;
  }

  if (options.temperature !== undefined) {
    params.temperature = options.temperature;
  }

  if (options.topP !== undefined) {
    params.topP = options.topP;
    params.top_p = options.topP;
  }

  if (options.maxOutputTokens !== undefined) {
    params.maxOutputTokens = options.maxOutputTokens;
    params.max_output_tokens = options.maxOutputTokens;
  }

  if (options.responseFormat !== undefined) {
    const format = options.responseFormat ?? null;
    params.responseFormat = format;
    params.response_format = format;
  }

  if (options.reasoning !== undefined) {
    params.reasoning = options.reasoning ?? null;
  }

  if (options.finalOutputJsonSchema !== undefined) {
    const schema = options.finalOutputJsonSchema ?? null;
    params.finalOutputJsonSchema = schema;
    params.final_output_json_schema = schema;
  }

  return params;
}

export interface NotificationContextPayload {
  conversation_id?: string;
  conversationId?: string;
  request_id?: string;
  requestId?: string;
  conversation?: { id?: string | null } | null;
  context?: { conversation_id?: string | null; request_id?: string | null } | null;
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

export type ChatNotification =
  | AgentMessageDeltaNotification
  | AgentMessageNotification
  | TokenCountNotification
  | RequestTimeoutNotification;

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
  if (pickString(params.conversation_id)) return true;
  if (pickString(params.conversationId)) return true;
  if (isObject(params.conversation) && pickString(params.conversation.id)) return true;
  if (isObject(params.context) && pickString(params.context.conversation_id)) return true;
  if (pickString(params.request_id)) return true;
  if (pickString(params.requestId)) return true;
  return false;
}

export function extractConversationId(params: NotificationContextPayload): string | null {
  if (!isObject(params)) return null;
  return (
    pickString(params.conversation_id) ||
    pickString(params.conversationId) ||
    (isObject(params.conversation) ? pickString(params.conversation.id) : null) ||
    (isObject(params.context) ? pickString(params.context.conversation_id) : null) ||
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

export function isSendUserTurnResult(value: unknown): value is SendUserTurnResult {
  if (!isObject(value)) return false;
  const conv =
    pickString(value.conversation_id) ||
    pickString(value.conversationId) ||
    (isObject(value.context)
      ? pickString((value.context as Record<string, unknown>).conversation_id)
      : null);
  return conv !== null;
}

export function isSendUserMessageResult(value: unknown): value is SendUserMessageResult {
  if (!isObject(value)) return false;
  const fr = value.finish_reason ?? value.status;
  if (fr !== undefined && typeof fr !== "string") return false;
  if (value.usage && !isObject(value.usage)) return false;
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

export function isJsonRpcNotification(value: unknown): value is ChatNotification {
  return (
    isAgentMessageDeltaNotification(value) ||
    isAgentMessageNotification(value) ||
    isTokenCountNotification(value) ||
    isRequestTimeoutNotification(value)
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

export function buildAddConversationListenerParams(
  options: AddConversationListenerParams
): AddConversationListenerParams & JsonObject {
  const params: AddConversationListenerParams & JsonObject = {
    conversationId: String(options.conversationId ?? ""),
  };
  if (options.experimentalRawEvents !== undefined) {
    params.experimentalRawEvents = !!options.experimentalRawEvents;
  }
  return params;
}

export function buildRemoveConversationListenerParams(
  options: RemoveConversationListenerParams
): RemoveConversationListenerParams & JsonObject {
  return {
    subscriptionId: String(options.subscriptionId ?? ""),
  };
}

function normalizeApprovalPolicy(
  value: BuildSendUserTurnOptions["approvalPolicy"]
): AskForApproval {
  if (typeof value === "string") {
    const normalized = (value as string).trim().toLowerCase();
    if (VALID_APPROVAL_POLICIES.has(normalized)) {
      return normalized as AskForApproval;
    }
  }
  return APPROVAL_FALLBACK;
}

function normalizeReasoningSummary(value: BuildSendUserTurnOptions["summary"]): ReasoningSummary {
  if (typeof value === "string") {
    const normalized = (value as string).trim().toLowerCase();
    if (VALID_REASONING_SUMMARIES.has(normalized)) {
      return normalized as ReasoningSummary;
    }
  }
  return SUMMARY_FALLBACK;
}

function normalizeReasoningEffort(
  value: BuildSendUserTurnOptions["effort"]
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

function normalizeSandboxPolicy(value: BuildSendUserTurnOptions["sandboxPolicy"]): SandboxPolicy {
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
    if (!VALID_SANDBOX_MODES.has(mode)) {
      return SANDBOX_FALLBACK;
    }
    if (mode === "workspace-write") {
      const policy: SandboxPolicy = {
        type: "workspace-write",
      };
      if (Array.isArray((value as any).writable_roots)) {
        policy.writable_roots = [...((value as any).writable_roots as string[])];
      }
      if (typeof (value as any).network_access === "boolean") {
        policy.network_access = (value as any).network_access as boolean;
      }
      if (typeof (value as any).exclude_tmpdir_env_var === "boolean") {
        policy.exclude_tmpdir_env_var = (value as any).exclude_tmpdir_env_var as boolean;
      }
      if (typeof (value as any).exclude_slash_tmp === "boolean") {
        policy.exclude_slash_tmp = (value as any).exclude_slash_tmp as boolean;
      }
      return policy;
    }
    if (mode === "read-only") {
      return { type: "read-only" };
    }
    return { type: "danger-full-access" };
  }

  if (typeof value === "string") {
    const normalized = (value as string).trim().toLowerCase();
    if (VALID_SANDBOX_MODES.has(normalized)) {
      if (normalized === "workspace-write") {
        return { type: "workspace-write" };
      }
      if (normalized === "read-only") {
        return { type: "read-only" };
      }
      return { type: "danger-full-access" };
    }
  }

  return SANDBOX_FALLBACK;
}

function toNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const str = String(value);
  const trimmed = str.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalApprovalPolicy(
  value: BuildSendUserTurnOptions["approvalPolicy"]
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
  value: BuildNewConversationOptions["sandbox"]
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
