import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { withinCwd } from './util.js';
import { hashKey, type ToolCache } from '../cache.js';

const MAX_BYTES = 200_000;
/** v3.6: 5-minute TTL safety even if mtime didn't change. */
const READ_TTL_MS = 5 * 60_000;

export const readTool: AgentTool = {
  name: 'read',
  description:
    'Read a file. Returns text content with line numbers. Supports offset/limit for large files. Images/PDFs are not supported in v0.1.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, absolute or relative to cwd.' },
      offset: { type: 'number', description: '1-indexed line offset. Defaults to 1.' },
      limit: { type: 'number', description: 'Max number of lines to return. Defaults to 500.' },
    },
    required: ['path'],
  },
  isConcurrencySafe: () => true,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { path: string; offset?: number; limit?: number };
    if (!a?.path) {
      return { content: [{ type: 'text', text: 'Missing path' }], isError: true };
    }
    const abs = isAbsolute(a.path) ? a.path : resolve(ctx.cwd, a.path);
    if (!withinCwd(abs, ctx.cwd)) {
      return {
        content: [{ type: 'text', text: `Refusing to read outside cwd: ${abs}` }],
        isError: true,
      };
    }
    if (!existsSync(abs)) {
      return { content: [{ type: 'text', text: `File not found: ${abs}` }], isError: true };
    }
    let statResult;
    try {
      statResult = await stat(abs);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `stat failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
    if (statResult.size > MAX_BYTES) {
      return {
        content: [
          {
            type: 'text',
            text: `File is too large (${statResult.size} bytes > ${MAX_BYTES}). Use offset/limit to read a slice.`,
          },
        ],
        isError: true,
      };
    }
    const mtimeMs = statResult.mtimeMs;
    // v3.6: cache check. Key includes path + mtime + offset + limit so
    // a sliced read never returns the full file from cache.
    const cache = ctx.harness?.cache as ToolCache | undefined;
    const cacheKey = hashKey(['read', abs, mtimeMs, a.offset ?? 1, a.limit ?? 500]);
    if (cache) {
      const hit = cache.get(cacheKey);
      if (hit) {
        return {
          content: [{ type: 'text', text: hit }],
          details: { cached: true },
        };
      }
    }
    const text = await readFile(abs, 'utf8');
    const lines = text.split('\n');
    const start = Math.max(0, (a.offset ?? 1) - 1);
    const end = Math.min(lines.length, start + (a.limit ?? 500));
    const slice = lines.slice(start, end);
    const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(5, ' ')}\t${l}`);
    const output = numbered.join('\n') + `\n\n(${lines.length} lines total)`;
    if (cache) {
      cache.set(cacheKey, output, { ttlMs: READ_TTL_MS });
    }
    return {
      content: [{ type: 'text', text: output }],
      details: { cached: false, mtimeMs },
    };
  },
};
