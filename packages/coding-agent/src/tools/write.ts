import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { withinCwd } from './util.js';

export const writeTool: AgentTool = {
  name: 'write',
  description:
    'Create or fully overwrite a file. Creates parent directories if they do not exist. Use `edit` for surgical changes.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file.' },
      content: { type: 'string', description: 'Full file content.' },
    },
    required: ['path', 'content'],
  },
  isConcurrencySafe: () => false,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { path?: string; content?: string };
    if (!a?.path || typeof a.content !== 'string') {
      return { content: [{ type: 'text', text: 'Missing path or content' }], isError: true };
    }
    const abs = isAbsolute(a.path) ? a.path : resolve(ctx.cwd, a.path);
    if (!withinCwd(abs, ctx.cwd)) {
      return {
        content: [{ type: 'text', text: `Refusing to write outside cwd: ${abs}` }],
        isError: true,
      };
    }
    const existed = existsSync(abs);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, a.content, 'utf8');
      return {
        content: [
          {
            type: 'text',
            text: `${existed ? 'Updated' : 'Created'} ${abs} (${a.content.length} bytes)`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Write failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
};
