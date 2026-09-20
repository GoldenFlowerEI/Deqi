/**
 * Real-task smoke test #3: add a feature.
 *
 * Scenario:
 *   The user has a `todo.ts` with `add` and `list`. The agent must add
 *   a `remove(id)` function and a `markDone(id)` function.
 *
 *   The test passes when the post-edit file contains both new exports
 *   and they behave correctly when imported and executed.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TOOLS } from '@deqi/coding-agent';
import type { Model } from '@deqi/ai';
import { runScript, type Script } from './driver.js';
import { spawnSync } from 'node:child_process';

const model: Model = {
  id: 'mock-addfeature',
  displayName: 'Mock add-feature',
  provider: 'anthropic',
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};

const beforeCode = `// todo.ts — minimal in-memory todo list.
let items: { id: number; text: string }[] = [];
let nextId = 1;

export function add(text: string): number {
  const id = nextId++;
  items.push({ id, text });
  return id;
}

export function list(): { id: number; text: string }[] {
  return items.slice();
}
`;

const afterCode = `// todo.ts — minimal in-memory todo list.
let items: { id: number; text: string; done?: boolean }[] = [];
let nextId = 1;

export function add(text: string): number {
  const id = nextId++;
  items.push({ id, text });
  return id;
}

export function list(): { id: number; text: string; done?: boolean }[] {
  return items.slice();
}

export function remove(id: number): boolean {
  const before = items.length;
  items = items.filter((it) => it.id !== id);
  return items.length < before;
}

export function markDone(id: number): boolean {
  const it = items.find((x) => x.id === id);
  if (!it) return false;
  it.done = true;
  return true;
}
`;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deqi-addfeat-'));
  const target = join(dir, 'todo.ts');
  writeFileSync(target, beforeCode, 'utf8');

  const script: Script = {
    model,
    tools: BUILTIN_TOOLS,
    steps: [
      { type: 'tool', name: 'read', input: { path: 'todo.ts' } },
      { type: 'tool', name: 'write', input: {
        path: 'todo.ts',
        content: afterCode,
      } },
      { type: 'text', text: 'Added remove() and markDone() to todo.ts.' },
    ],
  };

  const result = await runScript(script, dir, [
    'Read todo.ts, add remove(id) and markDone(id), confirm.',
  ]);

  const after = readFileSync(target, 'utf8');
  let failed = false;
  if (!after.includes('export function remove')) {
    console.error('FAIL: remove() not exported');
    failed = true;
  }
  if (!after.includes('export function markDone')) {
    console.error('FAIL: markDone() not exported');
    failed = true;
  }
  if (result.stepsExecuted !== 3) {
    console.error('FAIL: expected 3 steps consumed, got', result.stepsExecuted);
    failed = true;
  }

  // Behavioral check: actually run the code via bun and verify behavior.
  // Use a temp .ts file (PowerShell on Windows mis-parses `bun -e ...`).
  const driverPath = join(dir, '_driver.ts');
  writeFileSync(driverPath, `
    import { add, list, remove, markDone } from './todo.ts';
    const a = add('first');
    const b = add('second');
    const c = add('third');
    markDone(b);
    const before = list();
    const removed = remove(a);
    const after = list();
    console.log(JSON.stringify({ before, removed, after }));
  `, 'utf8');
  const r = spawnSync('bun', ['run', '_driver.ts'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('FAIL: behavioral bun run failed');
    console.error(r.stderr);
    failed = true;
  } else {
    try {
      const parsed = JSON.parse(r.stdout.trim());
      if (parsed.removed !== true) {
        console.error('FAIL: remove() did not return true; got', parsed);
        failed = true;
      }
      if (!parsed.before.find((it: { id: number; done?: boolean }) => it.id === 2 && it.done === true)) {
        console.error('FAIL: markDone() did not flag item 2; got', parsed);
        failed = true;
      }
      if (parsed.after.length !== 2 || parsed.after.find((it: { id: number }) => it.id === 1)) {
        console.error('FAIL: remove() did not actually drop item 1; got', parsed);
        failed = true;
      }
    } catch (e) {
      console.error('FAIL: could not parse bun output:', r.stdout);
      failed = true;
    }
  }

  rmSync(dir, { recursive: true, force: true });
  if (failed) {
    console.error('ADD-FEATURE TASK FAILED');
    process.exit(1);
  }
  console.log('ADD-FEATURE TASK PASSED — steps:', result.stepsExecuted, 'final:', JSON.stringify(result.finalText));
}

main().catch((err) => {
  console.error('add-feature crashed:', err);
  process.exit(1);
});
