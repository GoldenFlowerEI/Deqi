/**
 * Wire types for the deqi desktop app. Mirrors the server's
 * `packages/server/src/types.ts` — kept here as a local copy so
 * the desktop doesn't need a workspace dep on @deqi/server
 * (which would create a circular workspace graph).
 *
 * If you change one, change the other. We have a smoke test
 * (server-smoke.ts) that exercises the boundary.
 */

export type PermissionMode = 'autonomous' | 'smart' | 'manual' | 'chat_only';

// ─── Server → Client (WS events) ─────────────────────────────────

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
  // v3.6: auto-context-compaction
  | { type: 'context_compacted'; tokensBefore: number; tokensAfter: number; turn: number }
  // v3.7: ambient context events
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

export type WsServerMessage =
  | { type: 'hello_ack'; protocol: 1; server_version: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'session_event'; session_id: string; event: SessionEvent }
  | { type: 'sessions_list'; sessions: SessionSummary[] }
  | { type: 'session_details'; session: SessionDetails }
  | { type: 'session_created'; session: SessionDetails }
  | { type: 'session_deleted'; session_id: string };

// ─── Client → Server (WS commands) ──────────────────────────────

export type WsClientMessage =
  | { type: 'hello'; protocol: 1 }
  | { type: 'user_message'; session_id: string; text: string; model?: string }
  | {
      type: 'permission_response';
      request_id: string;
      decision: 'allow' | 'allow_session' | 'deny';
    }
  | { type: 'abort'; session_id: string };

// ─── REST payloads ──────────────────────────────────────────────

export interface SessionSummary {
  id: string;
  cwd: string;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  is_latest: boolean;
}

export interface SessionDetails extends SessionSummary {
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
  description?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  input_schema: unknown;
  concurrency_safe: boolean;
}

export interface ServerConfig {
  default_model: string;
  providers: Record<string, { has_key: boolean; key_tail: string | null; base_url?: string }>;
  permission_mode: PermissionMode;
  show_surprise: boolean;
  enable_reflection: boolean;
}

// ─── v2.1: search ─────────────────────────────────────────────────

export interface SearchHit {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: string;
  hits: Array<{ role: string; snippet: string; ts: string }>;
  hitCount: number;
}

export interface SearchResponse {
  results: SearchHit[];
  query: string;
  total: number;
}

// ─── v2.1: schedule (cron-like) ───────────────────────────────────

export type ScheduleCadence = '5m' | '15m' | '30m' | '1h' | '6h' | 'daily' | 'weekly';

export interface ScheduleItem {
  id: string;
  name: string;
  prompt: string;
  cadence: ScheduleCadence;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: 'ok' | 'error';
  lastRunNote?: string;
}

// ─── v2.1: file tree (for @-mention) ──────────────────────────────

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

// ─── v2.1: mobile pair ────────────────────────────────────────────

export interface MobilePair {
  id: string;
  code: string;
  deviceName: string;
  pairedAt: string;
  lastSeenAt?: string;
}
