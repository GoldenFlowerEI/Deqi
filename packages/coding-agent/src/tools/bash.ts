import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 100_000;

export const bashTool: AgentTool = {
  name: 'bash',
  description:
    'Run a shell command. Default timeout 30s, max 10m. The command runs in a child process with cwd set to the agent working directory. Output is truncated past 100KB.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 30000, max 600000).' },
      description: { type: 'string', description: 'Short description of the command.' },
    },
    required: ['command'],
  },
  isConcurrencySafe: (args: unknown): boolean => {
    // Read-only classification: pure read commands can be parallel.
    const cmd = (args as { command?: string })?.command ?? '';
    return isLikelyReadOnly(cmd);
  },
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as { command?: string; timeout?: number; description?: string };
    if (!a?.command) {
      return { content: [{ type: 'text', text: 'Missing command' }], isError: true };
    }
    const timeout = Math.min(Math.max(a.timeout ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

    // Use a child shell. On Windows prefer Git-Bash / MSYS sh (which gives
    // us `ls`, `cat`, `grep`, etc.); fall back to cmd.exe.
    const isWindows = process.platform === 'win32';
    let shell: string;
    let shellArgs: string[];
    if (isWindows) {
      const bash = process.env.SHELL || (await whichOnWindows('bash')) || 'cmd.exe';
      if (bash.endsWith('bash.exe') || bash.endsWith('sh.exe')) {
        shell = bash;
        shellArgs = ['-c', a.command];
      } else {
        shell = 'cmd.exe';
        shellArgs = ['/d', '/s', '/c', a.command];
      }
    } else {
      shell = process.env.SHELL || '/bin/sh';
      shellArgs = ['-c', a.command];
    }

    return new Promise<ToolExecutionResult>((resolve) => {
      const child = spawn(shell, shellArgs, {
        cwd: ctx.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        try {
          child.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 2000);
      }, timeout);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]';
        }
        ctx.onUpdate?.({
          kind: 'partial',
          content: [{ type: 'text', text: chunk.toString('utf8') }],
        });
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]';
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          content: [{ type: 'text', text: `spawn error: ${err.message}` }],
          isError: true,
        });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const header = killed
          ? `[killed after ${timeout}ms]`
          : code === 0
            ? `[exit 0]`
            : `[exit ${code}]`;
        const description = a.description ? `# ${a.description}\n` : '';
        const text = `${description}${header}\n${
          stdout ? `$ ${a.command}\n${stdout}\n` : ''
        }${stderr ? `\n[stderr]\n${stderr}\n` : ''}`.trim();
        resolve({
          content: [{ type: 'text', text }],
          isError: code !== 0 || killed,
          details: { exitCode: code, killed },
        });
      });
    });
  },
};

async function whichOnWindows(cmd: string): Promise<string | null> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('where', [cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
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

// Cheap read-only heuristic: commands whose first non-whitespace token is
// in a small allowlist. This is not bullet-proof but errs on the safe side
// (we serialize anything ambiguous).
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'pwd', 'env',
  'grep', 'rg', 'ag', 'find', 'fd', 'tree', 'file', 'stat', 'du', 'df',
  'git', 'diff', 'cmp', 'md5sum', 'sha256sum',
  'date', 'uname', 'whoami', 'hostname', 'which', 'type',
  'test', '[',
  // ts/Node ecosystem
  'tsc', 'node', 'bun', 'pnpm', 'yarn', 'npm', 'npx',
]);

function isLikelyReadOnly(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  // Strip leading env-var assignments: FOO=bar ls
  let stripped = trimmed;
  while (/^[A-Z_][A-Z0-9_]*=/.test(stripped)) {
    const sp = stripped.indexOf(' ');
    if (sp === -1) return false;
    stripped = stripped.slice(sp + 1);
  }
  // Quoted first token: skip the heuristic.
  const firstSpace = stripped.search(/\s/);
  const first = firstSpace === -1 ? stripped : stripped.slice(0, firstSpace);
  if (first.startsWith('"') || first.startsWith("'") || first.startsWith('`')) {
    return false;
  }
  return READ_ONLY.has(first);
}
