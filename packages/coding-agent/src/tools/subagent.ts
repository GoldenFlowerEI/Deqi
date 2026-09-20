/**
 * subagent tool — spawn a fresh worker agent with restricted tools.
 *
 * Inspired by Minsky's Society of Mind: a primary agent that can
 * recruit specialist sub-agents (agencies) for focused work, then
 * synthesize their reports. The sub-agent has its own clean context
 * (K-line isolation), restricted tool access, and a hard turn cap.
 *
 * v0.3 design:
 *   - Synchronous: parent waits for the sub-agent to finish.
 *   - Tools are filtered from a parent-provided allowlist.
 *   - Returns a structured final report: brief summary, key events,
 *     and the assistant's final text. Errors are caught and surfaced
 *     as a normal tool error so the parent can react.
 *   - The sub-agent's session is *not* persisted separately — only the
 *     parent's session record contains the subagent tool result. This
 *     keeps the K-line analogy honest: a K-line that fires and
 *     contributes, but doesn't become a separate memory unless the
 *     parent decides to.
 */

import type {
  Agent,
  AgentEvent,
  AgentTool,
  ToolExecutionContext,
  ToolExecutionResult,
} from '@deqi/agent-core';
import type { Model, ModelRegistry } from '@deqi/ai';

const MAX_SUBAGENT_TURNS = 12;
const MAX_SUBAGENT_TEXT = 8_000;

export interface SubagentContext {
  registry: ModelRegistry;
  /** All tools available to the parent. The sub-agent picks from this. */
  parentTools: AgentTool[];
  /**
   * v3.9.1: optional sink for streaming sub-agent events. The
   * harness (server) installs this so the parent session sees
   * each sub-agent turn in real time. Failures thrown here are
   * swallowed — a buggy stream sink must never break the
   * sub-agent.
   */
  onSubagentEvent?: (ev: unknown) => void;
  /** Default model to use if the sub-agent doesn't override. */
  defaultModelId: string;
}

export const subagentTool: AgentTool = {
  name: 'subagent',
  description:
    'Spawn a fresh worker agent with its own clean context and restricted tool set. ' +
    'Use for focused subtasks (e.g. "find all usages of X", "run tests and report failures") ' +
    'that would otherwise pollute the main context. Returns a structured final report.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task to give the sub-agent. Be specific about what to find/return.',
      },
      allowTools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of tool names the sub-agent may use. Defaults to read, grep, glob, bash.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory. Defaults to the parent cwd.',
      },
      model: {
        type: 'string',
        description: 'Optional model id to use. Defaults to the parent model.',
      },
    },
    required: ['prompt'],
  },
  isConcurrencySafe: () => false, // sub-agents are sequential; nested concurrency would be wild
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as {
      prompt?: string;
      allowTools?: string[];
      cwd?: string;
      model?: string;
    };
    if (!a?.prompt) {
      return { content: [{ type: 'text', text: 'Missing prompt' }], isError: true };
    }
    const subCtx = ctx.harness?.subagent as SubagentContext | undefined;
    if (!subCtx) {
      return {
        content: [
          {
            type: 'text',
            text:
              'subagent tool requires a SubagentContext to be supplied via the harness (not available in standalone tool tests)',
          },
        ],
        isError: true,
      };
    }
    return await runSubagent(
      { prompt: a.prompt, allowTools: a.allowTools, cwd: a.cwd, model: a.model },
      ctx,
      subCtx,
    );
  },
};

async function runSubagent(
  a: { prompt: string; allowTools?: string[]; cwd?: string; model?: string },
  ctx: ToolExecutionContext,
  subCtx: SubagentContext,
): Promise<ToolExecutionResult> {
  // a is structurally checked; if a.prompt is missing, the caller already
  // returned an error before reaching here. Re-narrow for the strict types.
  const prompt = a.prompt;
  const modelId = a.model ?? subCtx.defaultModelId;
  let model: Model;
  try {
    model = subCtx.registry.resolveModel(modelId);
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Unknown model: ${modelId} — ${(err as Error).message}` }],
      isError: true,
    };
  }
  if (!subCtx.registry.isProviderAvailable(model.provider)) {
    return {
      content: [
        {
          type: 'text',
          text: `Provider ${model.provider} for model ${modelId} is not configured`,
        },
      ],
      isError: true,
    };
  }
  const allowed = new Set(a.allowTools ?? ['read', 'grep', 'glob', 'bash']);
  const tools = subCtx.parentTools.filter((t) => allowed.has(t.name));
  if (tools.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `allowTools resolves to zero tools; pick at least one of: ${subCtx.parentTools
            .map((t) => t.name)
            .join(', ')}`,
        },
      ],
      isError: true,
    };
  }
  const cwd = a.cwd ?? ctx.cwd;

  // Spawn a fresh Agent. The Agent is a stateful object, but we
  // construct it here with empty messages and a single run() call.
  const { Agent } = await import('@deqi/agent-core');
  const agent = new Agent({
    registry: subCtx.registry,
    modelId,
    system:
      'You are a focused sub-agent of a larger deqi session. ' +
      'Complete the task and return a concise final report. ' +
      'Do not ask the parent for clarification — make reasonable assumptions and document them.',
    tools,
    cwd,
    maxTurns: MAX_SUBAGENT_TURNS,
  });

  const events: AgentEvent[] = [];
  let finalText = '';
  let toolCount = 0;
  let errorCount = 0;

  try {
    await agent.run(
      { role: 'user', content: [{ type: 'text', text: a.prompt }] },
      (ev) => {
        events.push(ev);
        // v3.9.1: forward to the harness's stream sink so the
        // parent session sees sub-agent events live. Wrapped in
        // try/catch because a buggy sink must never break the
        // sub-agent run.
        if (subCtx.onSubagentEvent) {
          try {
            subCtx.onSubagentEvent({
              ...ev,
              // Tag the event with a source so the desktop UI
              // can indent or badge sub-agent events distinctly.
              subagent: { model: modelId, cwd },
            });
          } catch { /* never let the sink break the run */ }
        }
        if (ev.type === 'tool_execution_start') toolCount += 1;
        if (ev.type === 'tool_execution_end' && ev.result.isError) errorCount += 1;
        if (ev.type === 'message_update' && ev.event.type === 'text_delta') {
          finalText += (ev.event as { delta: string }).delta;
          if (finalText.length > MAX_SUBAGENT_TEXT) {
            finalText = finalText.slice(0, MAX_SUBAGENT_TEXT) + '\n… [truncated]';
          }
        }
      },
    );
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `sub-agent crashed: ${(err as Error).message}`,
        },
      ],
      isError: true,
    };
  }

  const report = [
    '=== sub-agent report ===',
    `model: ${modelId}`,
    `tools: ${tools.map((t) => t.name).join(', ')}`,
    `turns: ${agent.getState().turnCount}`,
    `tool calls: ${toolCount} (errors: ${errorCount})`,
    `total tokens: ${agent.getState().totalUsage.input} in / ${agent.getState().totalUsage.output} out`,
    '',
    '--- final text ---',
    finalText || '(no text produced)',
  ].join('\n');

  return { content: [{ type: 'text', text: report }] };
}
