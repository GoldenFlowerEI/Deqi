/**
 * v3.7 capability demo — run with `node examples/smoke/v3.7-demo.ts`.
 *
 * Seeds memory + skills, then exercises the three v3.7 features
 * end-to-end with realistic content. Pure local; no LLM, no network.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v37-demo-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
mkdirSync(join(tmpHome, '.deqi', 'memory', 'skills', 'ship-release'), { recursive: true });
mkdirSync(join(tmpHome, '.deqi', 'memory', 'skills', 'migrate-db'), { recursive: true });
mkdirSync(join(tmpHome, '.deqi', 'memory', 'skills', 'run-bench'), { recursive: true });
writeFileSync(join(tmpHome, '.deqi', 'memory', 'skills', 'ship-release', 'SKILL.md'),
  `# ship-release

Bump version, update CHANGELOG.md, create a git tag, push to remote, post a release note on Slack.

Steps: version-bump, changelog, tag, push, slack-post.`);
writeFileSync(join(tmpHome, '.deqi', 'memory', 'skills', 'migrate-db', 'SKILL.md'),
  `# migrate-db

Run database migrations against the staging or production cluster.

Steps: backup, dry-run, apply, verify.`);
writeFileSync(join(tmpHome, '.deqi', 'memory', 'skills', 'run-bench', 'SKILL.md'),
  `# run-bench

Execute the deqi mini-bench harness and report pass/fail counts.

Steps: build, run bench, summarize.`);
mkdirSync(join(tmpHome, '.deqi', 'memory'), { recursive: true });

const mem = await import('../../packages/coding-agent/dist/src/memory.js');
mem.addFact('env', 'repoRoot', '/Users/andy/work/deqi on the main branch');
mem.addFact('env', 'pythonPath', 'python 3.11 at /usr/local/bin/python3');
mem.addFact('path', 'githubRepo', 'AndyZhuang/deqi on github, main branch is protected');
mem.addFact('integration', 'slackWebhook', 'https://hooks.slack.com/services/T0/B0/XXXX for #eng-releases');
mem.addFact('user', 'releaseTime', 'andy prefers Tuesday 10am Pacific for releases');
mem.addPattern('cut a release',
  ['bump version in package.json', 'update CHANGELOG.md', 'git tag -a vX.Y.Z', 'git push --tags', 'post to #eng-releases']);
mem.setPref('defaultModel', 'claude-opus-4');
mem.setPref('commitStyle', 'conventional commits, scope required');

const ar = await import('../../packages/coding-agent/dist/src/auto-retrieve.js');
const sk = await import('../../packages/coding-agent/dist/src/skill-suggest.js');
const rf = await import('../../packages/coding-agent/dist/src/reflection.js');

const queries = [
  'I want to cut a new release of deqi today',
  'where is the python interpreter on this machine',
  'how do I run database migrations against staging',
];

console.log('============================================================');
console.log('  Deqi v3.7 capability demo  —  Hermes-inspired active context');
console.log('============================================================');
console.log(`Seeded ${mem.readFacts().length} facts, ${mem.readPatterns().length} patterns, ${mem.readPrefs().length} prefs, ${sk.listSkills().length} skills.`);
console.log('');

for (const q of queries) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`USER: ${q}`);
  console.log(`${'─'.repeat(64)}`);

  // 1. Auto-retrieval
  const retrieval = ar.retrieveRelevant(q);
  console.log('\n[1] AUTO-RETRIEVAL  (facts / patterns / prefs pulled from memory)');
  if (retrieval.facts.length + retrieval.patterns.length + retrieval.prefs.length === 0) {
    console.log('    (no relevant memory found)');
  } else {
    for (const f of retrieval.facts) console.log(`    - fact[${f.category}]  ${f.key} = ${f.value}   (used ${f.useCount}x)`);
    for (const p of retrieval.patterns) console.log(`    - pattern  trigger="${p.trigger}"   recipe: ${p.recipe.length} steps`);
    for (const p of retrieval.prefs)  console.log(`    - pref    ${p.key} = ${p.value}`);
  }

  // 2. Skill suggestions
  const skills = sk.suggestSkills(q, 3);
  console.log('\n[2] SKILL AUTO-SUGGESTION');
  if (skills.length === 0) {
    console.log('    (no relevant skills)');
  } else {
    for (const s of skills) console.log(`    - ${s.name}  (score ${s.score.toFixed(2)})  ${s.description.slice(0, 70)}…`);
  }

  // 3. Tool reflection (simulate 4 different tool calls and show what the model would see)
  console.log('\n[3] TOOL REFLECTION  (hints after each tool call)');
  const toolCalls = [
    { name: 'bash',     result: { content: [{ type: 'text', text: 'npm test\n' }], isError: false } },
    { name: 'grep',     result: { content: [{ type: 'text', text: 'no matches found for "fixme"' }], isError: false } },
    { name: 'read',     result: { content: [{ type: 'text', text: 'File not found: /tmp/missing.ts' }], isError: true } },
    { name: 'webFetch', result: { content: [{ type: 'text', text: 'HTTP 503 Service Unavailable (12ms)' }], isError: true } },
  ];
  for (const c of toolCalls) {
    const r = rf.reflectOnTool(c.name, {}, c.result);
    if (r.hint) {
      const label = r.kind === 'error' ? 'ERROR' : r.kind === 'empty' ? 'EMPTY ' : 'LARGE ';
      console.log(`    [${label}] ${c.name.padEnd(9)} → ${r.hint}`);
    } else {
      console.log(`    [ OK   ] ${c.name.padEnd(9)} → (no hint; result is good)`);
    }
  }

  // 4. The actual system-prompt block the LLM would see for THIS query
  if (queries[0] === q) {
    console.log('\n[4] RENDERED SYSTEM-PROMPT BLOCK (what the LLM sees on its first turn)');
    const memBlock = ar.renderRetrievedMemory(retrieval);
    const skillBlock = sk.renderSkillSuggestions(skills);
    const block = [memBlock, skillBlock].filter(Boolean).join('\n\n');
    if (block) {
      console.log('    ┌─ system-prompt-prepend ─────────────────────────────────────');
      for (const line of block.split('\n')) {
        console.log(`    │ ${line}`);
      }
      console.log('    └─────────────────────────────────────────────────────────────');
    } else {
      console.log('    (no ambient context for this query)');
    }
  }
}

console.log('\n============================================================');
console.log('  end of demo  —  the actual `agent.run()` would now receive');
console.log('  all this ambient context prepended to the system prompt,');
console.log('  plus the tool-reflection hint on the very next LLM call.');
console.log('============================================================\n');

rmSync(tmpHome, { recursive: true, force: true });
process.env.HOME = realHome;
process.env.USERPROFILE = realHome;
