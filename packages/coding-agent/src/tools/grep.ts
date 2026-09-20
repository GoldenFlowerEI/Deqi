import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { withinCwd } from './util.js';

const MAX_OUTPUT_BYTES = 50_000;

/**
 * Content search using ripgrep when available, falling back to a
 * hand-rolled walker for environments where rg is missing.
 */
export const grepTool: AgentTool = {
  name: 'grep',
  description:
    'Search file contents with a regex pattern. Uses ripgrep when available, otherwise a built-in walker. Output is truncated to 50KB.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern.' },
      path: { type: 'string', description: 'Directory or file to search. Defaults to cwd.' },
      include: { type: 'string', description: 'Glob filter (e.g. "*.ts").' },
      caseInsensitive: { type: 'boolean', description: 'Case-insensitive search.' },
      maxResults: { type: 'number', description: 'Max number of matching lines.' },
    },
    required: ['pattern'],
  },
  isConcurrencySafe: () => true,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as {
      pattern?: string;
      path?: string;
      include?: string;
      caseInsensitive?: boolean;
      maxResults?: number;
    };
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
    const rg = await which('rg');
    const safeArgs = { pattern: a.pattern, include: a.include, caseInsensitive: a.caseInsensitive, maxResults: a.maxResults };
    if (rg) {
      return await runRipgrep(rg, safeArgs, base);
    }
    return await runBuiltinSearch(safeArgs, base);
  },
};

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    if (isWin) {
      // Use `where` directly on Windows.
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
          if (line) {
            // Only accept real paths with a drive letter or backslashes.
            if (line.includes('\\') || line.includes(':')) resolve(line);
            else resolve(null);
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

function runRipgrep(
  rg: string,
  a: { pattern: string; include?: string; caseInsensitive?: boolean; maxResults?: number },
  base: string,
): Promise<ToolExecutionResult> {
  return new Promise((resolve) => {
    // Build args carefully: an empty string element (e.g. from a
    // `cond ? '-i' : ''` ternary) gets passed through to ripgrep on
    // Windows and shows up as a missing-path error. Only push
    // flag values that are actually wanted.
    const args: string[] = [
      '--no-heading',
      '--line-number',
      '--color=never',
    ];
    if (a.caseInsensitive) args.push('-i');
    args.push('-e', a.pattern);
    if (a.include) {
      args.push('--glob', a.include);
    }
    if (a.maxResults) {
      args.push('--max-count', String(a.maxResults));
    }
    args.push(base);
    const child = spawn(rg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > MAX_OUTPUT_BYTES) {
        out = out.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]';
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      err += b.toString('utf8');
    });
    child.on('close', (code) => {
      if (code === 1) {
        // No matches.
        resolve({ content: [{ type: 'text', text: '(no matches)' }] });
        return;
      }
      if (code !== 0 && code !== 1) {
        resolve({
          content: [{ type: 'text', text: `ripgrep error: ${err || 'code ' + code}` }],
          isError: true,
        });
        return;
      }
      resolve({ content: [{ type: 'text', text: out.trim() }] });
    });
    child.on('error', (e) => {
      resolve({
        content: [{ type: 'text', text: `spawn ripgrep failed: ${e.message}` }],
        isError: true,
      });
    });
  });
}

import { readdir, readFile, stat } from 'node:fs/promises';

async function runBuiltinSearch(
  a: { pattern: string; include?: string; caseInsensitive?: boolean; maxResults?: number },
  base: string,
): Promise<ToolExecutionResult> {
  const re = new RegExp(a.pattern, a.caseInsensitive ? 'i' : '');
  const include = a.include ? globToRegex(a.include) : null;
  const max = a.maxResults ?? 200;
  const out: string[] = [];
  const baseStat = await stat(base).catch(() => null);
  if (!baseStat) {
    return { content: [{ type: 'text', text: `Path not found: ${base}` }], isError: true };
  }
  if (baseStat.isFile()) {
    await grepFile(base, re, include, out, max);
  } else {
    await walkDir(base, re, include, out, max, base);
  }
  if (out.length === 0) {
    return { content: [{ type: 'text', text: '(no matches)' }] };
  }
  const text = out.slice(0, max).join('\n');
  return {
    content: [{ type: 'text', text: text.length > MAX_OUTPUT_BYTES ? text.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]' : text }],
  };
}

async function walkDir(
  dir: string,
  re: RegExp,
  include: RegExp | null,
  out: string[],
  max: number,
  base: string,
): Promise<void> {
  if (out.length >= max) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      await walkDir(full, re, include, out, max, base);
    } else {
      if (include && !include.test(e.name)) continue;
      await grepFile(full, re, include, out, max);
    }
  }
}

async function grepFile(
  path: string,
  re: RegExp,
  _include: RegExp | null,
  out: string[],
  max: number,
): Promise<void> {
  if (out.length >= max) return;
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= max) return;
    if (re.test(lines[i])) {
      out.push(`${path}:${i + 1}:${lines[i]}`);
    }
  }
}

// Minimal glob-to-regex: supports **, *, ?.
// `**/x` translates to `(?:.*/)?` so root-level files also match.
function globToRegex(glob: string): RegExp {
  let pattern = '';
  let i = 0;
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
