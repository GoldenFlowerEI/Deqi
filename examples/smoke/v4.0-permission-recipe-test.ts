/**
 * v4.0 permission modes + Recipe YAML test.
 *
 * What's covered (16 asserts):
 *   1-4. modeAllows for each of the 4 tiers (plan / default / accept-edits / bypass)
 *   5-6. modeAllows for chat_only (denies all)
 *   7-8. migrateLegacyMode maps v3.x names to v4.0 names
 *   9-10. modeLabel returns a human string; USER_VISIBLE_MODES is 4
 *  11-12. parseRecipe: simple recipe + complex one with multi-line map
 *  13. parseRecipe throws on missing `name`
 *  14. parseRecipe throws on missing `steps`
 *  15. parseRecipe throws on step missing `tool`
 *  16. stringifyRecipe round-trips
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
  // ── 1. permission modes
  const perm = await import('../../packages/server/dist/permission-modes.js');
  const { modeAllows, modeLabel, USER_VISIBLE_MODES, migrateLegacyMode } = perm;

  section('modeAllows across the 4 tiers');
  ok('plan mode: read is allowed', modeAllows('plan', 'read', {}) === 'allow');
  ok('plan mode: bash asks', modeAllows('plan', 'bash', {}) === 'ask');
  ok('plan mode: edit asks', modeAllows('plan', 'edit', {}) === 'ask');
  ok('default mode: read is allowed', modeAllows('default', 'read', {}) === 'allow');
  ok('default mode: bash asks', modeAllows('default', 'bash', {}) === 'ask');
  ok('default mode: edit asks', modeAllows('default', 'edit', {}) === 'ask');
  ok('accept-edits mode: read is allowed', modeAllows('accept-edits', 'read', {}) === 'allow');
  ok('accept-edits mode: edit is allowed (the whole point)',
    modeAllows('accept-edits', 'edit', {}) === 'allow');
  ok('accept-edits mode: bash still asks',
    modeAllows('accept-edits', 'bash', {}) === 'ask');
  ok('bypass mode: bash is allowed', modeAllows('bypass-permissions', 'bash', {}) === 'allow');
  ok('bypass mode: edit is allowed', modeAllows('bypass-permissions', 'edit', {}) === 'allow');
  ok('chat_only mode denies everything',
    modeAllows('chat_only', 'read', {}) === 'deny' &&
    modeAllows('chat_only', 'edit', {}) === 'deny');

  section('migration + labels');
  ok('migrateLegacyMode: autonomous → bypass-permissions',
    migrateLegacyMode('autonomous') === 'bypass-permissions');
  ok('migrateLegacyMode: smart → default',
    migrateLegacyMode('smart') === 'default');
  ok('migrateLegacyMode: manual → plan',
    migrateLegacyMode('manual') === 'plan');
  ok('migrateLegacyMode: chat_only → chat_only',
    migrateLegacyMode('chat_only') === 'chat_only');
  ok('migrateLegacyMode: v4.0 names pass through',
    migrateLegacyMode('plan') === 'plan' &&
    migrateLegacyMode('default') === 'default' &&
    migrateLegacyMode('accept-edits') === 'accept-edits' &&
    migrateLegacyMode('bypass-permissions') === 'bypass-permissions');
  ok('modeLabel returns a non-empty human string',
    modeLabel('plan').length > 0 && modeLabel('default').length > 0);
  ok('USER_VISIBLE_MODES is 4 (excludes chat_only)',
    USER_VISIBLE_MODES.length === 4 && !USER_VISIBLE_MODES.includes('chat_only'));

  // ── 2. recipe parser
  const rec = await import('../../packages/coding-agent/dist/src/recipe.js');
  const { parseRecipe, stringifyRecipe, validateRecipeTools } = rec;

  section('parseRecipe — simple');
  const simple = parseRecipe(`
name: hello
description: A trivial recipe
steps:
  - name: step one
    tool: read
    args:
      path: README.md
`);
  ok('simple recipe parses with 1 step',
    simple.name === 'hello' && simple.steps.length === 1 &&
    simple.steps[0].tool === 'read' && simple.steps[0].args.path === 'README.md');

  section('parseRecipe — complex');
  const complex = parseRecipe(`
name: release
description: bump + tag + push
steps:
  - name: bump version
    tool: edit
    args:
      path: package.json
      old: "1.0.0"
      new: "1.1.0"
  - name: commit
    tool: bash
    args:
      command: git commit -am "release"
      timeout: 60000
  - name: tag
    tool: bash
    args:
      command: git tag -a v1.1.0 -m "v1.1.0"
`);
  ok('complex recipe parses with 3 steps',
    complex.steps.length === 3 &&
    complex.steps[0].args.new === '1.1.0' &&
    complex.steps[1].args.timeout === 60000);

  section('parseRecipe — errors');
  let threw = '';
  try { parseRecipe('steps: []'); } catch (e) { threw = (e as Error).message; }
  ok('parseRecipe throws on missing name', threw.includes('name'));
  threw = '';
  try { parseRecipe('name: x'); } catch (e) { threw = (e as Error).message; }
  ok('parseRecipe throws on missing steps', threw.includes('steps'));
  threw = '';
  try { parseRecipe('name: x\nsteps:\n  - name: bad'); } catch (e) { threw = (e as Error).message; }
  ok('parseRecipe throws on step missing tool', threw.includes('tool'));

  section('stringifyRecipe round-trips');
  const original = parseRecipe(`name: roundtrip
steps:
  - name: readme
    tool: read
    args:
      path: README.md
`);
  const text = stringifyRecipe(original);
  const reparsed = parseRecipe(text);
  ok('stringify → parse preserves name + first step',
    reparsed.name === 'roundtrip' && reparsed.steps[0].tool === 'read');

  section('validateRecipeTools');
  const known = new Set(['read', 'write', 'edit', 'bash']);
  const missing = validateRecipeTools(complex, known);
  ok('validateRecipeTools: all complex recipe tools are known',
    missing.length === 0,
    `missing=${missing.join(',')}`);
  const missing2 = validateRecipeTools(complex, new Set(['read']));
  ok('validateRecipeTools: reports unknown tools (3 occurrences: edit, bash, bash)',
    missing2.length === 3 && missing2.includes('edit') && missing2.includes('bash'));

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v4.0-permission-recipe-test crashed:', err);
  process.exit(1);
});
