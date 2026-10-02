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

/**
 * v0.4: one moral finding, in wire form. The shape the server sends
 * and this UI renders — deliberately flat and self-contained, so a
 * chip can show "why" without the component knowing anything about
 * the rules that produced the finding.
 */
export interface MoralFindingWire {
  rule: string;
  principle: number;
  severity: 'note' | 'warn' | 'high';
  tool: string;
  summary: string;
  consequence: string;
  evidence?: string;
}

// ─── Server → Client (WS events) ─────────────────────────────────

/**
 * v0.4: the line diff, mirroring `coding-agent/src/diff.ts`.
 *
 * Declared locally rather than imported: the desktop has no workspace
 * dependency on the coding-agent, and adding one to share two type
 * declarations would create the circular graph the header comment
 * above describes. The shapes are asserted to agree in
 * v0.4-moral-seam-test.ts.
 */
export type DiffOp = 'ctx' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface FileDiff {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
  /** Set when the file was too large to line-diff. */
  tooLarge?: boolean;
}

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
      /** v0.4: a line diff for `write` / `edit`. See server types. */
      diff?: unknown;
    }
  | {
      type: 'permission_request';
      request_id: string;
      tool_name: string;
      tool_input: unknown;
      /**
       * v0.4: present and non-empty only when the moral layer is why
       * the user is being asked. Absent means an ordinary
       * mode-based prompt.
       */
      moral?: MoralFindingWire[];
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
    }
  // v0.3: sub-agent progress.
  //
  // The server has emitted this since v3.9.1 and this union did not
  // contain it, so every sub-agent event was delivered and then
  // dropped: the desktop showed a `tool_start` for the `subagent`
  // tool, then nothing until the sub-agent's final text arrived all
  // at once. A long sub-agent run looked like a hang.
  //
  // `ev` is the sub-agent's own AgentEvent passed through verbatim,
  // so the type is intentionally open — the UI reads only the few
  // fields below.
  | {
      type: 'subagent_event';
      subagent: { model: string; cwd: string };
      ev: {
        type: string;
        toolName?: string;
        toolUseId?: string;
        input?: unknown;
        event?: { type: string; delta?: string };
        [k: string]: unknown;
      };
    }
  // ── v0.4: the moral layer ────────────────────────────────────
  // Hand-maintained to match server/src/types.ts. The two are asserted
  // to agree in v0.4-moral-seam-test.ts — that test exists because this
  // file already drifted once (subagent_event), silently deleting a
  // whole feature from the UI while the server kept sending it.
  | {
      type: 'moral_audit';
      tool: string;
      findings: MoralFindingWire[];
    }
  | {
      type: 'turn_review';
      headline: string | null;
      observation: string | null;
      high: number;
      warn: number;
      note: number;
      findings: MoralFindingWire[];
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
