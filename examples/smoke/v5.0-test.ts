/**
 * v5.0 test — system prompt rewrite (persona, anti-patterns, self-correction,
 * verify-before-claim, output style).
 *
 * We don't run the model; we just assert on the prompt structure. The
 * hypothesis: the structural changes make the model more reliable in
 * ways we can later benchmark against GAIA / HumanEval / etc. (v5.0.1
 * or v5.0.2 roadmap).
 *
 * Test categories:
 *   1. Backward compat — constitution still prepended, tool list,
 *      AGENTS.md, skills all still present.
 *   2. New sections — A (persona), B (date), C (tool guidance pointer),
 *      D (anti-patterns), F (self-correction), G (verify-before-claim),
 *      I (no preamble).
 *   3. Sanity — total length is under 2000 tokens, no emoji, no
 *      verbatim copy of any external system prompt.
 */

import { buildSystemPrompt, type SystemPromptOptions } from '../../packages/coding-agent/dist/src/system-prompt.js';

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passCount += 1;
    console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

function main(): void {
  const opts: SystemPromptOptions = {
    cwd: 'C:\\Users\\P1\\.minimax-agent-cn\\projects\\deqi',
    modelId: 'MiniMax-M3',
    provider: 'openai-compat',
    agentsMdContent: '# Deqi AGENTS.md\n\nAlways commit after tests pass.',
    skillsList: '- **commit-message**: Write a conventional commit message.\n- **release**: Cut a release tag.',
    tools: [
      { name: 'read', description: 'Read a file with line numbers.' },
      { name: 'write', description: 'Write a new file or fully rewrite.' },
      { name: 'edit', description: 'Surgical edit by string match.' },
      { name: 'bash', description: 'Run a shell command.' },
      { name: 'subagent', description: 'Spawn a focused sub-agent.' },
      { name: 'plan', description: 'Decompose a multi-step task.' },
      { name: 'self_reflect', description: 'Capture a lesson for future sessions.' },
    ],
  };

  const prompt = buildSystemPrompt(opts);
  // Rough token estimate: ~4 chars per token.
  const approxTokens = Math.ceil(prompt.length / 4);

  section('v5.0 — Backward compatibility');
  ok('constitution still prepended',
    prompt.startsWith('# Deqi Constitution'),
    `first 60 chars: ${prompt.slice(0, 60).replace(/\n/g, '\\n')}`);
  ok('operating context still has cwd', prompt.includes('C:\\Users\\P1\\.minimax-agent-cn\\projects\\deqi'));
  ok('operating context still has model + provider', prompt.includes('MiniMax-M3') && prompt.includes('openai-compat'));
  ok('AGENTS.md still injected', prompt.includes('# Deqi AGENTS.md') && prompt.includes('Always commit after tests pass.'));
  ok('skills still listed', prompt.includes('commit-message') && prompt.includes('release'));
  ok('all 7 tools enumerated', ['read', 'write', 'edit', 'bash', 'subagent', 'plan', 'self_reflect'].every((n) => prompt.includes(`**${n}**`)));
  ok('reversibility heuristic preserved', prompt.includes('Reversibility'));

  section('v5.0.A — Strong persona block');
  ok('persona says "Deqi" with role description', /Deqi.*desktop AI agent/i.test(prompt));
  ok('persona enumerates capabilities',
    prompt.includes('Persistent memory') && prompt.includes('Sub-agents') && prompt.includes('Skills') && prompt.includes('Plugins'));
  ok('persona describes what Deqi is NOT', prompt.includes("What you are not"));
  ok('persona block does NOT contain emoji',
    !/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u.test(prompt),
    'no decorative emoji');

  section('v5.0.B — Today\'s date + timezone');
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  ok('contains today\'s date', prompt.includes(today));
  // Timezone varies (UTC on CI, Asia/Shanghai on user's box); accept any IANA-style string.
  const tzMatch = prompt.match(/Date: \d{4}-\d{2}-\d{2} \(([^)]+)\)/);
  ok('contains a timezone string', !!tzMatch && (tzMatch[1] ?? '').length > 0, `tz=${tzMatch?.[1]}`);

  section('v5.0.C — Tool guidance pointer');
  ok('points the model at the per-tool descriptions', prompt.includes('structured description') && prompt.includes('when to use'));
  ok('lists tool count in the header', /\d+ tools/.test(prompt) || prompt.includes('Available tools ('));

  section('v5.0.D — Anti-patterns list');
  ok('anti-patterns section exists', prompt.includes('Anti-patterns'));
  ok('item 1: no cat-via-bash', prompt.includes("Don't run") && prompt.includes('cat') && prompt.includes('bash'));
  ok('item 2: no echo-to-see', prompt.includes("Don't echo a file to"));
  ok('item 3: no same-failure retry', prompt.includes('same tool with the same error') && prompt.includes('2 failures'));
  ok('item 4: no unverified done', prompt.includes("Don't claim") && prompt.includes('done') && prompt.includes('verifying'));
  ok('item 5: no scope creep', prompt.includes("weren't asked to make"));
  ok('item 6: no question quoting', prompt.includes("Don't quote the user's question"));
  ok('item 7: no preamble', prompt.includes("Don't open with"));
  ok('item 8: no silent TODO', prompt.includes('TODO/FIXME placeholders'));
  ok('item 9: no emoji', prompt.includes("Don't add emoji"));
  ok('item 10: no new-file when edit wanted', prompt.includes("new file when the user wants an existing one edited"));
  // 10 numbered items
  const numberedItems = (prompt.match(/^\d+\. /gm) ?? []).length;
  ok('at least 10 numbered anti-pattern items', numberedItems >= 10, `found ${numberedItems}`);

  section('v5.0.F — Self-correction guidance');
  ok('self-correction section exists', prompt.includes('Self-correction'));
  ok('2nd-failure changes strategy', prompt.includes('2nd time') && prompt.includes('change approach'));
  ok('3rd-failure stops and self_reflects', prompt.includes('3rd time') && prompt.includes('self_reflect'));
  ok('no 4th attempt without explanation', prompt.includes("4th time") && prompt.includes('explaining'));

  section('v5.0.G — Verify before claim');
  ok('verify-before-claim section exists', prompt.includes('Verify before claim'));
  ok('requires actual verification', prompt.includes("the test ran, the file matches, the screenshot"));
  ok('"likely done" / "appears to work" language present', prompt.includes('likely done') && prompt.includes('appears to work'));
  ok('warns against "all tests pass" without running', prompt.includes('all tests pass') && prompt.includes('ran them'));

  section('v5.0.I — No preamble / no apology');
  ok('output style bans "I", "Apologies", "Certainly"', prompt.includes('"I"') && prompt.includes('"Apologies"') && prompt.includes('"Certainly"'));
  ok('bans "quote the user\'s question back"', prompt.includes("Don't quote the user's question back"));
  ok('requires "lead with the answer or the action"', prompt.includes('Lead with the answer'));

  section('v5.0 — Sanity');
  ok('total prompt is under 2000 tokens', approxTokens < 2000, `~${approxTokens} tokens (${prompt.length} chars)`);
  ok('no decorative emoji in the entire prompt',
    !/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]/u.test(prompt));
  ok('constitution source is still reported', prompt.includes('Constitution source:'));

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error('v5.0-test crashed:', err);
  process.exit(1);
}
