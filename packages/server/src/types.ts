/**
 * Wire types for the deqi HTTP + WebSocket server.
 *
 * The server exposes a JSON+WebSocket API consumed by the Tauri
 * desktop app (and any future client). The protocol is intentionally
 * a thin event-stream over WebSocket so the React UI can render
 * each delta incrementally without polling.
 *
 * Protocol v0.1:
 *   Client → Server:
 *     - user_message       (start a new turn)
 *     - permission_response (respond to a permission prompt)
 *     - abort               (cancel the current turn)
 *     - list_sessions       (request list)
 *     - get_session         (request details)
 *     - create_session      (new session)
 *     - delete_session      (delete a session)
 *
 *   Server → Client:
 *     - session_event        (per-session events; streamed on a
 *                              `session_id` channel so multiple
 *                              sessions can multiplex over one WS)
 *     - sessions_list        (response to list_sessions)
 *     - session_created      (response to create_session)
 *     - session_details      (response to get_session)
 *     - ack / error
 *
 * The `session_event` shape mirrors the existing AgentEvent union
 * from @deqi/agent-core, plus deqi-specific extensions for the
 * permission flow and user-facing info blocks.
 */

// ─── Client → Server ──────────────────────────────────────────────

export interface WsClientHello {
  type: 'hello';
  /** API protocol version. Server should reject mismatches. */
  protocol: 1;
  /** Auth token (optional, reserved for future multi-user). */
  auth_token?: string;
}

export type WsClientMessage =
  | WsClientHello
  | {
      type: 'user_message';
      session_id: string;
      text: string;
      /** Optional attachment paths (reserved for future). */
      attachments?: string[];
      /** v2.2: per-turn model override. If set, the runner applies
       *  it via agent.setModel() before this turn only — the next
       *  turn without a `model` field reverts to the runner's
       *  default. Does NOT mutate the persisted default. */
      model?: string;
    }
  | {
      type: 'permission_response';
      request_id: string;
      decision: 'allow' | 'allow_session' | 'deny';
    }
  | { type: 'abort'; session_id: string };

// ─── Server → Client ──────────────────────────────────────────────

export type WsServerMessage =
  | { type: 'hello_ack'; protocol: 1; server_version: string }
  | { type: 'error'; message: string; code?: string }
  | {
      type: 'session_event';
      session_id: string;
      event: SessionEvent;
    }
  | {
      type: 'sessions_list';
      sessions: SessionSummary[];
    }
  | {
      type: 'session_details';
      session: SessionDetails;
    }
  | {
      type: 'session_created';
      session: SessionDetails;
    }
  | {
      type: 'session_deleted';
      session_id: string;
    };

/**
 * Per-session event. Mirrors the AgentEvent union from agent-core
 * (we re-emit it as a tagged union over the wire) plus deqi-
 * specific extensions:
 *   - permission_request: server asks the UI to confirm a tool call
 *   - permission_resolved: server acks the user's decision
 *   - info: human-readable hint (e.g. "💡 surprise: ...")
 *   - tokens: token usage update
 */
export type SessionEvent =
  | { type: 'agent_start'; model: string }
  | { type: 'agent_end'; usage: { input: number; output: number; cost_usd?: number } }
  | { type: 'turn_start'; turn: number }
  | {
      type: 'turn_end';
      turn: number;
      stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'max_turns' | 'aborted' | 'error';
    }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  /** v3.9.1: event forwarded from a sub-agent run (sub-agent
   *  tool or orchestrator specialist). Tagged so the UI can
   *  indent or badge these distinctly. */
  | { type: 'subagent_event'; ev: unknown }
  | {
      type: 'tool_start';
      tool_use_id: string;
      name: string;
      input: unknown;
    }
  | {
      type: 'tool_end';
      tool_use_id: string;
      name: string;
      output: string;
      is_error: boolean;
      duration_ms: number;
    }
  | {
      type: 'permission_request';
      request_id: string;
      tool_name: string;
      tool_input: unknown;
    }
  | { type: 'permission_resolved'; request_id: string; decision: string }
  | { type: 'info'; kind: 'info' | 'warning' | 'error'; text: string }
  | { type: 'reflection'; note: string }
  | { type: 'tokens'; cumulative: { input: number; output: number } }
  // v3.6: auto-context-compaction. Emitted when the agent's
  // run() loop auto-compacts the message history because the
  // context window is >85% full.
  | { type: 'context_compacted'; tokensBefore: number; tokensAfter: number; turn: number }
  // v3.7: ambient context events. The server's mapAgentEvent()
  // turns these into structured wire events; the ChatArea renders
  // them as small inline chips so the user sees "I remembered X"
  // or "I suggested skill Y" without those becoming chatty
  // message blocks.
  | {
      type: 'memory_retrieved';
      factCount: number;
      patternCount: number;
      prefCount: number;
      query: string;
    }
  | {
      type: 'skills_suggested';
      skills: Array<{ name: string; score: number }>;
    }
  | {
      type: 'tool_reflection';
      toolName: string;
      hint: string;
      kind: 'error' | 'empty' | 'large';
    };

// ─── REST payloads ────────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  cwd: string;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  /** True if this is the most recent session for the cwd. */
  is_latest: boolean;
}

export interface SessionDetails extends SessionSummary {
  /** Full message list. */
  messages: Array<{
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: unknown;
    ts: string;
  }>;
}

export interface ModelInfo {
  id: string;
  provider: string;
  context_window: number;
  max_output_tokens: number;
  cost: { input: number; output: number };
  /** Free-text description for the UI. */
  description?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  /** JSON schema for the tool's input. */
  input_schema: unknown;
  /** True if the tool can run in parallel with other safe tools. */
  concurrency_safe: boolean;
}

export interface ServerConfig {
  /** Default model id when no per-session override. */
  default_model: string;
  /** Active provider keys (redacted — only last 4 chars shown). */
  providers: Record<
    string,
    {
      has_key: boolean;
      key_tail: string | null;
      base_url?: string;
    }
  >;
  /** UI permission mode (goose-style 4-tier). */
  permission_mode: 'autonomous' | 'smart' | 'manual' | 'chat_only';
  /** Show the surprise banner when UserModel reports a topic shift. */
  show_surprise: boolean;
  /** Reflection-in-action: derive a per-turn reflection entry. */
  enable_reflection: boolean;
}
