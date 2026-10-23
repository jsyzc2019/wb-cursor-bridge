/**
 * A2A (Agent2Agent) v1.0 protocol types.
 *
 * This module is a faithful, dependency-free subset of the A2A data model. It
 * exists so the bridge can speak the protocol a real A2A client expects: Agent
 * Card discovery, JSON-RPC 2.0 message/task methods, Message/Part payloads, the
 * standard TaskState machine and A2A Artifacts. The execution engine (JobManager)
 * is transport-agnostic; this file is the contract the HTTP adapter maps onto.
 *
 * References: A2A specification (Linux Foundation / a2aproject), AgentCard
 * schema https://schema.a2a.dev/v1/agent-card.json
 */

/* ----------------------------------------------------------- JSON-RPC 2.0 */

export const JsonRpcVersion = '2.0' as const;

/** JSON-RPC 2.0 error codes, extended with the A2A task-level range. */
export const A2A_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** A2A: referenced task does not exist. */
  TASK_NOT_FOUND: -32001,
  /** A2A: task is in a state that cannot be cancelled. */
  TASK_NOT_CANCELABLE: -32002,
  /** A2A: push notifications are advertised but rejected for this request. */
  PUSH_NOT_SUPPORTED: -32003,
  /** A2A: the requested operation is not supported by this agent. */
  UNSUPPORTED_OPERATION: -32004,
  /** A2A: client content types are not supported by this agent. */
  INCOMPATIBLE_CONTENT_TYPES: -32005,
  /** Auth token required or invalid for this endpoint. */
  AUTH_REQUIRED: -32097,
  /** Request rate exceeded the A2A surface's token-bucket limit. */
  RATE_LIMITED: -32050,
} as const;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/* ----------------------------------------------------------------- Parts */

export interface TextPart {
  kind: 'text';
  text: string;
  metadata?: Record<string, unknown>;
}

export interface FilePart {
  kind: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: number;
    uri?: string;
    /** Inline base64 content, used when the file is small. */
    bytes_inline?: string;
  };
  metadata?: Record<string, unknown>;
}

export interface DataPart {
  kind: 'data';
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type Part = TextPart | FilePart | DataPart;

/* -------------------------------------------------------------- Messages */

export type MessageRole = 'user' | 'agent';

export interface Message {
  role: MessageRole;
  parts: Part[];
  messageId: string;
  /** A2A v1.0: groups the message into a conversation context. */
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

/* -------------------------------------------------------------- Artifacts */

export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  /** Chunk index when an artifact is streamed in pieces. */
  index?: number;
  /** True when this event appends to a previously sent artifact. */
  append?: boolean;
  /** True on the final chunk of a streamed artifact. */
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ Tasks */

/**
 * A2A task state machine. Matches the spec; `submitted`/`auth-required`/
 * `rejected` are accepted on the wire even though the bridge never enters them,
 * so a conformant client sees a complete, recognisable state set.
 */
export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'auth-required'
  | 'rejected';

export interface TaskStatus {
  state: TaskState;
  /** Agent message accompanying a state change (e.g. the input-required question). */
  message?: Message;
  /** ISO-8601 timestamp of the transition. */
  timestamp: string;
}

export interface Task {
  id: string;
  contextId: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

/* ----------------------------------------------------- Streaming events */

export interface TaskStatusUpdateEvent {
  kind: 'status-update';
  taskId: string;
  contextId: string;
  status: TaskStatus;
  /** True when this is the last event for the task (terminal or input-required). */
  final: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  kind: 'artifact-update';
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

export type TaskEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/* ------------------------------------------------- Push notifications */

export interface PushNotificationConfig {
  url: string;
  token?: string;
  /** How the server authenticates to the webhook. */
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
}

/* --------------------------------------------------------- Agent Card */

export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
  /** Input MIME types this skill accepts. */
  inputModes?: string[];
  /** Output MIME types this skill produces. */
  outputModes?: string[];
}

export interface AgentProvider {
  organization: string;
  url: string;
}

export interface AgentCard {
  /** Schema URI for the Agent Card document. */
  schema: string;
  /** A2A protocol version this agent speaks (v0.3.x). Omitted on v1.0 cards, which use `supportedInterfaces`. */
  protocolVersion?: string;
  name: string;
  description: string;
  url: string;
  provider?: AgentProvider;
  version: string;
  documentationUrl?: string;
  capabilities: AgentCapabilities;
  /** Default input MIME types for the agent as a whole. */
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
  /** Preferred transport. */
  preferredTransport?: string;
  /** Advertised only when an auth token is configured. */
  securitySchemes?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
  /**
   * A2A v1.0: protocol versions this agent implements, each with its endpoint.
   * Replaces the v0.3.0 top-level `protocolVersion`. Absent on v0.3.0 cards.
   */
  supportedInterfaces?: Array<{ protocolVersion: string; url?: string }>;
  /** A2A v1.0: declared protocol extensions. Empty when none. */
  extensions?: unknown[];
}
