/**
 * v0.6 smoke test: constitution + tool mastery.
 *
 * Verifies:
 *   1. loadConstitution() returns the built-in default.
 *   2. listPrinciples() extracts 10 numbered principles.
 *   3. constitutionTool.execute() returns all principles or one by name.
 *   4. constitutionTool.execute() handles bad input gracefully.
 *   5. buildSystemPrompt() includes the constitution text.
 *   6. ToolMasteryTracker records success/error and produces misuse hints.
 *   7. ToolMasteryTracker classifies novice/developing/mastered/misused.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  constitutionTool,
  ToolMasteryTracker,
  buildSystemPrompt,
  loadConstitution,
  listPrinciples,
  _resetConstitutionCache,
} from '@deqi/coding-agent';
import type { ToolExecutionContext } from '@deqi/agent-core';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

function makeCtx(): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    messages: [],
    log: () => {},
  };
}

async function main(): Promise<void> {
  // -- Test 1: loadConstitution returns the built-in default.
  {
    const c = loadConstitution();
    ok('loadConstitution returns text', c.text.length > 100);
    ok('source is the built-in path', c.source.includes('constitution.md'));
  }

  // -- Test 2: listPrinciples extracts 10 principles from the default.
  {
    const c = loadConstitution();
    const principles = listPrinciples(c.text);
    ok('listPrinciples returns 10 principles', principles.length === 10, `got ${principles.length}`);
    ok('first principle mentions read', principles[0].toLowerCase().includes('read'));
  }

  // -- Test 3: env var override.
  {
    const dir = mkdtempSync(join(tmpdir(), 'deqi-const-'));
    const customPath = join(dir, 'my-const.md');
    writeFileSync(customPath, '# Custom\n\n1. Always be kind.\n2. Always be brief.\n', 'utf8');
    const prev = process.env.Deqi_CONSTITUTION;
    process.env.Deqi_CONSTITUTION = customPath;
    // Reset cache so the env var is picked up.
    _resetConstitutionCache();
    const c = loadConstitution();
    ok('env var override is respected', c.text.includes('Always be kind'));
    ok('source is the env-var path', c.source === customPath);
    // Restore
    if (prev === undefined) delete process.env.Deqi_CONSTITUTION;
    else process.env.Deqi_CONSTITUTION = prev;
    _resetConstitutionCache();
    rmSync(dir, { recursive: true, force: true });
  }

  // -- Test 4: constitutionTool returns all principles.
  {
    const r = await constitutionTool.execute({}, makeCtx());
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('constitution tool returns text', text.length > 100);
    ok('output includes "Constitution ("', text.startsWith('Constitution ('));
    ok('output includes all 10 numbered', text.includes('10. '));
  }

  // -- Test 5: constitutionTool returns a single principle.
  {
    const r = await constitutionTool.execute({ principle: 'verify' }, makeCtx());
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('single principle query works', text.includes('Verify before claiming'));
  }

  // -- Test 6: constitutionTool reports bad input.
  {
    const r = await constitutionTool.execute({ principle: 'no-such-thing' }, makeCtx());
    ok('unknown principle is isError', r.isError === true);
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('error message names the bad query', text.includes('no-such-thing'));
  }

  // -- Test 7: buildSystemPrompt includes the constitution.
  {
    const prompt = buildSystemPrompt({
      cwd: process.cwd(),
      modelId: 'test',
      provider: 'test',
      agentsMdContent: '',
      skillsList: '',
    });
    ok('system prompt includes the constitution', prompt.includes('Read before write'));
    ok('system prompt identifies the constitution source', prompt.includes('Constitution source'));
  }

  // -- Test 8: ToolMasteryTracker — novice classification.
  {
    const t = new ToolMasteryTracker();
    ok('untrained tool is novice', t.level('bash') === 'novice');
    t.record('bash', false);
    t.record('bash', false);
    ok('after 2 calls still novice', t.level('bash') === 'novice');
  }

  // -- Test 9: ToolMasteryTracker — mastered.
  {
    const t = new ToolMasteryTracker();
    for (let i = 0; i < 10; i++) t.record('read', false); // 10 ok
    ok('10/10 read is mastered', t.level('read') === 'mastered');
    ok('stats reflect 10 calls', t.statsFor('read')?.calls === 10);
    ok('stats reflect 100% success', (t.statsFor('read')?.successRate ?? 0) === 1);
  }

  // -- Test 10: ToolMasteryTracker — misuse produces a hint.
  {
    const t = new ToolMasteryTracker();
    const events: string[] = [];
    t.onMisuse((name) => events.push(name));
    // 8 errors in a row
    for (let i = 0; i < 8; i++) t.record('edit', true);
    ok('after 8/8 errors, level is misused', t.level('edit') === 'misused');
    ok('misuse event fired', events.includes('edit'));
  }

  // -- Test 11: ToolMasteryTracker — developing.
  {
    const t = new ToolMasteryTracker();
    // 5 ok, 3 errors -> 62.5% success -> developing
    for (let i = 0; i < 5; i++) t.record('grep', false);
    for (let i = 0; i < 3; i++) t.record('grep', true);
    ok('5/8 ok is developing', t.level('grep') === 'developing');
  }

  // -- Test 12: allStats returns the right shape.
  {
    const t = new ToolMasteryTracker();
    t.record('read', false);
    t.record('read', false);
    t.record('read', true);
    const all = t.allStats();
    ok('allStats lists read', all.some((s) => s.name === 'read'));
    const read = all.find((s) => s.name === 'read')!;
    ok('allStats includes errors count', read.errors === 1);
  }

  console.log(process.exitCode === 1 ? 'CONSTITUTION SMOKE FAILED' : 'CONSTITUTION SMOKE PASSED');
}

main().catch((err) => {
  console.error('constitution smoke crashed:', err);
  process.exit(1);
});
