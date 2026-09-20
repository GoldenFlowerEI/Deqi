import type {
  AssistantEvent,
  ContentBlock,
  Message,
  Model,
  ToolDefinition,
} from '@deqi/ai';

/**
 * Tool interface for the agent runtime.
 *
 * The runtime is the only consumer; the LLM-facing shape is just the
 * `ToolDefinition` we send to the provider.
 */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
  /**
   * Mark tools that can run in parallel with other concurrency-safe tools.
   * Defaults to false (fail-closed).
   */
  isConcurrencySafe?(args: unknown): boolean;
  /**
   * Approve / deny / ask before execution. v0.1 default: always allow.
   * Permission orchestration lives in higher layers (coding-agent, extensions).
   */
  checkPermissions?(args: unknown): Promise<PermissionDecision>;
  /**
   * Execute the tool. Return content blocks that will be wrapped in a
   * tool_result message and appended to the conversation.
   */
  execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  /** Optional human-readable label for UI rendering. */
  label?: string;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message?: string };

export interface ToolExecutionContext {
  cwd: string;
  signal: AbortSignal;
  /** The full message history at the time of this call. */
  messages: Message[];
  /** Allow tools to emit progress events while executing. */
  onUpdate?: (delta: ToolUpdate) => void;
  /** Logger channel. */
  log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Optional harness-level context for tools that need to spawn other
   * agents (e.g. the `subagent` tool). The shape is intentionally
   * loose (`unknown`) so the agent-core package doesn't have to
   * depend on the ai package or the coding-agent package.
   */
  harness?: Record<string, unknown>;
}

export interface ToolUpdate {
  kind: 'progress' | 'partial' | 'note';
  content: ContentBlock[];
}

export interface ToolExecutionResult {
  content: ContentBlock[];
  isError?: boolean;
  /** Optional structured metadata that the LLM does not see. */
  details?: Record<string, unknown>;
}

// Agent state + events ----------------------------------------------------

export interface AgentState {
  messages: Message[];
  system: string;
  model: Model;
  tools: AgentTool[];
  maxTurns: number;
  cwd: string;
  turnCount: number;
  totalUsage: { input: number; output: number; costUsd: number };
  aborted: boolean;
}

export type AgentEvent =
  | { type: 'agent_start'; model: Model }
  | { type: 'turn_start'; turn: number }
  | { type: 'message_update'; role: 'assistant'; event: AssistantEvent }
  | {
      type: 'tool_execution_start';
      toolName: string;
      toolUseId: string;
      input: unknown;
    }
  | {
      type: 'tool_execution_update';
      toolUseId: string;
      delta: ToolUpdate;
    }
  | {
      type: 'tool_execution_end';
      toolName: string;
      toolUseId: string;
      result: ToolExecutionResult;
      durationMs: number;
    }
  | { type: 'turn_end'; turn: number; stopReason: AgentEvent_TerminateReason }
  | { type: 'agent_end'; totalUsage: AgentState['totalUsage'] }
  | { type: 'error'; message: string }
  | { type: 'context_compacted'; tokensBefore: number; tokensAfter: number; turn: number }
  | { type: 'tool_reflection'; toolName: string; hint: string; kind: 'error' | 'empty' | 'large' | null }
  | { type: 'memory_retrieved'; factCount: number; patternCount: number; prefCount: number; query: string }
  | { type: 'skills_suggested'; skills: Array<{ name: string; score: number }> };

export type AgentEvent_TerminateReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'max_turns'
  | 'aborted'
  | 'error';

export type AgentEventHandler = (event: AgentEvent) => void;

// Introspection ------------------------------------------------------------

/**
 * v0.4: the agent-core types re-export a minimal IntrospectionLayer
 * shape so we can use it in agent.ts without a dependency on
 * @deqi/introspection. The full interface (with subscribe, getGuidance,
 * etc.) lives in the introspection package.
 */
export interface IntrospectionLayer {
  observe(snapshot: BehaviorSnapshot): Promise<void>;
  getGuidance?(): Promise<string>;
}

export interface BehaviorSnapshot {
  timestamp: string;
  toolUsage: Array<{ name: string; isError: boolean; durationMs: number }>;
  filesTouched: string[];
  notes: string[];
}
