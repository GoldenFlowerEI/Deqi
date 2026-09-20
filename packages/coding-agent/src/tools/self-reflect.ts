/**
 * `self_reflect` and `session_history` tools — v0.8 strange loops.
 *
 * Inspired by Hofstadter's "strange loops": a system that can refer
 * to itself becomes capable of behaviors that, at lower levels, do
 * not exist. The agent that can ask "what did I do last turn?" and
 * "what patterns do I see in my own recent behavior?" has crossed
 * the threshold from reactive executor to self-aware operator.
 *
 * For v0.8 the implementation is deliberately simple:
 *   - `session_history` returns the last N user/assistant messages
 *     in the current session as a readable transcript
 *   - `self_reflect` returns the most recent reflection entries
 *     (the per-turn private notes appended at end of turn) and
 *     a derived summary of tool-call patterns
 *
 * Both tools read the SessionManager via the harness. They do NOT
 * call the LLM — they surface raw data; the agent is the one that
 * does the reflection. This is intentional: the LLM-as-tool is the
 * agent's job, not the tools' job.
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import type { SessionManager } from '../session.js';

export const sessionHistoryTool: AgentTool = {
  name: 'session_history',
  description:
    'Read the recent messages of the current session. Useful for grounding the agent in what has already been said. Defaults to the last 20 messages.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max number of messages to return. Default 20.',
      },
      role: {
        type: 'string',
        description: 'Optional filter: "user" or "assistant" (default both).',
      },
    },
  },
  isConcurrencySafe: () => true,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { limit?: number; role?: string };
    const session = ctx.harness?.session as SessionManager | undefined;
    if (!session) {
      return {
        content: [
          {
            type: 'text',
            text: 'session_history tool requires a SessionManager to be supplied via the harness',
          },
        ],
        isError: true,
      };
    }
    const limit = a.limit ?? 20;
    const role = a.role;
    const messages = session
      .getEntries()
      .filter((e) => e.type === 'message')
      .filter((e) => !role || e.role === role)
      .slice(-limit);
    if (messages.length === 0) {
      return { content: [{ type: 'text', text: '(no messages)' }] };
    }
    const lines = messages.map((m) => {
      const text = (() => {
        if (typeof m.content === 'string') return m.content;
        if (!Array.isArray(m.content)) return '';
        return m.content
          .map((b: { type: string; text?: string; thinking?: string }) => {
            if (b.type === 'text') return b.text ?? '';
            if (b.type === 'thinking') return `[thinking] ${b.thinking ?? ''}`;
            if (b.type === 'tool_use') return `[tool ${(b as { name?: string }).name ?? '?'}]`;
            if (b.type === 'tool_result') return '[tool result]';
            return '';
          })
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      })();
      return `[${m.role}] ${truncate(text, 200)}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
};

export const selfReflectTool: AgentTool = {
  name: 'self_reflect',
  description:
    'Read the per-turn reflection notes appended at the end of each turn. Use to look back at your own recent patterns: what worked, what did not, what you intended to do next.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max number of reflections to return. Default 5.',
      },
    },
  },
  isConcurrencySafe: () => true,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { limit?: number };
    const session = ctx.harness?.session as SessionManager | undefined;
    if (!session) {
      return {
        content: [
          {
            type: 'text',
            text: 'self_reflect tool requires a SessionManager to be supplied via the harness',
          },
        ],
        isError: true,
      };
    }
    const limit = a.limit ?? 5;
    const reflections = session
      .getEntries()
      .filter((e) => e.type === 'reflection')
      .slice(-limit);
    if (reflections.length === 0) {
      return { content: [{ type: 'text', text: '(no reflections yet)' }] };
    }
    const lines = reflections.map(
      (r, i) =>
        `--- reflection ${i + 1} ---\n` +
        `tried:   ${r.tried}\n` +
        `learned: ${r.learned}\n` +
        `next:    ${r.nextHint}\n` +
        `tools:   ${r.toolCallCount} (errors: ${r.hadErrors ? 'yes' : 'no'})`,
    );
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  },
};

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
