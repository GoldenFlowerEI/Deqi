import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { withinCwd } from './util.js';

/**
 * Surgical file edit. oldText must match EXACTLY once.
 * If it matches multiple times, the operation is rejected and the agent
 * is asked to disambiguate.
 *
 * The v0.1 implementation is intentionally single-match; replace_all
 * is a v0.2 feature.
 */
export const editTool: AgentTool = {
  name: 'edit',
  description:
    'Surgical text replacement in a file. oldText must appear exactly once. Use write for full-file rewrites.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file.' },
      oldText: { type: 'string', description: 'Exact text to find.' },
      newText: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  isConcurrencySafe: () => false,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { path?: string; oldText?: string; newText?: string };
    if (!a?.path || typeof a.oldText !== 'string' || typeof a.newText !== 'string') {
      return {
        content: [{ type: 'text', text: 'Missing path, oldText, or newText' }],
        isError: true,
      };
    }
    const abs = isAbsolute(a.path) ? a.path : resolve(ctx.cwd, a.path);
    if (!withinCwd(abs, ctx.cwd)) {
      return {
        content: [{ type: 'text', text: `Refusing to edit outside cwd: ${abs}` }],
        isError: true,
      };
    }
    if (!existsSync(abs)) {
      return { content: [{ type: 'text', text: `File not found: ${abs}` }], isError: true };
    }
    const text = await readFile(abs, 'utf8');
    const occurrences = text.split(a.oldText).length - 1;
    if (occurrences === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `oldText not found. Make sure whitespace matches exactly.`,
          },
        ],
        isError: true,
      };
    }
    if (occurrences > 1) {
      return {
        content: [
          {
            type: 'text',
            text: `oldText appears ${occurrences} times; please disambiguate by including more surrounding context.`,
          },
        ],
        isError: true,
      };
    }
    const updated = text.replace(a.oldText, a.newText);
    await writeFile(abs, updated, 'utf8');
    return {
      content: [{ type: 'text', text: `Edited ${abs}` }],
    };
  },
};
