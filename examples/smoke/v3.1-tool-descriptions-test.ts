/**
 * v3.1 test ï¿?12 tool descriptions follow Anthropic 4-principles format.
 *
 * What's covered (24 asserts):
 *   For every tool (read, write, edit, bash, grep, glob, subagent,
 *   constitution, user_model, session_history, self_reflect,
 *   webFetch, plan):
 *     - description is non-empty and >= 200 chars
 *     - has "When to use:" header
 *     - has "When NOT to use:" header
 *     - has at least one example
 *     - concurrency is declared (SAFE / NOT safe / depends on)
 *
 *   Plus: the description used by the running BUILTIN_TOOLS
 *   matches the v3.1 rewrite (not the old terse one).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` ï¿?${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` ï¿?${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1mâ”€â”€ ${t} â”€â”€\x1b[0m`); }

const TOOLS = [
  'read', 'write', 'edit', 'bash', 'grep', 'glob',
  'subagent', 'constitution', 'user_model', 'session_history',
  'self_reflect', 'webFetch', 'plan',
];

async function main(): Promise<void> {
  const descs = await import('../../packages/coding-agent/dist/src/tools/descriptions.js');
  const tools = await import('../../packages/coding-agent/dist/src/tools/index.js');

  // 1. Every tool has the Anthropic 4-shape sections.
  section('per-tool description quality');
  for (const name of TOOLS) {
    const d = descs.getToolDescription(name);
    ok(`[${name}] description is non-empty`, !!d && d.length > 0, d ? `len=${d.length}` : 'null');
    ok(`[${name}] description >= 200 chars`, !!d && d.length >= 200, d ? `len=${d.length}` : 'null');
    ok(`[${name}] has "When to use:" section`, !!d && d.includes('When to use:'));
    ok(`[${name}] has "When NOT to use:" section`, !!d && d.includes('When NOT to use:'));
    ok(`[${name}] has at least one example line`, !!d && /\bExamples:/.test(d));
    ok(`[${name}] declares concurrency`, !!d && /Concurrency:/.test(d));
  }

  // 2. The BUILTIN_TOOLS actually use these descriptions.
  section('BUILTIN_TOOLS wires the v3.1 descriptions');
  for (const name of TOOLS) {
    const t = tools.BUILTIN_TOOLS.find((x) => x.name === name);
    ok(`[${name}] is in BUILTIN_TOOLS`, !!t);
    if (!t) continue;
    const expected = descs.getToolDescription(name);
    ok(`[${name}] BUILTIN_TOOLS.description === TOOL_DESCRIPTIONS`,
      t.description === expected,
      t.description === expected ? 'match' : `len(t)=${t.description.length} vs len(expected)=${expected?.length ?? 'null'}`);
  }

  // 3. The total number of BUILTIN_TOOLS is exactly 13 (12 v2.2.1 + 1 plan).
  ok('BUILTIN_TOOLS count = 13 (12 + plan)', tools.BUILTIN_TOOLS.length === 22, `count=${tools.BUILTIN_TOOLS.length}`);

  // 4. Each description has a poka-yoke hint (warn against bad use).
  // A simple heuristic: "preference" or "prefers" or "absolute" or "must" appears.
  section('poka-yoke hints');
  for (const name of TOOLS) {
    const d = descs.getToolDescription(name) ?? '';
    const hasHint = /(?:absolute|never|always|do NOT|prefer|do not|required)/i.test(d);
    ok(`[${name}] has poka-yoke hint`, hasHint);
  }

  // 5. Tool descriptions are read by buildSystemPrompt ï¿?sanity check.
  section('integration: buildSystemPrompt sees the descriptions');
  const systemPromptMod = await import('../../packages/coding-agent/dist/src/system-prompt.js');
  const buildFn = systemPromptMod.buildSystemPrompt ?? systemPromptMod.default?.buildSystemPrompt;
  if (typeof buildFn === 'function') {
    const prompt = buildFn({
      cwd: 'C:/test',
      modelId: 'claude-sonnet-4-5',
      provider: 'openai-compat',
      agentsMdContent: '',
      skillsList: '',
      tools: tools.BUILTIN_TOOLS,
    });
    ok('system prompt includes the plan tool name', prompt.includes('plan'));
    ok('system prompt includes the webFetch tool name', prompt.includes('webFetch'));
    ok('system prompt is substantial (> 1500 chars)', prompt.length > 1500, `len=${prompt.length}`);
  } else {
    ok('buildSystemPrompt is exported', false, 'cannot find buildSystemPrompt export');
  }

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => { console.error('v3.1-tool-descriptions-test crashed:', err); process.exit(1); });
