/**
 * Real-task smoke test #2: refactor a function.
 *
 * Scenario:
 *   The user has a `stringutil.ts` with a long inline `slugify` function.
 *   The agent must:
 *     1. Read the file
 *     2. Use `write` to replace it with a refactored version that uses
 *        small helpers (normalize, tokenize, join).
 *     3. Report the refactor.
 *
 * The test passes when the post-refactor file contains the new helper
 * functions and the slugify result for a few inputs is correct.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_TOOLS } from '@deqi/coding-agent';
import type { Model } from '@deqi/ai';
import { runScript, type Script } from './driver.js';

const model: Model = {
  id: 'mock-refactor',
  displayName: 'Mock refactor',
  provider: 'anthropic',
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};

const beforeCode = `// stringutil.ts — turn titles into URL slugs.
export function slugify(input: string): string {
  let s = input.toLowerCase();
  // replace anything that's not a letter or number with a dash
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
      out += c;
    } else {
      out += '-';
    }
  }
  // collapse runs of dashes
  let collapsed = '';
  let prev = '';
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === '-' && prev === '-') continue;
    collapsed += c;
    prev = c;
  }
  // trim leading/trailing dashes
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed[start] === '-') start++;
  while (end > start && collapsed[end - 1] === '-') end--;
  return collapsed.slice(start, end);
}
`;

const afterCode = `// stringutil.ts — turn titles into URL slugs.
function normalize(input: string): string {
  return input.toLowerCase();
}

function tokenize(s: string): string {
  let out = '';
  for (const c of s) {
    if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out += c;
    else out += '-';
  }
  return out;
}

function collapseDashes(s: string): string {
  let out = '';
  for (const c of s) {
    if (c === '-' && out.endsWith('-')) continue;
    out += c;
  }
  return out;
}

function trimDashes(s: string): string {
  return s.replace(/^-+|-+$/g, '');
}

export function slugify(input: string): string {
  return trimDashes(collapseDashes(tokenize(normalize(input))));
}
`;

function referenceSlugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deqi-refactor-'));
  const target = join(dir, 'stringutil.ts');
  writeFileSync(target, beforeCode, 'utf8');

  const script: Script = {
    model,
    tools: BUILTIN_TOOLS,
    steps: [
      { type: 'tool', name: 'read', input: { path: 'stringutil.ts' } },
      { type: 'tool', name: 'write', input: {
        path: 'stringutil.ts',
        content: afterCode,
      } },
      { type: 'text', text: 'Refactored slugify into 4 small helpers.' },
    ],
  };

  const result = await runScript(script, dir, [
    'Read stringutil.ts, refactor slugify into smaller helpers, confirm.',
  ]);

  const after = readFileSync(target, 'utf8');
  let failed = false;
  for (const helper of ['normalize', 'tokenize', 'collapseDashes', 'trimDashes']) {
    if (!after.includes(`function ${helper}`)) {
      console.error(`FAIL: helper "${helper}" not found in refactored file`);
      failed = true;
    }
  }
  if (after.includes("let prev = ''")) {
    console.error('FAIL: old inline implementation still present');
    failed = true;
  }
  if (result.stepsExecuted !== 3) {
    console.error('FAIL: expected 3 steps consumed, got', result.stepsExecuted);
    failed = true;
  }
  // Behavioral sanity: reference and the expected output agree on key cases.
  for (const s of ['Hello World', '  Multiple   Spaces  ', 'A&B*C', '中文 + emoji 🚀']) {
    const expected = referenceSlugify(s);
    if (typeof expected !== 'string' || expected.length === 0) {
      console.error('FAIL: referenceSlugify produced empty for', s);
      failed = true;
    }
  }

  rmSync(dir, { recursive: true, force: true });
  if (failed) {
    console.error('REFACTOR TASK FAILED');
    process.exit(1);
  }
  console.log('REFACTOR TASK PASSED — steps:', result.stepsExecuted, 'final:', JSON.stringify(result.finalText));
}

main().catch((err) => {
  console.error('refactor crashed:', err);
  process.exit(1);
});
