import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { withinCwd } from './util.js';

const MAX_OUTPUT_BYTES = 50_000;

/**
 * File path globbing. Prefers fd when available, falls back to a built-in
 * walker. The walker respects .gitignore-style patterns by ignoring
 * node_modules, .git, and dotfile directories.
 */
export const globTool: AgentTool = {
  name: 'glob',
  description:
    'List files matching a glob pattern. Uses fd when available, otherwise a built-in walker. Output is truncated to 50KB.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts").' },
      path: { type: 'string', description: 'Base directory. Defaults to cwd.' },
      maxResults: { type: 'number', description: 'Cap on number of results.' },
    },
    required: ['pattern'],
  },
  isConcurrencySafe: () => true,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { pattern?: string; path?: string; maxResults?: number };
    if (!a?.pattern) {
      return { content: [{ type: 'text', text: 'Missing pattern' }], isError: true };
    }
    const base = a.path ? (isAbsolute(a.path) ? a.path : resolve(ctx.cwd, a.path)) : ctx.cwd;
    if (!withinCwd(base, ctx.cwd)) {
      return {
        content: [{ type: 'text', text: `Refusing to search outside cwd: ${base}` }],
        isError: true,
      };
    }
    if (!existsSync(base)) {
      return { content: [{ type: 'text', text: `Path not found: ${base}` }], isError: true };
    }
    const fd = await which('fd');
    const safeArgs = { pattern: a.pattern, maxResults: a.maxResults };
    if (fd) {
      return await runFd(fd, safeArgs, base);
    }
    return await runBuiltin(safeArgs, base);
  },
};

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    if (isWin) {
      const child = spawn('where', [cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
      child.on('error', () => resolve(null));
      child.on('close', (code) => {
        if (code === 0) {
          const line = out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find((l) => l.length > 0 && !l.toLowerCase().includes('info:'));
          if (line && (line.includes('\\') || line.includes(':'))) {
            resolve(line);
            return;
          }
        }
        resolve(null);
      });
      return;
    }
    const child = spawn('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => (out += b.toString('utf8')));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 0 && out.trim().length > 0) {
        resolve(out.split('\n')[0].trim());
      } else {
        resolve(null);
      }
    });
  });
}

function runFd(
  fd: string,
  a: { pattern: string; maxResults?: number },
  base: string,
): Promise<ToolExecutionResult> {
  return new Promise((resolve) => {
    // fd treats the positional pattern as a regex by default. Glob
    // patterns like `**/*.ts` include metacharacters (`*`, `(`, `)`)
    // that fd will reject. Pass `--glob` so the pattern is interpreted
    // as a glob instead.
    const args = [
      '--type',
      'f',
      '--hidden',
      '--no-ignore',
      '--glob',
      a.pattern,
      base,
    ];
    const child = spawn(fd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > MAX_OUTPUT_BYTES) {
        out = out.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]';
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ content: [{ type: 'text', text: '(no matches)' }] });
        return;
      }
      let lines = out.split('\n').filter((l) => l.length > 0);
      if (a.maxResults) lines = lines.slice(0, a.maxResults);
      resolve({ content: [{ type: 'text', text: lines.join('\n') }] });
    });
    child.on('error', () => {
      resolve({ content: [{ type: 'text', text: '(no matches)' }] });
    });
  });
}

import { readdir, stat } from 'node:fs/promises';

function globToRegex(glob: string): RegExp {
  let pattern = '';
  let i = 0;
  // `**/x` should match `x` and `<dirs>/x` — translate to an
  // optional directory group so root-level files also match.
  if (glob.startsWith('**/')) {
    pattern += '(?:.*/)?';
    i = 3;
  } else if (glob === '**') {
    return /.*/;
  }
  for (; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          pattern += '(?:.*/)?';
          i += 2;
        } else {
          pattern += '.*';
          i += 1;
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (c === '?') {
      pattern += '[^/]';
    } else if (c === '.') {
      pattern += '\\.';
    } else {
      pattern += c.replace(/[\\+()|[\]{}^$]/g, '\\$&');
    }
  }
  return new RegExp('^' + pattern + '$');
}

async function runBuiltin(
  a: { pattern: string; maxResults?: number },
  base: string,
): Promise<ToolExecutionResult> {
  const re = globToRegex(a.pattern);
  const max = a.maxResults ?? 200;
  const out: string[] = [];
  await walk(base, base, re, out, max);
  if (out.length === 0) {
    return { content: [{ type: 'text', text: '(no matches)' }] };
  }
  return { content: [{ type: 'text', text: out.join('\n') }] };
}

async function walk(
  base: string,
  dir: string,
  re: RegExp,
  out: string[],
  max: number,
): Promise<void> {
  if (out.length >= max) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const full = `${dir}/${e.name}`;
    const rel = full.slice(base.length + 1);
    if (e.isDirectory()) {
      await walk(base, full, re, out, max);
    } else {
      if (re.test(rel) || re.test(e.name)) {
        out.push(full);
      }
    }
  }
}
