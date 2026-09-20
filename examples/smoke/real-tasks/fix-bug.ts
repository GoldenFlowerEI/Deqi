/**
 * Real-task smoke test #1: fix a bug.
 *
 * Scenario:
 *   The user has a `math.ts` file with a buggy `factorial` function
 *   (off-by-one for n=0). The agent must:
 *     1. Read the file
 *     2. Edit it to fix the bug
 *     3. Report the fix
 *
 * The script is deterministic. The test passes when the post-edit file
 * no longer contains the buggy line and the test cases (0!, 5!, 7!) yield
 * the correct values.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TOOLS } from '@deqi/coding-agent';
import type { Model } from '@deqi/ai';
import { runScript, type Script } from './driver.js';

const model: Model = {
  id: 'mock-fixbug',
  displayName: 'Mock fix-bug',
  provider: 'anthropic',
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};

const buggyMath = `// math.ts
export function factorial(n: number): number {
  if (n <= 1) {
    return n; // BUG: should return 1 for n=0
  }
  return n * factorial(n - 1);
}
`;

const fixedMath = `// math.ts
export function factorial(n: number): number {
  if (n <= 1) {
    return 1;
  }
  return n * factorial(n - 1);
}
`;

function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deqi-fixbug-'));
  const target = join(dir, 'math.ts');
  writeFileSync(target, buggyMath, 'utf8');

  const script: Script = {
    model,
    tools: BUILTIN_TOOLS,
    steps: [
      { type: 'tool', name: 'read', input: { path: 'math.ts' } },
      { type: 'tool', name: 'edit', input: {
        path: 'math.ts',
        oldText: '    return n; // BUG: should return 1 for n=0',
        newText: '    return 1;',
      } },
      { type: 'text', text: 'Fixed the off-by-one bug in factorial.' },
    ],
  };

  const result = await runScript(script, dir, [
    'Read math.ts, identify the bug, fix it, then confirm.',
  ]);

  const after = readFileSync(target, 'utf8');
  let failed = false;
  if (after.includes('BUG: should return 1 for n=0')) {
    console.error('FAIL: bug comment still present');
    failed = true;
  }
  if (after !== fixedMath) {
    console.error('FAIL: file content does not match expected fix');
    console.error('--- got ---\n' + after);
    console.error('--- expected ---\n' + fixedMath);
    failed = true;
  }
  // Behavioral check.
  if (factorial(0) !== 1 || factorial(5) !== 120 || factorial(7) !== 5040) {
    console.error('FAIL: reference implementation wrong');
    failed = true;
  }
  if (result.stepsExecuted !== 3) {
    console.error('FAIL: expected 3 steps to be consumed, got', result.stepsExecuted);
    failed = true;
  }

  rmSync(dir, { recursive: true, force: true });
  if (failed) {
    console.error('FIX-BUG TASK FAILED');
    process.exit(1);
  }
  console.log('FIX-BUG TASK PASSED — steps:', result.stepsExecuted, 'final:', JSON.stringify(result.finalText));
}

main().catch((err) => {
  console.error('fix-bug crashed:', err);
  process.exit(1);
});
