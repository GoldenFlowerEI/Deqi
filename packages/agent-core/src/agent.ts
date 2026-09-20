import {
  type AssistantEvent,
  type ContentBlock,
  type Message,
  type Model,
  type ModelRegistry,
  type StreamFunction,
  type ToolDefinition,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@deqi/ai';

import type {
  AgentEvent,
  AgentState,
  AgentTool,
  BehaviorSnapshot,
  IntrospectionLayer,
  ToolExecutionResult,
} from './types.js';

export interface RunOptions {
  cwd?: string;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface AgentConfig {
  registry: ModelRegistry;
  modelId: string;
  system: string;
  tools: AgentTool[];
  cwd: string;
  maxTurns?: number;
  /**
   * Optional harness-level context. Tools can read this via
   * `ctx.harness` in their execute(). Use this to pass a
   * SubagentContext, telemetry, custom callbacks, etc. without
   * forcing every tool to know about the harness's concrete types.
   */
  harness?: Record<string, unknown>;
  /**
   * v0.4: optional IntrospectionLayer. When set, the agent will
   * record a behavior snapshot at the end of each turn and, every
   * Nth turn, call the layer's reflect() method. The layer's
   * getGuidance() output is prepended to the system prompt on
   * subsequent turns.
   */
  introspection?: IntrospectionLayer;
  /**
   * v3.7: optional pre-call hook. Called on the first turn of
   * each `run()` to compute context-aware prompts (e.g. auto-
   * retrieved memory, skill suggestions). Returns a markdown
   * block that is prepended to the system prompt for that turn.
   * The hook may also return a structured `event` to be emitted
   * (e.g. "memory_retrieved", "skills_suggested"). Returning
   * null/undefined for the block means no augmentation.
   */
  preCallHook?: (query: string) => Promise<PreCallHookResult | null | undefined>;
}

export interface PreCallHookResult {
  /** Markdown block to prepend to the system prompt. May be empty. */
  block: string;
  /** Optional event to emit before the LLM call. */
  event?: AgentEvent;
}

type Emitter = (event: AgentEvent) => void;

/**
 * The Agent is a stateful, single-session harness.
 *
 * It implements a ReAct loop with streaming events:
 *   while (true) {
 *     stream from LLM
 *     collect tool_use blocks
 *     if none -> end
 *     execute tools (in concurrency-safe batches)
 *     append results
 *   }
 *
 * Events are produced via the emitter passed to run(); the agent's own
 * run() generator yields turn-level events (turn_start/end, message_update,
 * agent_end) while tool_execution_start/end are emitted directly through
 * the emitter (so they can be interleaved with concurrent tool calls).
 */
export class Agent {
  private registry: ModelRegistry;
  private model: Model;
  private system: string;
  private tools: AgentTool[];
  private state: AgentState;
  private signal?: AbortSignal;
  private harness?: Record<string, unknown>;
  private introspection?: IntrospectionLayer;
  private preCallHook?: (query: string) => Promise<PreCallHookResult | null | undefined>;
  /** Tool-call records from the current turn, used to build a snapshot. */
  private turnToolRecords: Array<{ name: string; isError: boolean; durationMs: number }> = [];
  private turnFilesTouched = new Set<string>();
  private turnNotes: string[] = [];
  /** v0.4: latest guidance from the introspection layer. Cached. */
  private lastGuidance = '';
  /**
   * v3.7: block prepended to the system prompt on the first turn
   * of each `run()`, computed by the preCallHook. This holds
   * "retrieved memory" + "suggested skills" + similar context.
   */
  private preCallBlock = '';
  /** True once preCallHook has run for the current `run()`. */
  private preCallRanThisRun = false;
  /** v3.7: latest tool reflection (hint for the next LLM call). */
  private lastToolReflection = '';
  /**
   * v3.6: track the message count at which we last auto-compacted,
   * so we don't compact twice in a row (compaction that produces
   * no savings would just burn tokens and the next turn would
   * immediately re-trigger). We use message count rather than
   * turn count because `turnCount` resets to 0 at the start of
   * every `run()` call, which would make the guard meaningless
   * across turns. After a compact, messages.length drops to 2
   * (the summary), so we wait until at least 6 new messages
   * accumulate before considering another compact.
   */
  private lastCompactedAtMessageCount = 0;
  /**
   * v1.1.7: idempotency flag for `loadFromSession`. The TUI's
   * `runAgentTurn` is called once per user message and reuses the
   * same Agent instance — without this flag, every turn would
   * re-inject the entire prior history into `state.messages`,
   * causing exponential duplication. With the flag, only the
   * first call to `loadFromSession` actually injects; subsequent
   * calls return 0.
   */
  private sessionLoaded = false;

  constructor(config: AgentConfig) {
    this.registry = config.registry;
    this.model = config.registry.resolveModel(config.modelId);
    this.system = config.system;
    this.tools = config.tools;
    this.state = {
      messages: [],
      system: config.system,
      model: this.model,
      tools: config.tools,
      maxTurns: config.maxTurns ?? 50,
      cwd: config.cwd,
      turnCount: 0,
      totalUsage: { input: 0, output: 0, costUsd: 0 },
      aborted: false,
    };
    this.harness = config.harness;
    this.introspection = config.introspection;
    this.preCallHook = config.preCallHook;
  }

  /** Replace the active model mid-session (e.g. on /model). */
  setModel(modelId: string): void {
    this.model = this.registry.resolveModel(modelId);
    this.state.model = this.model;
  }

  getState(): Readonly<AgentState> {
    return this.state;
  }

  abort(): void {
    this.state.aborted = true;
  }

  injectMessage(message: Message): void {
    this.state.messages.push(message);
  }

  /**
   * v1.1.7: Replay a session's user/assistant messages into the
   * agent's state. Used by `deqi -c` to actually continue the
   * conversation with full context, not just persist a new turn
   * onto the same session file.
   *
   * The caller passes the array of session entries (in order).
   * We filter to user/assistant messages, drop tool calls (the
   * harness session is for human-readable history, not tool
   * replay), and keep only the first linear chain from the leaf
   * back to the root so we don't replay both branches of a fork.
   *
   * If the session has no messages, this is a no-op.
   */
  loadFromSession(entries: ReadonlyArray<unknown>): number {
    // v1.1.7: idempotent. Once we've loaded the session into state
    // we never load again — the TUI reuses the same Agent across
    // turns, and re-injecting would duplicate every prior message.
    if (this.sessionLoaded) return 0;
    this.sessionLoaded = true;
    // Walk back from the leaf to build a linear chain.
    const byId = new Map<string, { id: string; parentId: string | null; role?: string; content?: unknown }>();
    for (const e of entries) {
      const x = e as { id?: string; parentId?: string | null; type?: string };
      if (x?.type === 'message' && x.id) {
        byId.set(x.id, x as { id: string; parentId: string | null; role?: string; content?: unknown });
      }
    }
    if (byId.size === 0) return 0;
    // Find a leaf: any message id that no other message has as parentId.
    const isChild = new Set<string>();
    for (const m of byId.values()) {
      if (m.parentId) isChild.add(m.parentId);
    }
    const leaves = [...byId.values()].filter((m) => !isChild.has(m.id));
    if (leaves.length === 0) return 0;
    const leaf = leaves[leaves.length - 1];
    // Walk back to the root.
    const chain: Array<{ id: string; parentId: string | null; role?: string; content?: unknown }> = [];
    let cur: { id: string; parentId: string | null; role?: string; content?: unknown } | undefined = leaf;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    // Filter to user/assistant and inject.
    let injected = 0;
    for (const m of chain) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      // The session stores content as ContentBlock[]; the agent
      // accepts both string and array.
      this.state.messages.push({
        role: m.role as 'user' | 'assistant',
        content: m.content as never,
      });
      injected += 1;
    }
    return injected;
  }

  /**
   * Compress the current message history into a structured 6-section summary
   * and replace the history with [summary-message, ack]. Returns the summary
   * and the token count before the compact.
   *
   * Sections (one paragraph each):
   *   GOAL:        what the user originally wanted
   *   STATE:       what has been done so far
   *   DECISIONS:   key design decisions made
   *   FILES:       files created or modified
   *   OPEN:        open issues / blockers
   *   NEXT:        planned next steps
   */
  async compact(
    emit: Emitter,
    signal?: AbortSignal,
  ): Promise<{ summary: string; tokensBefore: number } | null> {
    if (this.state.messages.length === 0) {
      return null;
    }
    const tokensBefore = estimateTokens(this.state.messages);
    const transcript = serializeForSummary(this.state.messages);
    const prompt = buildCompactPrompt(transcript);
    const stream = this.registry.getStream(this.model);
    const collected = await collectStream(
      stream,
      {
        model: this.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        system:
          'You compress a coding-agent transcript into a structured 6-section summary. Preserve filenames, function names, error messages, and concrete values. Do not invent.',
        tools: [],
        maxTokens: Math.min(this.model.maxOutputTokens, 2000),
        signal,
      },
      signal,
    );
    if (collected.error || collected.contentBlocks.length === 0) {
      emit({ type: 'error', message: `compact failed: ${collected.error ?? 'no output'}` });
      return null;
    }
    const summary = collected.contentBlocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('\n');
    // Replace history with: [summary-as-user, summary-as-assistant-ack]
    this.state.messages = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Earlier conversation was compacted. The following is the structured summary you must continue from:',
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: summary }] },
    ];
    return { summary, tokensBefore };
  }

  /** True when the message history is filling >80% of the model's context window. */
  isContextNearLimit(): boolean {
    const win = this.model.contextWindow;
    if (!win) return false;
    const used = estimateTokens(this.state.messages);
    return used / win >= 0.8;
  }

  /** Approximate current token usage; for the TUI. */
  approximateTokenUsage(): { used: number; window: number } {
    return { used: estimateTokens(this.state.messages), window: this.model.contextWindow };
  }

  /**
   * Run a single user-message-driven loop.
   * `emit` is called synchronously from this method (and from tool
   * promises) so consumers can interleave events with tool progress.
   */
  async run(
    userMessage: Message | string,
    emit: Emitter,
    signal?: AbortSignal,
  ): Promise<void> {
    this.signal = signal;
    this.state.turnCount = 0;
    this.preCallRanThisRun = false; // v3.7: pre-call hook runs once per run()
    this.preCallBlock = '';
    this.lastToolReflection = '';

    const userContent: ContentBlock[] =
      typeof userMessage === 'string'
        ? [{ type: 'text', text: userMessage }]
        : Array.isArray(userMessage.content)
          ? userMessage.content
          : [{ type: 'text', text: String(userMessage.content) }];

    this.state.messages.push({ role: 'user', content: userContent });

    emit({ type: 'agent_start', model: this.state.model });

    while (true) {
      if (signal?.aborted || this.state.aborted) {
        emit({ type: 'agent_end', totalUsage: this.state.totalUsage });
        return;
      }
      if (this.state.turnCount >= this.state.maxTurns) {
        emit({ type: 'turn_end', turn: this.state.turnCount, stopReason: 'max_turns' });
        emit({ type: 'agent_end', totalUsage: this.state.totalUsage });
        return;
      }
      this.state.turnCount += 1;
      emit({ type: 'turn_start', turn: this.state.turnCount });

      // v0.4: refresh introspection guidance before the LLM call so
      // the system prompt reflects the latest reflection.
      await this.awaitIntrospectionGuidance();

      // v3.7: pre-call hook (auto-retrieval + skill suggestions).
      // Runs once per `run()` call (first turn). Errors here are
      // swallowed — the agent must keep going.
      if (!this.preCallRanThisRun && this.preCallHook) {
        try {
          const queryText = this.lastUserQuery();
          const r = await this.preCallHook(queryText);
          if (r?.event) emit(r.event);
          if (r?.block) this.preCallBlock = r.block;
        } catch { /* never let preCall break a turn */ }
        this.preCallRanThisRun = true;
      }

      // v3.6: auto-compact when context fills >85% of the model's window.
      // The "don't compact twice in a row" guard uses message count
      // because turnCount resets to 0 at the start of every run() call.
      // After a compact, messages.length drops to 2 (the summary), so
      // we wait for at least 6 messages to accumulate before another.
      if (
        this.state.messages.length - this.lastCompactedAtMessageCount >= 4
        && this.isContextNearLimit()
      ) {
        const before = estimateTokens(this.state.messages);
        const result = await this.compact(emit, signal);
        if (result) {
          this.lastCompactedAtMessageCount = this.state.messages.length;
          emit({
            type: 'context_compacted',
            tokensBefore: before,
            tokensAfter: estimateTokens(this.state.messages),
            turn: this.state.turnCount,
          });
        }
      }

      const stream = this.registry.getStream(this.state.model);
      // v1.1.2: wrap the call in a small retry loop. The provider sets
      // `retryable: true` on 429 / 5xx / network errors; we honor that
      // and exponential-backoff up to 3 retries (~1s + 2s + 4s + 8s
      // max). Retry-After from the server is respected when present.
      const collected = await runWithRetry(
        () => collectStream(stream, this.buildRequest(), signal),
        {
          signal,
          onRetry: (attempt, delayMs, err) => {
            emit({
              type: 'message_update',
              role: 'assistant',
              event: {
                type: 'error',
                message: `retry ${attempt}/3 in ${(delayMs / 1000).toFixed(1)}s — ${err}`,
                retryable: true,
              },
            });
          },
        },
      );

      for (const ev of collected.events) {
        emit({ type: 'message_update', role: 'assistant', event: ev });
      }

      this.state.totalUsage.input += collected.usage.inputTokens;
      this.state.totalUsage.output += collected.usage.outputTokens;
      if (collected.usage.costUsd) {
        this.state.totalUsage.costUsd += collected.usage.costUsd;
      }

      if (collected.error) {
        emit({ type: 'error', message: collected.error });
        emit({ type: 'turn_end', turn: this.state.turnCount, stopReason: 'error' });
        emit({ type: 'agent_end', totalUsage: this.state.totalUsage });
        return;
      }

      if (collected.contentBlocks.length > 0) {
        this.state.messages.push({
          role: 'assistant',
          content: collected.contentBlocks,
        });
      } else if (collected.stopReason !== 'tool_use') {
        this.state.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
        });
      }

      if (collected.stopReason === 'max_tokens') {
        emit({ type: 'turn_end', turn: this.state.turnCount, stopReason: 'max_tokens' });
        await this.observeAndReset();
        emit({ type: 'agent_end', totalUsage: this.state.totalUsage });
        return;
      }
      if (collected.stopReason === 'aborted') {
        emit({ type: 'turn_end', turn: this.state.turnCount, stopReason: 'aborted' });
        await this.observeAndReset();
        emit({ type: 'agent_end', totalUsage: this.state.totalUsage });
        return;
      }
      if (collected.toolCalls.length === 0) {
        emit({ type: 'turn_end', turn: this.state.turnCount, stopReason: 'end_turn' });
        await this.observeAndReset();
        emit({ type: 'agent_end', totalUsage: this.state.totalUsage });
        return;
      }

      emit({ type: 'turn_end', turn: this.state.turnCount, stopReason: 'tool_use' });

      await this.executeToolBatches(collected.toolCalls, emit);
      await this.observeAndReset();
    }
  }

  /**
   * v0.4: hand the per-turn behavior slice to the introspection
   * layer, then reset the per-turn accumulators. The layer may
   * trigger a background reflection in response to observe().
   */
  private async observeAndReset(): Promise<void> {
    if (this.introspection) {
      try {
        await this.introspection.observe({
          timestamp: new Date().toISOString(),
          toolUsage: [...this.turnToolRecords],
          filesTouched: [...this.turnFilesTouched],
          notes: [...this.turnNotes],
        });
      } catch {
        // never let introspection break a turn
      }
    }
    this.turnToolRecords = [];
    this.turnFilesTouched = new Set();
    this.turnNotes = [];
  }

  // -- internals --------------------------------------------------------

  private buildRequest() {
    const toolDefs: ToolDefinition[] = this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    // v0.4: prepend the introspection layer's guidance, if any.
    // lastGuidance is refreshed at the start of every turn via
    // awaitIntrospectionGuidance(), so this is a sync read.
    let system = this.state.system;
    // v3.7: prepend the pre-call block (retrieved memory + suggested
    // skills) AND the latest tool reflection. Order: preCall first
    // (so memory is the most "ambient" context), then reflection
    // (so it appears right before the LLM's own system message).
    const blocks: string[] = [];
    if (this.preCallBlock) blocks.push(this.preCallBlock);
    if (this.lastToolReflection) blocks.push(`## Tool reflection\n${this.lastToolReflection}`);
    if (this.lastGuidance) blocks.push(this.lastGuidance);
    if (blocks.length > 0) {
      system = `${blocks.join('\n\n')}\n\n${system}`;
    }
    return {
      model: this.state.model,
      messages: this.state.messages,
      system,
      tools: toolDefs,
      maxTokens: this.state.model.maxOutputTokens,
      signal: this.signal,
    };
  }

  /**
   * v0.4: refresh `lastGuidance` from the introspection layer
   * before the next LLM call. The layer's contract is that
   * getGuidance() returns the most recent guidance without
   * performing an LLM call — the LLM call happens in reflect(),
   * which runs in the background after observe().
   */
  private async awaitIntrospectionGuidance(): Promise<void> {
    if (!this.introspection?.getGuidance) return;
    try {
      this.lastGuidance = await this.introspection.getGuidance();
    } catch {
      // never let introspection break a turn
    }
  }

  private async executeToolBatches(
    toolCalls: ToolUseBlock[],
    emit: Emitter,
  ): Promise<void> {
    // Partition: consecutive concurrency-safe calls can run together;
    // a non-safe call forces a flush of the current batch.
    const batches: ToolUseBlock[][] = [];
    let currentBatch: ToolUseBlock[] = [];
    let batchIsSequential = false;

    for (const call of toolCalls) {
      const tool = this.tools.find((t) => t.name === call.name);
      const isSafe = tool?.isConcurrencySafe?.(call.input) ?? false;
      if (currentBatch.length === 0) {
        currentBatch.push(call);
        batchIsSequential = !isSafe;
        continue;
      }
      if (!batchIsSequential && isSafe) {
        currentBatch.push(call);
      } else {
        batches.push(currentBatch);
        currentBatch = [call];
        batchIsSequential = !isSafe;
      }
    }
    if (currentBatch.length > 0) batches.push(currentBatch);

    for (const batch of batches) {
      await Promise.all(batch.map((call) => this.executeOneTool(call, emit)));
    }
  }

  /**
   * v0.4: record the tool outcome for the introspection layer's
   * behavior snapshot, then emit the standard tool_execution_end.
   * v3.7: also reflect on the result and store a hint for the
   * next LLM call.
   */
  private finishTool(
    emit: Emitter,
    call: ToolUseBlock,
    toolName: string,
    result: ToolExecutionResult,
    start: number,
  ): void {
    this.turnToolRecords.push({
      name: toolName,
      isError: result.isError === true,
      durationMs: performance.now() - start,
    });
    this.appendToolResult(call.id, result);
    emit({
      type: 'tool_execution_end',
      toolName,
      toolUseId: call.id,
      result,
      durationMs: performance.now() - start,
    });
    // v3.7: tool reflection. The harness (server) installs the
    // reflector function on `harness.reflector` so we don't pull
    // in the coding-agent's reflection module from agent-core.
    const reflector = this.harness?.['reflector'] as
      | ((toolName: string, input: unknown, result: ToolExecutionResult) => { hint: string | null; kind: 'error' | 'empty' | 'large' | null })
      | undefined;
    if (reflector) {
      try {
        const r = reflector(toolName, call.input, result);
        if (r?.hint) {
          this.lastToolReflection = r.hint;
          emit({
            type: 'tool_reflection',
            toolName,
            hint: r.hint,
            kind: r.kind,
          } as never);
        }
      } catch { /* never let reflection break the loop */ }
    }
  }

  /**
   * v3.7: get the text of the most recent user message, for the
   * pre-call hook. The pre-call hook uses this to query memory
   * and skills.
   */
  private lastUserQuery(): string {
    for (let i = this.state.messages.length - 1; i >= 0; i -= 1) {
      const m = this.state.messages[i]!;
      if (m.role === 'user') {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
          return m.content
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join(' ');
        }
      }
    }
    return '';
  }

  private async executeOneTool(call: ToolUseBlock, emit: Emitter): Promise<void> {
    const tool = this.tools.find((t) => t.name === call.name);
    const start = performance.now();
    // v0.4: snapshot any file paths the tool was given, so the
    // introspection layer can summarize "what files did the agent
    // touch this turn?" without re-parsing the conversation.
    if (call.input && typeof call.input === 'object') {
      const inp = call.input as Record<string, unknown>;
      for (const key of ['path', 'file', 'target']) {
        const v = inp[key];
        if (typeof v === 'string' && v.length > 0 && !v.startsWith('-')) {
          this.turnFilesTouched.add(v);
        }
      }
    }

    if (!tool) {
      const result: ToolExecutionResult = {
        content: [
          {
            type: 'text',
            text: `Tool "${call.name}" is not registered. Available tools: ${this.tools
              .map((t) => t.name)
              .join(', ')}`,
          },
        ],
        isError: true,
      };
      this.finishTool(emit, call, call.name, result, start);
      return;
    }

    emit({
      type: 'tool_execution_start',
      toolName: tool.name,
      toolUseId: call.id,
      input: call.input,
    });

    if (tool.checkPermissions) {
      try {
        const decision = await tool.checkPermissions(call.input);
        if (decision.behavior === 'deny') {
          const result: ToolExecutionResult = {
            content: [{ type: 'text', text: `Denied: ${decision.message}` }],
            isError: true,
          };
          this.finishTool(emit, call, tool.name, result, start);
          return;
        }
        if (decision.behavior === 'ask') {
          // v0.1: in the harness we auto-approve. Higher layers (TUI)
          // can intercept this via checkPermissions to prompt the user.
          const result: ToolExecutionResult = {
            content: [
              {
                type: 'text',
                text: `Tool "${tool.name}" requires interactive approval which is not available in this mode.`,
              },
            ],
            isError: true,
          };
          this.finishTool(emit, call, tool.name, result, start);
          return;
        }
      } catch (err) {
        const result: ToolExecutionResult = {
          content: [
            {
              type: 'text',
              text: `Permission check threw: ${(err as Error).message}`,
            },
          ],
          isError: true,
        };
        this.finishTool(emit, call, tool.name, result, start);
        return;
      }
    }

    try {
      const ctx = {
        cwd: this.state.cwd,
        signal: this.signal ?? new AbortController().signal,
        messages: this.state.messages,
        log: () => {},
        harness: this.harness,
      };
      const result = await tool.execute(call.input, ctx);
      this.finishTool(emit, call, tool.name, result, start);
    } catch (err) {
      const result: ToolExecutionResult = {
        content: [
          {
            type: 'text',
            text: `Tool "${tool.name}" threw: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
      this.finishTool(emit, call, tool.name, result, start);
    }
  }

  private appendToolResult(toolUseId: string, result: ToolExecutionResult): void {
    const block: ToolResultBlock = {
      type: 'tool_result',
      toolUseId,
      content: result.content as unknown as ToolResultBlock['content'],
      isError: result.isError,
    };
    this.state.messages.push({ role: 'tool', content: [block] });
  }
}

// Stream collector ---------------------------------------------------------

async function collectStream(
  stream: StreamFunction,
  req: ReturnType<Agent['buildRequest']>,
  signal?: AbortSignal,
): Promise<{
  events: AssistantEvent[];
  contentBlocks: ContentBlock[];
  toolCalls: ToolUseBlock[];
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error' | 'aborted';
  error?: string;
}> {
  const events: AssistantEvent[] = [];
  const contentBlocks: ContentBlock[] = [];
  const toolCalls: ToolUseBlock[] = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let costUsd: number | undefined;
  let stopReason:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'stop_sequence'
    | 'error'
    | 'aborted' = 'end_turn';
  let error: string | undefined;

  try {
    for await (const ev of stream(req)) {
      events.push(ev);
      switch (ev.type) {
        case 'text_delta':
          appendText(contentBlocks, ev.delta);
          break;
        case 'thinking_delta':
          appendThinking(contentBlocks, ev.delta);
          break;
        case 'toolcall_start': {
          const block: ToolUseBlock = {
            type: 'tool_use',
            id: ev.id,
            name: ev.name,
            input: {},
          };
          contentBlocks.push(block);
          toolCalls.push(block);
          break;
        }
        case 'toolcall_delta':
          // The provider fills it on toolcall_end; we ignore the partial.
          break;
        case 'toolcall_end': {
          const idx = contentBlocks.findIndex(
            (b) => b.type === 'tool_use' && b.id === ev.id,
          );
          if (idx >= 0) {
            const existing = contentBlocks[idx] as ToolUseBlock;
            contentBlocks[idx] = {
              type: 'tool_use',
              id: ev.id,
              name: ev.name || existing.name,
              input: ev.input,
            };
            const tcIdx = toolCalls.findIndex((t) => t.id === ev.id);
            if (tcIdx >= 0) {
              toolCalls[tcIdx] = contentBlocks[idx] as ToolUseBlock;
            }
          } else {
            const block: ToolUseBlock = {
              type: 'tool_use',
              id: ev.id,
              name: ev.name,
              input: ev.input,
            };
            contentBlocks.push(block);
            toolCalls.push(block);
          }
          break;
        }
        case 'usage':
          usage = { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens };
          if (typeof ev.costUsd === 'number') costUsd = ev.costUsd;
          break;
        case 'done':
          stopReason = ev.stopReason;
          break;
        case 'error':
          error = ev.message;
          stopReason = 'error';
          break;
        case 'start':
          break;
      }
    }
  } catch (err) {
    error = (err as Error).message;
    stopReason = 'error';
  }

  if (signal?.aborted && !error) {
    stopReason = 'aborted';
  }

  return {
    events,
    contentBlocks,
    toolCalls,
    usage: { ...usage, costUsd },
    stopReason,
    error,
  };
}

function appendText(blocks: ContentBlock[], delta: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'text') {
    blocks[blocks.length - 1] = { type: 'text', text: last.text + delta };
  } else {
    blocks.push({ type: 'text', text: delta });
  }
}

function appendThinking(blocks: ContentBlock[], delta: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'thinking') {
    blocks[blocks.length - 1] = { ...last, thinking: last.thinking + delta };
  } else {
    blocks.push({ type: 'thinking', thinking: delta });
  }
}

// --- compact helpers -----------------------------------------------------

/** Rough token estimator: ~4 chars per token, good enough for the 80% trigger. */
function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') chars += b.text.length;
        else if (b.type === 'thinking') chars += b.thinking.length;
        else if (b.type === 'tool_use') chars += JSON.stringify(b.input).length + b.name.length + 32;
        else if (b.type === 'tool_result') {
          for (const inner of b.content) {
            if (inner.type === 'text') chars += inner.text.length;
          }
        }
      }
    }
    chars += 16; // role + framing overhead
  }
  return Math.ceil(chars / 4);
}

function serializeForSummary(messages: Message[]): string {
  const out: string[] = [];
  for (const m of messages) {
    const role = m.role.toUpperCase();
    if (typeof m.content === 'string') {
      out.push(`[${role}] ${m.content}`);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') out.push(`[${role}] ${b.text}`);
        else if (b.type === 'thinking') out.push(`[${role}/thinking] ${b.thinking}`);
        else if (b.type === 'tool_use') {
          out.push(`[${role}/tool_use ${b.name}] ${JSON.stringify(b.input)}`);
        } else if (b.type === 'tool_result') {
          const isErr = b.isError ? ' (error)' : '';
          const txt = b.content
            .map((c) => (c.type === 'text' ? c.text : ''))
            .join('')
            .slice(0, 2000);
          out.push(`[tool/result${isErr}] ${txt}`);
        }
      }
    }
  }
  return out.join('\n\n');
}

function buildCompactPrompt(transcript: string): string {
  return `Compress the following coding-agent transcript into a structured 6-section summary. Be concrete: keep filenames, function names, error messages, and specific values. Do not invent information that is not in the transcript. Use exactly these headings and one paragraph each.

GOAL: the user's original objective.
STATE: what has been completed so far.
DECISIONS: key design decisions made.
FILES: files created or modified (with paths).
OPEN: open issues, blockers, or unverified assumptions.
NEXT: planned next steps.

Transcript:
---
${transcript.slice(0, 60_000)}
---`;
}

/**
 * v1.1.2: retry loop for stream collection. The provider flags errors as
 * `retryable: true`; we respect that and exponential-backoff up to 3 retries.
 * Honors `retryAfterMs` from the provider (e.g. 429 Retry-After header).
 * Aborts immediately on user cancel.
 */
async function runWithRetry<T extends { error?: string; events: AssistantEvent[] }>(
  fn: () => Promise<T>,
  opts: {
    signal?: AbortSignal;
    onRetry?: (attempt: number, delayMs: number, message: string) => void;
    /** Override the cap. Default 3. */
    maxRetries?: number;
  } = {},
): Promise<T> {
  const max = opts.maxRetries ?? 3;
  let lastError = '';
  for (let attempt = 0; ; attempt += 1) {
    if (opts.signal?.aborted) {
      throw new Error('aborted');
    }
    const result = await fn();
    if (!result.error) return result;

    // Inspect the last error event for `retryable` + `retryAfterMs`.
    let retryable = false;
    let retryAfterMs: number | undefined;
    for (let i = result.events.length - 1; i >= 0; i -= 1) {
      const ev = result.events[i];
      if (ev.type === 'error') {
        retryable = Boolean(ev.retryable);
        retryAfterMs = ev.retryAfterMs;
        lastError = ev.message;
        break;
      }
    }
    if (!retryable || attempt >= max) {
      // Attach a hint that we exhausted retries (or the error was fatal),
      // so the user sees the retry context in the final error message.
      if (retryable && attempt >= max) {
        result.error = `${lastError} (after ${max} retries)`;
      }
      return result;
    }
    // Backoff: 1s, 2s, 4s (or honor retryAfterMs if larger).
    const base = Math.min(1000 * 2 ** attempt, 8000);
    const delay = Math.max(base, retryAfterMs ?? 0);
    opts.onRetry?.(attempt + 1, delay, lastError);
    await new Promise((r) => setTimeout(r, delay));
  }
}
