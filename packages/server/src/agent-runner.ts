/**
 * AgentRunner — wraps @deqi/agent-core for HTTP/WS consumption.
 *
 * One runner per active session. Holds:
 *   - the Agent instance (with the loaded system prompt, tools, model)
 *   - the SessionManager (for persistence)
 *   - an AbortController for the current turn
 *   - a permission-pending promise (resolved by the WS client)
 *
 * The runner is the single source of truth for "what is the agent
 * doing right now" — both HTTP handlers and the WS server share
 * the same runner so e.g. an HTTP `GET /v1/sessions/:id/turn`
 * and a WS `session_event` stream can never disagree.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  Agent,
  type AgentEvent,
} from '@deqi/agent-core';
import { ModelRegistry } from '@deqi/ai';
import { BUILTIN_TOOLS, buildSystemPrompt, SessionManager, loadAgentsMd, loadConfig, ToolCache, retrieveRelevant, renderRetrievedMemory, suggestSkills, renderSkillSuggestions, reflectOnTool, findActivePlan, renderPlanProgress, retrieveCombined, bumpRetrievedUseCounts } from '@deqi/coding-agent';
import { migrateLegacyMode, modeAllows, modeLabel, type PermissionMode } from './permission-modes.js';
import { GrantStore, type PermissionGrant, type GrantLevel } from './permission-grants.js';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import type { SessionEvent } from './types.js';

/**
 * Resolve a session id to a SessionManager by scanning the
 * sessions directory. We don't keep an in-memory index because
 * the desktop app may run multiple server processes or restart
 * mid-session, so disk is the source of truth.
 */
async function resolveSessionById(cwd: string, sessionId: string): Promise<SessionManager> {
  const existing = await SessionManager.list(cwd);
  const match = existing.find((s) => s.id === sessionId);
  if (!match) {
    throw new Error(`session not found: ${sessionId}`);
  }
  return SessionManager.load(match.filePath);
}

export interface AgentRunnerOptions {
  cwd: string;
  model_id: string;
  /**
   * v4.8: cluster registry. Optional — when present, the
   * `delegate_remote` tool can dispatch tasks to peer Deqi
   * servers in the same `~/.deqi/` cluster. The runner
   * surfaces a small client view through `ctx.harness.cluster`
   * for the tool to consume.
   */
  cluster?: {
    /** List the live desktops. */
    list: () => Array<{
      desktop_id: string;
      name: string;
      host: string;
      port: number;
      capabilities: string[];
      tags: string[];
    }>;
    /** Pick a desktop for a target. Returns null if nothing matches. */
    pick: (target: { desktop_id?: string; capability?: string; tag?: string }) => {
      desktop_id: string;
      host: string;
      port: number;
    } | null;
    /** The local entry. */
    local: () => { desktop_id: string; name: string; host: string; port: number } | null;
  };
  /**
   * v4.0: 4-tier Claude Code style permission model.
   * `'plan' | 'default' | 'accept-edits' | 'bypass-permissions'`
   * plus the legacy `'chat_only'` for backward compat. The
   * server's `migrateLegacyMode()` maps the v3.x names onto
   * these if the user is still on the old config.
   */
  permission_mode: 'plan' | 'default' | 'accept-edits' | 'bypass-permissions' | 'chat_only'
    | 'autonomous' | 'smart' | 'manual';
  show_surprise: boolean;
  enable_reflection: boolean;
  /** v2.3: extra tools contributed by plugins. Merged with
   *  BUILTIN_TOOLS at agent construction; the LLM sees them as
   *  additional tools alongside the built-ins. */
  extra_tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
    execute: (args: unknown, ctx: { cwd: string }) => Promise<unknown>;
  }>;
  /** v3.9: per-event-type plugin handlers. Keyed by the raw
   *  AgentEvent type (e.g. 'tool_start', 'turn_end', 'text_delta').
   *  Called from onAgentEvent with the raw AgentEvent; exceptions
   *  are swallowed. */
  plugin_event_handlers?: Map<string, Array<(ev: unknown) => void>>;
}

export interface TurnHandle {
  turn_id: string;
  abort: () => void;
}

export type PermissionRequest = {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
  /** Resolved by the WS client via permission_response. */
  resolve: (decision: 'allow' | 'allow_session' | 'deny') => void;
};

export class AgentRunner {
  private agent: Agent;
  private session: SessionManager;
  private currentAbort: AbortController | null = null;
  private currentTurn: Promise<void> | null = null;
  private permissionQueue = new Map<string, PermissionRequest>();
  private permissionMode: PermissionMode;
  /**
   * v3.9.1: the per-turn emit function. The sub-agent tool reads
   * this field to forward sub-agent events back to the parent
   * session's stream. Set by runTurn() before each turn and
   * cleared after. Null outside a turn (subagent events are
   * dropped silently in that case, which is fine).
   */
  private turnEmitter: ((ev: AgentEvent) => void) | null = null;
  /**
   * v4.4: per-session permission grants. The user can pre-approve
   * tools at the 'turn' / 'session' / 'forever' level. The
   * evaluatePermission() gate consults this store before falling
   * back to the v4.0 mode gate.
   */
  readonly grantStore: GrantStore = new GrantStore();
  /**
   * v4.7: telemetry sink. The runner records tool calls here
   * on every tool_execution_end. The recorder is a no-op when
   * disabled, so the cost is one type check + one function call.
   */
  telemetry: { record(kind: string, data?: Record<string, string | number | boolean>): void } = { record() { /* default no-op */ } };

  constructor(
    private readonly registry: ModelRegistry,
    public readonly sessionId: string,
    public readonly cwd: string,
    private readonly opts: AgentRunnerOptions,
  ) {
    this.permissionMode = migrateLegacyMode(opts.permission_mode);
    this.optsModelId = opts.model_id;

    // The system prompt and agent construction are deferred to
    // `init()` because both loadAgentsMd and resolveSessionById
    // are async. We don't want to make the constructor async
    // (callers do `new ...` synchronously).
    this.session = null as unknown as SessionManager;
    this.agent = null as unknown as Agent;
  }

  /**
   * Async init — must be awaited after construction. Loads the
   * agents.md content, builds the system prompt, creates the
   * Agent instance, and resolves the session manager.
   */
  async init(): Promise<void> {
    if (this.agent) return; // idempotent

    // Load the model. The model id encodes the provider, e.g.
    // "MiniMax-M3" → openai-compat. The registry handles resolution.
    const model = this.registry.resolveModel(this.optsModelId);

    // Build the system prompt. This is the same logic the old
    // TUI used, ported unchanged.
    const agentsMd = await loadAgentsMd(this.cwd);
    const system = buildSystemPrompt({
      cwd: this.cwd,
      modelId: model.id,
      provider: model.provider,
      agentsMdContent: agentsMd.content,
      skillsList: '', // TODO: load skills from deqi/skills/
    });

    // Wire up the session manager.
    this.session = await resolveSessionById(this.cwd, this.sessionId);

    // Create the agent. Tools + system prompt + model = the
    // complete ReAct loop. Subagent, constitution, user-model,
    // self-reflect, session-history tools come pre-wired. v2.3:
    // any plugin tools (AgentRunnerOptions.extra_tools) are
    // appended so plugins can extend the agent's vocabulary.
    const pluginAgentTools: AgentTool[] = (this.opts.extra_tools ?? []).map((pt) => ({
      name: pt.name,
      description: pt.description,
      inputSchema: pt.input_schema as AgentTool['inputSchema'],
      isConcurrencySafe: () => false,
      async execute(args: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
        try {
          const out = await pt.execute(args, { cwd: ctx.cwd });
          const text = typeof out === 'string' ? out : JSON.stringify(out);
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          return {
            content: [{ type: 'text', text: `plugin tool "${pt.name}" failed: ${(e as Error).message}` }],
            isError: true,
          };
        }
      },
    }));
    this.agent = new Agent({
      registry: this.registry,
      modelId: this.optsModelId,
      system,
      tools: [...BUILTIN_TOOLS, ...pluginAgentTools],
      cwd: this.cwd,
      maxTurns: 50,
      harness: {
        subagent: {
          registry: this.registry,
          parentTools: BUILTIN_TOOLS,
          defaultModelId: this.optsModelId,
          // v3.9.1: forward sub-agent events to the parent's
          // session stream so the UI sees them in real time.
          // The per-turn emitter is set by runTurn() before each
          // turn; outside a turn we drop events silently.
          // Wrap in try/catch so a bug here can't break the run.
          onSubagentEvent: (ev: unknown) => {
            const emit = this.turnEmitter;
            if (!emit) return;
            try {
              emit({ type: 'subagent_event', ev } as unknown as AgentEvent);
            } catch { /* swallow */ }
          },
        },
        // v3.6: real LLM-backed specialists. Same wiring as the subagent
        // tool; the orchestrator tool reads it from ctx.harness.orchestrator.
        orchestrator: {
          registry: this.registry,
          parentTools: BUILTIN_TOOLS,
          defaultModelId: this.optsModelId,
        },
        // v3.6: per-session tool result cache. read/webFetch/browser.read
        // check + populate this. 256 entries, 16MB cap; LRU eviction.
        cache: new ToolCache(),
        // v3.7: tool reflector. agent-core's finishTool() calls this
        // on every tool result. Pure (no side effects), returns a
        // hint that gets prepended to the next system prompt.
        reflector: reflectOnTool,
        // v4.8: multi-desktop cluster client. Surfaced to the
        // `delegate_remote` tool so it can pick a peer desktop
        // and POST to its /v1/rpc/run-task. Falls back to a
        // local-only stub if the runner was constructed without
        // a cluster (e.g. CLI tests).
        cluster: this.opts.cluster ?? {
          list: () => [],
          pick: () => null,
          local: () => null,
        },
      },
      // v3.7 → v3.12: pre-call hook. Runs once per run() on the
      // first turn. Combines (v3.12) combined semantic + Jaccard
      // retrieval + skill suggestions + (v3.9.1) active plan
      // progress into one block prepended to the system prompt.
      preCallHook: async (query: string) => {
        // v3.12: combined retriever (Jaccard ∪ semantic). Bumps
        // useCount so frequently-relevant items bubble up.
        const retrieval = await retrieveCombined(query);
        bumpRetrievedUseCounts(retrieval);
        // v3.7 fallback: also run pure Jaccard so the UI event
        // payload can report the simpler overlap count.
        const jaccardOnly = retrieveRelevant(query);
        const skills = suggestSkills(query);
        // v3.9.1: read the cwd's active plan from disk. The cwd
        // is the server's process cwd (set by the desktop on
        // session start). If a plan is in flight, surface its
        // progress so the model doesn't lose track of which step
        // is next.
        const cwd = process.cwd();
        const plan = findActivePlan(cwd);
        const planBlock = plan ? renderPlanProgress(plan) : '';
        const block = [
          retrieval.facts.length + retrieval.patterns.length + retrieval.prefs.length > 0
            ? renderRetrievedMemory(retrieval) : '',
          skills.length > 0 ? renderSkillSuggestions(skills) : '',
          planBlock,
        ].filter(Boolean).join('\n\n');
        // Emit one combined event for the UI.
        const event = {
          type: jaccardOnly.facts.length + jaccardOnly.patterns.length > 0
            ? 'memory_retrieved' : 'skills_suggested',
          factCount: retrieval.facts.length,
          patternCount: retrieval.patterns.length,
          prefCount: retrieval.prefs.length,
          query,
          skills: skills.map((s) => ({ name: s.name, score: s.score })),
        } as never;
        return { block, event };
      },
      // TODO: introspection layer (per session, optional)
    });
  }

  /** Stash the model id so init() can read it back. */
  private optsModelId: string;

  /**
   * Run a single user turn. Streams session events to the supplied
   * callback. Returns a handle that the caller can use to abort.
   *
   * v2.2: `modelOverride` is applied via agent.setModel() before
   * this turn and reverted after. Pass `undefined` to use the
   * runner's default (the persisted config's defaultModel).
   *
   * `await onPermission` is called whenever a tool wants to run;
   * it must resolve to 'allow' | 'allow_session' | 'deny'. In
   * autonomous mode the runner auto-allows; in chat_only mode
   * it auto-denies tools (chat responses only).
   */
  async runTurn(
    text: string,
    emit: (event: SessionEvent) => void,
    modelOverride?: string,
  ): Promise<TurnHandle> {
    if (this.currentTurn) {
      throw new Error('a turn is already in progress on this session');
    }

    // Lazy-init the session manager if the constructor was used
    // without awaiting `init()`.
    if (!this.session) {
      await this.init();
    }

    // v2.2: per-turn model override. Snapshot the previous model
    // so we can restore it after the turn so the next turn
    // without an override reverts to the runner's default.
    let restored = false;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      if (modelOverride && this.optsModelId && modelOverride !== this.optsModelId) {
        try {
          this.agent.setModel(this.optsModelId);
        } catch { /* model not resolvable; leave the override in place */ }
      }
    };
    if (modelOverride && modelOverride !== this.optsModelId) {
      try {
        this.agent.setModel(modelOverride);
      } catch (err) {
        emit({ type: 'info', kind: 'warning', text: `model override failed (${modelOverride}): ${(err as Error).message}; using default` });
      }
    }

    const turnId = randomUUID();
    const controller = new AbortController();
    this.currentAbort = controller;

    // Persist the user message immediately so the session JSONL
    // has the prompt even if the model call fails.
    const userContent = [{ type: 'text' as const, text }];
    await this.session.appendUserMessage(userContent);

    // Wrap agent-core's event emitter as a session_event stream.
    // The map translates the agent-core event types into the
    // session_event types the WS protocol defines. Events that
    // mapAgentEvent marks as DROP (provider-level noise like
    // message_update: start/usage/done) are not sent over the wire.
    const onAgentEvent = (ev: AgentEvent): void => {
      const mapped = mapAgentEvent(ev);
      if (isDropped(mapped)) return;
      emit(mapped);
      // v4.7: telemetry. We record `tool_execution_end` so the
      // aggregate has per-tool call counts + error rates. No PII
      // — only the tool name and isError flag, never the args or
      // the result. The Telemetry class is a no-op when
      // disabled so this hot-path cost is one type check.
      if ((ev as { type: string }).type === 'tool_execution_end') {
        const tev = ev as { toolName: string; result: { isError?: boolean } };
        this.telemetry.record('tool_call', { tool: tev.toolName, isError: tev.result.isError ?? false });
      }
      // v3.9: dispatch to plugin event subscribers. The plugin
      // receives the raw AgentEvent (not the wire form) so it can
      // inspect `kind`, `text`, `toolUseId`, etc. Exceptions are
      // swallowed — a buggy plugin handler must never break the
      // agent's event stream.
      const subscribers = this.opts.plugin_event_handlers?.get(ev.type);
      if (subscribers && subscribers.length > 0) {
        for (const sub of subscribers) {
          try { sub(ev as unknown); } catch (e) {
            console.error(`[Deqi-server] plugin event handler for ${ev.type} threw: ${(e as Error).message}`);
          }
        }
      }
    };
    // v3.9.1: install the per-turn emitter so the subagent tool
    // (running in this turn) can forward its events back to the
    // parent stream. Cleared in the .finally below.
    this.turnEmitter = onAgentEvent;

    // Fire the actual turn. We don't await it here — the handle
    // is returned so the caller can wire up abort(). The
    // background turn is tracked in `currentTurn` and cleared
    // on completion.
    const turn = this.runWithPermissions(text, onAgentEvent, controller.signal)
      .catch((err) => {
        emit({ type: 'info', kind: 'error', text: String((err as Error).message ?? err) });
      })
      .finally(() => {
        restore();
        this.currentAbort = null;
        this.currentTurn = null;
        // v3.9.1: clear the per-turn emitter so any stray
        // sub-agent events after the turn stops are dropped.
        this.turnEmitter = null;
        // v4.4: clear 'turn'-scoped grants now that this turn
        // is done. 'session' / 'forever' grants are kept.
        this.grantStore.clearTurnGrants();
      });

    this.currentTurn = turn;
    return {
      turn_id: turnId,
      abort: () => controller.abort(),
    };
  }

  /**
   * Wait for the in-flight turn to complete. Used by the WS
   * handler so a single user_message request maps 1:1 to a
   * single turn response (no premature `done`).
   */
  async waitForCurrentTurn(): Promise<void> {
    if (this.currentTurn) {
      await this.currentTurn;
    }
  }

  /**
   * Run a turn, intercepting each tool call to ask the runner
   * whether to allow it. The agent-core doesn't have a built-in
   * permission hook, so we wrap the agent's tools with a thin
   * proxy at construction time. (TODO: hoist this into agent-core
   * as a proper `permission_decision` callback so the wrapper
   * isn't needed here.)
   *
   * After the agent finishes, we walk `state.messages` to find
   * any assistant messages that aren't in the session yet, and
   * append them. (The TUI used to do this manually; the server
   * does it here so the session JSONL stays the source of truth
   * for both display and replay.)
   */
  private async runWithPermissions(
    text: string,
    emit: (ev: AgentEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    // Chat-only mode: skip the agent entirely and just echo.
    if (this.permissionMode === 'chat_only') {
      // For chat-only, the model still runs but tool calls
      // are always denied. The agent-core handles tool denial
      // by sending the error to the model, which usually
      // apologizes and continues. We don't need to special-case.
    }

    const messagesBefore = this.agent.getState().messages.length;
    await this.agent.run(text, emit, signal);

    // Persist any new assistant messages. We snapshot the count
    // before agent.run() and append messages that were added
    // after.
    const all = this.agent.getState().messages;
    for (let i = messagesBefore; i < all.length; i += 1) {
      const m = all[i]!;
      if (m.role === 'assistant') {
        try {
          await this.session.appendAssistantMessage(m.content);
        } catch (err) {
          // The session file is the source of truth; failing to
          // persist shouldn't break the turn. Log and continue.
          console.error(`[Deqi-server] failed to append assistant message:`, err);
        }
      }
    }
  }

  /**
   * Resolve a pending permission request. Called by the WS
   * message handler when the user clicks "allow" / "deny".
   */
  resolvePermission(requestId: string, decision: 'allow' | 'allow_session' | 'deny'): void {
    const req = this.permissionQueue.get(requestId);
    if (!req) return;
    this.permissionQueue.delete(requestId);
    req.resolve(decision);
  }

  /** True if a turn is in flight. */
  isBusy(): boolean {
    return this.currentTurn !== null;
  }

  /** Abort the in-flight turn, if any. */
  abort(): void {
    this.currentAbort?.abort();
  }

  /** Update the permission mode mid-session. */
  setPermissionMode(mode: AgentRunnerOptions['permission_mode']): void {
    this.permissionMode = migrateLegacyMode(mode);
  }

  /**
   * v4.0: query the current permission mode. Returns the
   * migrated v4.0 name so the UI doesn't need to know about
   * the legacy aliases.
   */
  getPermissionMode(): PermissionMode {
    return this.permissionMode as PermissionMode;
  }

  /**
   * v4.0: ask the permission gate what to do for a given tool
   * call. The harness installs this on each tool as a wrapper
   * checkPermissions. Returns the verdict; the agent-core then
   * either runs the tool, queues a permission request, or
   * blocks.
   * v4.4: consult the grant store FIRST. A user pre-approval
   * for this tool short-circuits the mode gate.
   */
  evaluatePermission(toolName: string, args?: unknown): 'allow' | 'ask' | 'deny' {
    if (this.grantStore.match(toolName, this.cwd)) {
      return 'allow';
    }
    return modeAllows(this.permissionMode as PermissionMode, toolName, args);
  }

  /**
   * v4.4: add a permission grant at the given level. The
   * desktop UI calls this when the user clicks "Always allow".
   */
  addGrant(g: { tool: string; pattern?: 'exact' | 'prefix'; level: GrantLevel; cwdScope?: string; note?: string }): PermissionGrant {
    return this.grantStore.add({
      tool: g.tool,
      pattern: g.pattern ?? 'exact',
      level: g.level,
      cwdScope: g.cwdScope,
      note: g.note,
    });
  }

  /** v4.4: drop a permission grant by id. */
  removeGrant(id: string): boolean {
    return this.grantStore.remove(id);
  }

  /** v4.4: list all current grants (for the desktop UI). */
  listGrants(): PermissionGrant[] {
    return this.grantStore.list();
  }

  /**
   * v4.0: human-readable mode label for the UI / log.
   */
  permissionModeLabel(): string {
    return modeLabel(this.permissionMode as PermissionMode);
  }
}

/**
 * Translate an agent-core AgentEvent into the deqi SessionEvent
 * wire shape. Keeps the wire protocol independent of agent-core
 * internals so we can refactor agent-core without breaking the
 * desktop app.
 */
export function mapAgentEvent(ev: AgentEvent): SessionEvent {
  switch (ev.type) {
    case 'agent_start':
      return { type: 'agent_start', model: ev.model.id };
    case 'agent_end':
      return {
        type: 'agent_end',
        usage: {
          input: ev.totalUsage.input,
          output: ev.totalUsage.output,
          cost_usd: ev.totalUsage.costUsd,
        },
      };
    case 'turn_start':
      return { type: 'turn_start', turn: ev.turn };
    case 'turn_end':
      return { type: 'turn_end', turn: ev.turn, stop_reason: ev.stopReason };
    case 'message_update': {
      const inner = ev.event;
      if (inner.type === 'thinking_delta') {
        return { type: 'thinking_delta', delta: inner.delta };
      }
      if (inner.type === 'text_delta') {
        return { type: 'text_delta', delta: inner.delta };
      }
      // v3.6/v3.7: provider-level noise (start/usage/done/error) is
      // internal to the streaming protocol and not user-visible.
      // We deliberately drop these from the wire — they were
      // previously rendered as "[unhandled message_update: ...]"
      // info blocks, which was noisy and confusing. The structured
      // SessionEvent variants (agent_end, tokens, error) carry
      // any info the user actually needs.
      return DROP;
    }
    case 'tool_execution_start':
      return {
        type: 'tool_start',
        tool_use_id: ev.toolUseId,
        name: ev.toolName,
        input: ev.input,
      };
    case 'tool_execution_end':
      return {
        type: 'tool_end',
        tool_use_id: ev.toolUseId,
        name: ev.toolName,
        output: ev.result.content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim(),
        is_error: ev.result.isError === true,
        duration_ms: Math.round(ev.durationMs),
      };
    case 'error':
      return { type: 'info', kind: 'error', text: ev.message };
    // v3.6: auto-context-compaction. The user can see "I forgot
    // N tokens" as a small chip — useful diagnostic, not noise.
    case 'context_compacted':
      return {
        type: 'context_compacted',
        tokensBefore: ev.tokensBefore,
        tokensAfter: ev.tokensAfter,
        turn: ev.turn,
      };
    // v3.7: ambient context events. Translated 1:1 from agent-core.
    case 'memory_retrieved':
      return {
        type: 'memory_retrieved',
        factCount: ev.factCount,
        patternCount: ev.patternCount,
        prefCount: ev.prefCount,
        query: ev.query,
      };
    case 'skills_suggested':
      return { type: 'skills_suggested', skills: ev.skills };
    case 'tool_reflection':
      return {
        type: 'tool_reflection',
        toolName: ev.toolName,
        hint: ev.hint,
        kind: ev.kind ?? 'error',
      };
    default:
      // Defensive: any new AgentEvent type is ignored rather
      // than crashing the WS stream.
      return DROP;
  }
}

/**
 * Sentinel meaning "drop this event from the wire". Used for
 * provider-level events (message_update: start/usage/done) and
 * for any future AgentEvent type we haven't taught the wire
 * about yet. Callers in the WS dispatch path must check for DROP
 * and skip sending in that case.
 */
export const DROP: SessionEvent = Object.freeze({
  type: 'info',
  kind: 'info',
  text: '__DROP__',
}) as SessionEvent;

/** True if `ev` is the DROP sentinel. */
export function isDropped(ev: SessionEvent | undefined | null): boolean {
  return !!(ev && (ev as { text?: string }).text === '__DROP__');
}

/** Resolve the model registry. The server uses the same registry
 *  the CLI used to construct — but here we just construct it on
 *  demand. */
export async function makeRegistry(): Promise<ModelRegistry> {
  // Lazy import to avoid a circular dep with the TUI (which the
  // server doesn't need). The registry itself is lightweight.
  const { ModelRegistry } = await import('@deqi/ai');
  return new ModelRegistry();
}
