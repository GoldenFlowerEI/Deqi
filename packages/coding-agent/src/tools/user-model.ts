/**
 * `user_model` tool — surface the predictive user model state.
 *
 * The agent can call this on demand to see what topic the harness
 * thinks the user is working on, and how surprised the model is by
 * recent behavior. Useful for deciding whether to ask a clarifying
 * question.
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import type { UserModel } from '../user-model.js';

export const userModelTool: AgentTool = {
  name: 'user_model',
  description:
    'Inspect the predictive user model: dominant topic, full distribution, recent surprise score. Use when uncertain what the user is trying to accomplish.',
  inputSchema: {
    type: 'object',
    properties: {
      detail: {
        type: 'string',
        description: 'Optional. "summary" (default) or "full" (includes per-prompt history).',
      },
    },
  },
  isConcurrencySafe: () => true,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { detail?: string };
    const model = ctx.harness?.userModel as UserModel | undefined;
    if (!model) {
      return {
        content: [
          {
            type: 'text',
            text:
              'user_model tool requires a UserModel to be supplied via the harness (not available in standalone tool tests)',
          },
        ],
        isError: true,
      };
    }
    const dist = model.getDistribution();
    const sorted = Object.entries(dist).sort((a, b) => b[1] - a[1]);
    const summary = [
      `Topic: ${model.dominantTopic()} (${(dist[model.dominantTopic()] * 100).toFixed(1)}%)`,
      `Surprise EMA: ${(model.surprise() * 100).toFixed(1)}% (recent: ${model.isRecentSurprise() ? 'yes' : 'no'})`,
      `Prompts observed: ${model.size()}`,
      '',
      'Distribution:',
      ...sorted.map(([t, p]) => `  ${t.padEnd(12)} ${(p * 100).toFixed(1)}%`),
    ].join('\n');
    if (a.detail === 'full') {
      const hist = model.history_();
      const recent = hist.slice(-5).map((h, i) => `  ${i + 1}. [surprise=${(h.surprise * 100).toFixed(0)}%] ${h.text.slice(0, 80)}`).join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `${summary}\n\nRecent history (last 5):\n${recent}`,
          },
        ],
      };
    }
    return { content: [{ type: 'text', text: summary }] };
  },
};
