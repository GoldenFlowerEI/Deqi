/**
 * Core types for the unified LLM API.
 * Designed after pi.dev's pi-ai, opencode's provider types, and Claude Code's
 * message-block structure — but deliberately minimal for v0.1.
 */

export type Provider = 'anthropic' | 'openai' | 'google' | 'openai-compat' | 'mock';

export type Role = 'user' | 'assistant' | 'tool' | 'system';

// Content blocks ----------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  /** Either a base64 data URL or an https URL. */
  source:
    | { kind: 'base64'; mediaType: string; data: string }
    | { kind: 'url'; url: string };
}

export interface ToolUseBlock {
  type: 'tool_use';
  /** Provider-issued id. Replayed in the matching ToolResultBlock. */
  id: string;
  name: string;
  /** Validated by the tool's inputSchema; not by the LLM layer. */
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: TextBlock[];
  isError?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /** Provider signature blob for replay. */
  signature?: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock;

export interface Message {
  role: Role;
  content: ContentBlock[] | string;
  /** For tool messages on Anthropic, the tool name. */
  name?: string;
}

// Tools -------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

// Model + Request ---------------------------------------------------------

export interface ModelCost {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read tokens, if the provider supports it. */
  cacheRead?: number;
  /** USD per 1M cache-write tokens, if the provider supports it. */
  cacheWrite?: number;
}

export interface Model {
  id: string;
  /** Human-readable label, e.g. "Claude Sonnet 4.5". */
  displayName: string;
  provider: Provider;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  cost?: ModelCost;
}

export interface CompletionRequest {
  model: Model;
  messages: Message[];
  system?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  /** Hint: prompt-cache controls. Implementation may ignore. */
  cache?: { enabled: boolean };
  signal?: AbortSignal;
}

// Stream events -----------------------------------------------------------

export type AssistantEvent =
  | { type: 'start' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | {
      type: 'toolcall_start';
      id: string;
      name: string;
    }
  | {
      type: 'toolcall_delta';
      id: string;
      /** Partial JSON string for the input, when available. */
      inputDelta?: string;
    }
  | {
      type: 'toolcall_end';
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }
  | {
      type: 'done';
      stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error' | 'aborted';
    }
  | {
      type: 'error';
      message: string;
      /** True when the agent loop should retry this call. */
      retryable?: boolean;
      /** Provider-recommended delay before retry (Retry-After header, ms). */
      retryAfterMs?: number;
    };

// Provider registration ---------------------------------------------------

export interface StreamFunction {
  (req: CompletionRequest): AsyncIterable<AssistantEvent>;
}
