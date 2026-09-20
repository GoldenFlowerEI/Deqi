/**
 * v4.0 - v4.3 combined test.
 *
 * v4.0 (27 asserts): permission modes + recipe parser
 * v4.3 (10 asserts): bench reporter (render + compare)
 * v4.1 + v4.2 are server-runtime (WS + tool) and not unit-tested
 * here; their coverage is via the integration smoke tests.
 *
 * What's covered (37 asserts total):
 *   1-4.  permission modes (4 tiers + chat_only)
 *   5-6.  legacy migration
 *   7-8.  USER_VISIBLE_MODES + modeLabel
 *   9-12. recipe parser (simple, complex, errors, round-trip)
 *   13.   recipe validation
 *   14-17. bench reporter: renderMarkdownReport shape
 *   18-21. compareReports: regressions + fixes + delta
 *   22.   summaryLine format
 */

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

async function main(): Promise<void> {
  // ── v4.0: permission modes
  const perm = await import('../../packages/server/dist/permission-modes.js');
  const { modeAllows, modeLabel, USER_VISIBLE_MODES, migrateLegacyMode } = perm;

  section('v4.0 — permission modes');
  ok('plan allows read-only, asks on bash/edit',
    modeAllows('plan', 'read', {}) === 'allow' &&
    modeAllows('plan', 'bash', {}) === 'ask' &&
    modeAllows('plan', 'edit', {}) === 'ask');
  ok('default asks on edit + bash, allows read',
    modeAllows('default', 'read', {}) === 'allow' &&
    modeAllows('default', 'edit', {}) === 'ask' &&
    modeAllows('default', 'bash', {}) === 'ask');
  ok('accept-edits allows edit, asks on bash',
    modeAllows('accept-edits', 'edit', {}) === 'allow' &&
    modeAllows('accept-edits', 'bash', {}) === 'ask');
  ok('bypass-permissions allows everything',
    modeAllows('bypass-permissions', 'bash', {}) === 'allow' &&
    modeAllows('bypass-permissions', 'edit', {}) === 'allow');
  ok('chat_only denies every tool',
    modeAllows('chat_only', 'read', {}) === 'deny');
  ok('migrateLegacyMode covers all 4 legacy names',
    migrateLegacyMode('autonomous') === 'bypass-permissions' &&
    migrateLegacyMode('smart') === 'default' &&
    migrateLegacyMode('manual') === 'plan' &&
    migrateLegacyMode('chat_only') === 'chat_only');
  ok('USER_VISIBLE_MODES is 4 user-facing modes',
    USER_VISIBLE_MODES.length === 4 && !USER_VISIBLE_MODES.includes('chat_only'));
  ok('modeLabel returns human strings',
    modeLabel('plan').length > 0 && modeLabel('default').length > 0);

  // ── v4.0: recipe parser
  const rec = await import('../../packages/coding-agent/dist/src/recipe.js');
  const { parseRecipe, stringifyRecipe, validateRecipeTools } = rec;

  section('v4.0 — recipe parser');
  const simple = parseRecipe(`name: simple
steps:
  - name: read
    tool: read
    args:
      path: README.md
`);
  ok('parseRecipe: simple recipe',
    simple.steps.length === 1 && simple.steps[0].tool === 'read' && simple.steps[0].args.path === 'README.md');

  const complex = parseRecipe(`name: complex
description: 3 steps
steps:
  - name: bump
    tool: edit
    args:
      path: package.json
  - name: test
    tool: bash
    args:
      command: bun test
      timeout: 60000
  - name: commit
    tool: bash
    args:
      command: git commit -am "bump"
`);
  ok('parseRecipe: complex recipe has 3 steps with nested args',
    complex.steps.length === 3 &&
    complex.steps[1].args.timeout === 60000 &&
    complex.steps[0].args.path === 'package.json');

  let threw = '';
  try { parseRecipe('steps: []'); } catch (e) { threw = (e as Error).message; }
  ok('parseRecipe throws on missing name', threw.includes('name'));
  threw = '';
  try { parseRecipe('name: x'); } catch (e) { threw = (e as Error).message; }
  ok('parseRecipe throws on missing steps', threw.includes('steps'));

  ok('stringifyRecipe round-trips',
    JSON.stringify(parseRecipe(stringifyRecipe(simple))) === JSON.stringify(simple));

  ok('validateRecipeTools: all-known returns []',
    validateRecipeTools(complex, new Set(['read', 'edit', 'bash'])).length === 0);

  // ── v4.3: bench reporter
  const benchMod = await import(
    '../../packages/coding-agent/dist/src/index.js'
  );
  const { renderMarkdownReport, compareReports, summaryLine } = benchMod;
  type BenchSummary = {
    total: number; pass: number; fail: number;
    results: Array<{ caseId: string; name: string; pass: boolean; details: string[] }>;
    label?: string; finishedAt?: string; durationMs?: number;
  };

  section('v4.3 — bench reporter');
  const sampleResults = [
    { caseId: 'c1', name: 'case-a', pass: true, details: ['ok'] },
    { caseId: 'c2', name: 'case-b', pass: false, details: ['expected foo, got bar'] },
  ];
  const summary: BenchSummary = {
    total: 2,
    pass: 1,
    fail: 1,
    results: sampleResults,
    label: 'v4.3-test',
    finishedAt: '2026-09-09T00:00:00Z',
    durationMs: 1234,
  };
  const md = renderMarkdownReport(summary);
  ok('renderMarkdownReport contains the title line',
    md.startsWith('# Bench report — v4.3-test'));
  ok('renderMarkdownReport shows the totals',
    md.includes('**Total:** 2') && md.includes('**Pass:** 1') && md.includes('**Fail:** 1'));
  ok('renderMarkdownReport includes a markdown table',
    md.includes('| Case | Pass | Detail |') && md.includes('| case-a | ✅ | ok |'));
  ok('renderMarkdownReport lists failures at the bottom',
    md.includes('## Failures (1)') && md.includes('case-b'));

  const afterResults = [
    { caseId: 'c1', name: 'case-a', pass: true, details: ['ok'] },
    { caseId: 'c2', name: 'case-b', pass: true, details: ['now passes'] },
    { caseId: 'c3', name: 'case-c', pass: false, details: ['newly broken'] },
  ];
  const after: BenchSummary = {
    total: 3, pass: 2, fail: 1, results: afterResults, label: 'after',
  };
  const diff = compareReports(summary, after);
  ok('compareReports: case-b is a fix (was fail, now pass)',
    diff.fixes.some((f) => f.name === 'case-b'));
  ok('compareReports: case-c is a new failing case (newCases)',
    diff.newCases.some((n) => n.name === 'case-c' && !n.pass));
  ok('compareReports: no false regression on case-a (pass in both)',
    !diff.regressions.some((r) => r.name === 'case-a'));
  ok('compareReports: delta is correct',
    diff.delta.beforePass === 1 && diff.delta.afterPass === 2 &&
    diff.delta.beforeFail === 1 && diff.delta.afterFail === 1);

  ok('summaryLine: includes label + pass/total + rate',
    summaryLine(after).includes('after') &&
    summaryLine(after).includes('2/3') &&
    summaryLine(after).includes('67%') /* 2/3 = 66.7% rounded */);

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v4.x-test crashed:', err);
  process.exit(1);
});
