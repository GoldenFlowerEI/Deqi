/**
 * v3.1 test â€?project state module (initializer/coding agent persistence).
 *
 * What's covered (14 asserts):
 *   1. projectIdForCwd is stable + 16 hex chars
 *   2. loadProject returns null for fresh cwd
 *   3. initProject creates project.json on disk
 *   4. initProject is idempotent (second call returns same state)
 *   5. pickNextFeature returns the first non-passing feature
 *   6. markFeaturePass flips passes=true and updates nextFeatureIdx
 *   7. markFeaturePass is idempotent (second call is a no-op)
 *   8. phase flips to 'complete' when all features pass
 *   9. appendProgress creates progress.md with header
 *  10. readProgress returns the appended text
 *  11. writeInitScript + readInitScript round-trip
 *  12. derivePhase returns 'uninitialized' on fresh cwd
 *  13. derivePhase returns 'active' after initProject
 *  14. derivePhase returns 'complete' after all features pass
 *
 * No network, no LLM, no server spawn â€?pure file-system test.
 */

import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` â€?${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` â€?${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1mâ”€â”€ ${t} â”€â”€\x1b[0m`); }

async function main(): Promise<void> {
  // Override HOME so we don't touch the user's real ~/.deqi.
  // We monkey-patch homedir() at runtime by writing under a
  // temp HOME and asking the module to compute its own paths.
  // The state module uses homedir() internally; for a clean
  // test we pass a `cwd` arg to its helpers that takes precedence.
  // Since the state module uses homedir() globally, we instead
  // redirect the OS env. State reads homedir at call time (Node's
  // homedir reads process.env.HOME / USERPROFILE each call on
  // most platforms).
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v31-state-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const state = await import('../../packages/coding-agent/dist/src/state.js');
    // Use a fake cwd â€?projectIdForCwd is just sha1, so any string works
    const fakeCwd = 'C:/Users/P1/some/project';

    section('projectIdForCwd');
    const id1 = state.projectIdForCwd(fakeCwd);
    const id2 = state.projectIdForCwd(fakeCwd);
    const id3 = state.projectIdForCwd('C:/different');
    ok('id is 16 hex chars', /^[0-9a-f]{16}$/.test(id1), `id=${id1}`);
    ok('id is stable for same cwd', id1 === id2);
    ok('id differs for different cwd', id1 !== id3);

    section('loadProject on fresh cwd');
    ok('returns null when no project.json', state.loadProject(fakeCwd) === null);

    section('initProject creates state');
    const created = state.initProject(fakeCwd, 'Build a TODO list', [
      { id: 'feat_a', category: 'functional', description: 'Add item', steps: ['1. Type', '2. Enter'] },
      { id: 'feat_b', category: 'functional', description: 'Delete item', steps: ['1. Click X'] },
      { id: 'feat_c', category: 'non-functional', description: 'Persist to disk', steps: ['1. Reload page'] },
    ]);
    ok('created has 3 features', created.features.length === 3);
    ok('all features start as not passing', created.features.every((f) => f.passes === false));
    ok('nextFeatureIdx points at first', created.nextFeatureIdx === 0);
    ok('project.json exists on disk', existsSync(join(state.projectDir(fakeCwd), 'project.json')));

    section('initProject is idempotent');
    const again = state.initProject(fakeCwd, 'Build a TODO list', [
      { id: 'feat_x', category: 'functional', description: 'different', steps: [] },
    ]);
    ok('second call returns existing state (same goal)', again.goal === 'Build a TODO list');
    ok('features list not replaced', again.features.length === 3);
    ok('existing feature ids preserved', again.features.some((f) => f.id === 'feat_a'));

    section('pickNextFeature / markFeaturePass');
    const loaded = state.loadProject(fakeCwd)!;
    const first = state.pickNextFeature(loaded);
    ok('pickNextFeature returns first failing', first?.id === 'feat_a');
    state.markFeaturePass(loaded, 'feat_a', 'session_001');
    const after1 = state.loadProject(fakeCwd)!;
    ok('feat_a is passing after mark', after1.features.find((f) => f.id === 'feat_a')?.passes === true);
    ok('feat_a has passedAt timestamp', !!after1.features.find((f) => f.id === 'feat_a')?.passedAt);
    ok('nextFeatureIdx advanced to 1', after1.nextFeatureIdx === 1);
    const second = state.pickNextFeature(after1);
    ok('pickNextFeature now returns feat_b', second?.id === 'feat_b');
    state.markFeaturePass(after1, 'feat_b', 'session_001');
    state.markFeaturePass(after1, 'feat_c', 'session_001');
    const allPass = state.loadProject(fakeCwd)!;
    ok('phase flips to complete when all pass', allPass.phase === 'complete', `phase=${allPass.phase}`);
    ok('nextFeatureIdx === -1 when complete', allPass.nextFeatureIdx === -1);

    section('markFeaturePass is idempotent');
    const beforeIdem = allPass.features.find((f) => f.id === 'feat_a')?.passedBySession;
    state.markFeaturePass(allPass, 'feat_a', 'session_002');
    const afterIdem = state.loadProject(fakeCwd)!;
    ok('second mark does not overwrite passedBySession',
      afterIdem.features.find((f) => f.id === 'feat_a')?.passedBySession === beforeIdem);

    section('progress.md');
    const projDir = state.projectDir(fakeCwd);
    if (existsSync(join(projDir, 'progress.md'))) rmSync(join(projDir, 'progress.md'));
    state.appendProgress(fakeCwd, 'session_001', ['Wrote init.sh', 'Ran npm install', 'Marked feat_a as passing']);
    const progress = state.readProgress(fakeCwd);
    // The format is `## <ts> Â· session <id.slice(0, 8)>` so the
    // first 8 chars of "session_001" are "session_". Just check
    // the prefix is there.
    ok('progress.md contains the session id prefix', progress.includes('session session_'));
    ok('progress.md contains the first line', progress.includes('Wrote init.sh'));
    ok('progress.md contains the last line', progress.includes('Marked feat_a as passing'));

    section('init.sh');
    if (existsSync(join(projDir, 'init.sh'))) rmSync(join(projDir, 'init.sh'));
    state.writeInitScript(fakeCwd, '#!/usr/bin/env bash\nset -e\nnpm install\n');
    ok('init.sh round-trip', state.readInitScript(fakeCwd)?.includes('npm install'));

    section('derivePhase');
    // Reset: delete progress + state, re-init fresh
    rmSync(state.projectDir(fakeCwd), { recursive: true, force: true });
    ok('derivePhase on fresh cwd = uninitialized', state.derivePhase(fakeCwd) === 'uninitialized');
    state.initProject(fakeCwd, 'x', [{ id: 'f1', category: 'functional', description: 'x', steps: [] }]);
    ok('derivePhase after initProject = active', state.derivePhase(fakeCwd) === 'active');
    const fresh = state.loadProject(fakeCwd)!;
    state.markFeaturePass(fresh, 'f1', 's');
    ok('derivePhase after all pass = complete', state.derivePhase(fakeCwd) === 'complete');

    section('summary');
    console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
    if (failCount > 0) {
      console.log('  failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    // best-effort cleanup
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => { console.error('v3.1-state-test crashed:', err); process.exit(1); });
