import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { withinCwd } from './util.js';
import { makeFileDiff } from '../diff.js';

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
      // v0.4: read the previous contents BEFORE overwriting. A full
      // rewrite is the one edit where the user most needs to see what
      // the file was — and the only moment it is still available. If
      // the read fails we still write; a missing diff is better than a
      // failed save, and the file's history is not this tool's job.
      let previous: string | null = null;
      if (existed) {
        try { previous = await readFile(abs, 'utf8'); } catch { previous = null; }
      }
      await writeFile(abs, a.content, 'utf8');
      return {
        content: [
          {
            type: 'text',
            text: `${existed ? 'Updated' : 'Created'} ${abs} (${a.content.length} bytes)`,
          },
        ],
        details: { diff: makeFileDiff(a.path, previous, a.content) },
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Write failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
};
