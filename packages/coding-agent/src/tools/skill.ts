/**
 * v3.2: skill tool — load / save / run / list reusable sub-workflows.
 *
 * Each skill is a directory under ~/.deqi/memory/skills/<name>/
 * with at least SKILL.md (a small spec) and optionally run.sh
 * (a shell command that the agent can invoke).
 *
 * Skills are the user-curated / agent-curated extension mechanism.
 * v3.2 ships with the loader + the writer; the discovery UI lives
 * in the desktop (v3.3 will add the panel).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { spawn, spawnSync } from 'node:child_process';
import { readSkills, readSkill, writeSkill, MEMORY_ROOT, type SkillMeta } from '../memory.js';

/** Find a bash interpreter on this system. Falls back to sh on POSIX. */
function findBash(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    if (process.env.SHELL && (process.env.SHELL.endsWith('bash.exe') || process.env.SHELL.endsWith('sh.exe'))) {
      return { cmd: process.env.SHELL, args: [] };
    }
    // Common Git-Bash install locations
    const candidates = [
      'C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe',
      'C:\\\\Program Files (x86)\\\\Git\\\\bin\\\\bash.exe',
      'C:\\\\Windows\\\\System32\\\\bash.exe',
    ];
    for (const c of candidates) {
      try {
        if (existsSync(c)) return { cmd: c, args: [] };
      } catch { /* ignore */ }
    }
    // Probe PATH
    const probe = spawnSync('where', ['bash'], { encoding: 'utf-8' });
    if (probe.status === 0) {
      const found = probe.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.endsWith('bash.exe') || l.endsWith('bash'));
      if (found) return { cmd: found, args: [] };
    }
    // Last resort: cmd.exe (won't run bash scripts but at least we don't 127)
    return { cmd: 'cmd.exe', args: [] };
  }
  return { cmd: process.env.SHELL || '/bin/sh', args: [] };
}

const SKILLS_DIR = join(MEMORY_ROOT, 'skills');

export const skillTool: AgentTool = {
  name: 'skill',
  description: `Load, save, or run a reusable sub-workflow ("skill"). Skills live under ~/.deqi/memory/skills/<name>/ as SKILL.md (the spec) + optional run.sh (the executor).

Actions (action param):
  - 'list'   — list all skill names + descriptions. No other params required.
  - 'read'   — read a skill's SKILL.md. Required: name.
  - 'write'  — create or update a skill. Required: name, body. Optional: runScript.
  - 'run'    — execute the skill's run.sh. Required: name. Optional: args (string[]).

When to use:
  - You have a multi-step workflow you keep doing (build, test, deploy, lint, etc.) — save it as a skill
  - The user mentions a "skill" by name — load it
  - You want to make your work reproducible across sessions — save a skill

When NOT to use:
  - For one-off commands (use \`bash\` instead)
  - For things that change every run (use \`write\` to update the skill each time)
  - For binaries (run.sh is interpreted, not compiled)

Parameters:
  - action (string, required): 'list' | 'read' | 'write' | 'run'
  - name (string, required for read/write/run): skill name (kebab-case recommended)
  - body (string, required for write): the SKILL.md content. First line is treated as the title; second line should start with 'description:'.
  - runScript (string, optional, for write): the run.sh content. If omitted, the skill is documentation-only.
  - args (string[], optional, for run): arguments to pass to run.sh.

Returns:
  - list: array of {name, description, dir, hasRun}
  - read: full SKILL.md body
  - write: {ok: true, path}
  - run: stdout + stderr from run.sh

Examples:
  - skill action=list → all skills
  - skill action=read name=deploy → SKILL.md
  - skill action=write name=lint body="title: lint\\ndescription: run eslint" runScript="#!/bin/bash\\nnpx eslint .\\n"
  - skill action=run name=lint → runs run.sh

Concurrency: NOT safe (writes skill files).`,

  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'write', 'run'] },
      name: { type: 'string' },
      body: { type: 'string' },
      runScript: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['action'],
  },
  isConcurrencySafe: () => false,
  async execute(args: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const a = args as {
      action?: 'list' | 'read' | 'write' | 'run';
      name?: string;
      body?: string;
      runScript?: string;
      args?: string[];
    };
    if (!a?.action) return { content: [{ type: 'text', text: 'Missing action' }], isError: true };

    try {
      if (a.action === 'list') {
        const skills = readSkills();
        return ok(skills);
      }

      if (a.action === 'read') {
        if (!a.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
        const s = readSkill(a.name);
        if (!s) return { content: [{ type: 'text', text: `skill not found: ${a.name}` }], isError: true };
        return { content: [{ type: 'text', text: s.body }] };
      }

      if (a.action === 'write') {
        if (!a.name || !a.body) {
          return { content: [{ type: 'text', text: 'name and body required' }], isError: true };
        }
        const meta = writeSkill(a.name, a.body, a.runScript);
        return ok({ ok: true, path: meta.dir });
      }

      if (a.action === 'run') {
        if (!a.name) return { content: [{ type: 'text', text: 'name required' }], isError: true };
        const s = readSkill(a.name);
        if (!s) return { content: [{ type: 'text', text: `skill not found: ${a.name}` }], isError: true };
        if (!s.meta.hasRun) {
          return {
            content: [{ type: 'text', text: `skill "${a.name}" has no run.sh; documentation-only` }],
            isError: true,
          };
        }
        const runPath = join(s.meta.dir, 'run.sh');
        const bash = findBash();
        return new Promise((resolve) => {
          const child = spawn(bash.cmd, [...bash.args, runPath, ...(a.args ?? [])], {
            cwd: ctx.cwd,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch { /* ignore */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
          }, 60_000);
          child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
          child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
          child.on('error', (err) => {
            clearTimeout(timer);
            resolve({
              content: [{
                type: 'text',
                text: `skill run failed to spawn ${bash.cmd}: ${err.message}. ` +
                      `Install bash or set $SHELL to a valid path.`,
              }],
              isError: true,
            });
          });
          child.on('exit', (code) => {
            clearTimeout(timer);
            const out = `[exit ${code ?? 'null'}]\\n--- stdout ---\\n${stdout}\\n--- stderr ---\\n${stderr}`;
            resolve({ content: [{ type: 'text', text: out }] });
          });
        });
      }

      return { content: [{ type: 'text', text: `unknown action: ${a.action}` }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
};

function ok(data: unknown): ToolExecutionResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
