/**
 * `constitution` tool — let the agent re-read the active constitution.
 *
 * Inspired by Constitutional AI (Bai et al., 2022): a fixed list of
 * principles guides the agent's behavior. The constitution is loaded
 * once at startup and prepended to the system prompt; this tool lets
 * the agent re-read it on demand (e.g. when it is uncertain whether
 * a proposed action is in scope).
 *
 * The tool returns the active principles as a numbered list, with
 * their full text. It does *not* call the LLM — the principles are
 * deterministic.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { listPrinciples, loadConstitution } from '../constitution.js';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';

export const constitutionTool: AgentTool = {
  name: 'constitution',
  description:
    'Re-read the active constitution principles. The constitution is prepended to the system prompt; this tool lets you re-read it on demand (e.g. when uncertain whether a proposed action is in scope).',
  inputSchema: {
    type: 'object',
    properties: {
      principle: {
        type: 'string',
        description:
          'Optional. If given, returns the full text of the matching principle; otherwise returns all principles as a numbered list.',
      },
      path: {
        type: 'string',
        description:
          'Optional. If given, returns the raw markdown of a different constitution file (e.g. for inspection). Defaults to the active constitution.',
      },
    },
  },
  isConcurrencySafe: () => true,
  async execute(
    args: unknown,
    _ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { principle?: string; path?: string };
    const { text, source } = a.path
      ? loadFromPath(a.path)
      : loadConstitution();
    if (a.principle) {
      const principles = listPrinciples(text);
      const idx = principles.findIndex(
        (p) => p.toLowerCase().includes(a.principle!.toLowerCase()),
      );
      if (idx === -1) {
        return {
          content: [
            {
              type: 'text',
              text: `No principle matching "${a.principle}". Available: ${principles.length} principles.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `Principle #${idx + 1} (source: ${source}):\n${principles[idx]}`,
          },
        ],
      };
    }
    const principles = listPrinciples(text);
    const list = principles.map((p, i) => `  ${i + 1}. ${p}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Constitution (${principles.length} principles, source: ${source}):\n${list}\n\nFor the full markdown, use: constitution with path: "${source}"`,
        },
      ],
    };
  },
};

function loadFromPath(p: string): { text: string; source: string } {
  const abs = p.startsWith('~') ? resolve(homedir(), p.slice(1)) : p;
  if (!existsSync(abs)) {
    return { text: `(file not found: ${abs})`, source: abs };
  }
  try {
    return { text: readFileSync(abs, 'utf8'), source: abs };
  } catch (err) {
    return { text: `(failed to read: ${(err as Error).message})`, source: abs };
  }
}
