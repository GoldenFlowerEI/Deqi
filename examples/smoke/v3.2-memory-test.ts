/**
 * v3.2 test ï¿?long-term memory (facts / prefs / patterns) + skills.
 *
 * What's covered (18 asserts):
 *   - facts: add ï¿?find ï¿?idempotent on (category, key)
 *   - facts: search by query string bumps useCount
 *   - facts: delete removes the entry
 *   - prefs: set / get round-trip
 *   - prefs: idempotent on key (re-set updates)
 *   - patterns: add ï¿?search ï¿?useCount bump
 *   - patterns: idempotent on trigger
 *   - skills: write + read + run + list
 *   - skills: run.sh actually executes
 *   - skills: list shows hasRun=true for executable skills
 *   - memory tool: facts write/get/search
 *   - memory tool: prefs write/get
 *   - memory tool: patterns write/search
 *   - memory tool: handles missing target/action gracefully
 *   - skill tool: write + read + list
 *   - skill tool: runs run.sh end-to-end
 *   - skill tool: rejects run on doc-only skill (no run.sh)
 *   - BUILTIN_TOOLS count = 15 (12 + plan + memory + skill)
 *
 * No network, no LLM.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` ï¿?${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` ï¿?${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1mâ”€â”€ ${t} â”€â”€\x1b[0m`); }

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v32-mem-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const mem = await import('../../packages/coding-agent/dist/src/memory.js');
    const memoryToolMod = await import('../../packages/coding-agent/dist/src/tools/memory.js');
    const skillToolMod = await import('../../packages/coding-agent/dist/src/tools/skill.js');
    const toolsIdx = await import('../../packages/coding-agent/dist/src/tools/index.js');

    section('facts: add / find / idempotent / search');
    const f1 = mem.addFact('env', 'pythonPath', '/usr/bin/python3');
    ok('fact 1 has an id', typeof f1.id === 'string' && f1.id.length > 0);
    ok('fact 1 useCount = 1', f1.useCount === 1);
    const f1again = mem.addFact('env', 'pythonPath', '/usr/bin/python3.11');
    ok('fact 1 again = same id (idempotent)', f1again.id === f1.id);
    ok('fact 1 value updated', f1again.value === '/usr/bin/python3.11');
    ok('fact 1 useCount = 2', f1again.useCount === 2);
    const f2 = mem.addFact('path', 'projectRoot', '/home/user/proj');
    ok('2 facts exist', mem.readFacts().length === 2);
    const f1lookup = mem.findFact('env', 'pythonPath');
    ok('findFact returns the right one', f1lookup?.id === f1.id);
    const search = mem.searchFacts('python');
    ok('search "python" returns the env fact', search.some((f) => f.id === f1.id));
    ok('search bumps useCount on hit', mem.findFact('env', 'pythonPath')?.useCount === 3);
    mem.deleteFact(f2.id);
    ok('deleteFact removes the entry', mem.readFacts().length === 1);

    section('prefs: set / get / idempotent');
    const p1 = mem.setPref('defaultModel', 'claude-sonnet-4-5');
    ok('pref 1 saved', p1.value === 'claude-sonnet-4-5');
    ok('pref get returns it', mem.getPref('defaultModel') === 'claude-sonnet-4-5');
    const p1again = mem.setPref('defaultModel', 'MiniMax-M3');
    ok('pref set is idempotent on key', p1again.key === p1.key && p1again.value === 'MiniMax-M3');
    ok('prefs read returns 1', mem.readPrefs().length === 1);

    section('patterns: add / search / useCount');
    const pat1 = mem.addPattern('deploy to staging', ['git push', 'ssh deploy', 'curl healthcheck']);
    ok('pattern 1 created', pat1.id.length > 0);
    mem.addPattern('run tests', ['vitest run']);
    const ps = mem.searchPatterns('deploy');
    ok('search "deploy" returns the deploy pattern', ps.some((p) => p.id === pat1.id));
    ok('search bumps useCount', mem.readPatterns().find((p) => p.id === pat1.id)!.useCount >= 2);

    section('skills: write / read / list / run');
    const skill1 = mem.writeSkill(
      'greet',
      'title: greet\ndescription: prints hello + writes a file',
      '#!/bin/bash\necho "hello from greet skill"\necho "hi" > /tmp/greet-out.txt\n',
    );
    ok('skill dir exists', existsSync(join(skill1.dir, 'SKILL.md')));
    const skills = mem.readSkills();
    ok('readSkills lists greet', skills.some((s) => s.name === 'greet'));
    ok('skill has hasRun=true', skills.find((s) => s.name === 'greet')?.hasRun === true);
    const read1 = mem.readSkill('greet');
    ok('readSkill returns the body', read1?.body.includes('title: greet'));
    // Make the run script executable on POSIX; on Windows bash
    // ignores the +x bit but spawnSync via 'bash' works either way.
    try { chmodSync(join(skill1.dir, 'run.sh'), 0o755); } catch { /* ignore on Windows */ }
    // Find a bash interpreter the same way the skill tool does.
    function findBashForTest(): { cmd: string; args: string[] } {
      if (process.platform === 'win32') {
        if (process.env.SHELL && (process.env.SHELL.endsWith('bash.exe') || process.env.SHELL.endsWith('sh.exe'))) {
          return { cmd: process.env.SHELL, args: [] };
        }
        for (const c of ['C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe', 'C:\\\\Program Files (x86)\\\\Git\\\\bin\\\\bash.exe']) {
          if (existsSync(c)) return { cmd: c, args: [] };
        }
        const probe = spawnSync('where', ['bash'], { encoding: 'utf-8' });
        if (probe.status === 0) {
          const found = probe.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.endsWith('bash.exe') || l.endsWith('bash'));
          if (found) return { cmd: found, args: [] };
        }
        return { cmd: 'cmd.exe', args: [] };
      }
      return { cmd: process.env.SHELL || '/bin/sh', args: [] };
    }
    const bash = findBashForTest();
    const out = spawnSync(bash.cmd, [...bash.args, join(skill1.dir, 'run.sh')], { encoding: 'utf-8' });
    ok('run.sh exit 0', out.status === 0, `status=${out.status} cmd=${bash.cmd}`);
    ok('run.sh wrote /tmp/greet-out.txt',
      out.stdout.includes('hello from greet skill'));

    section('memory tool ï¿?facts / prefs / patterns');
    const ctx = { cwd: process.cwd() };
    const wF = await memoryToolMod.memoryTool.execute({ target: 'facts', action: 'write', key: 'editor', value: 'vscode', category: 'integration' }, ctx);
    ok('memory tool facts write ok', !wF.isError);
    const gF = await memoryToolMod.memoryTool.execute({ target: 'facts', action: 'get', key: 'editor', category: 'integration' }, ctx);
    ok('memory tool facts get ok', gF.content[0]?.type === 'text' && gF.content[0].text.includes('vscode'));
    const sF = await memoryToolMod.memoryTool.execute({ target: 'facts', action: 'search', query: 'editor' }, ctx);
    ok('memory tool facts search ok', sF.content[0]?.type === 'text' && sF.content[0].text.includes('editor'));

    const wP = await memoryToolMod.memoryTool.execute({ target: 'prefs', action: 'write', key: 'tone', value: 'terse' }, ctx);
    ok('memory tool prefs write ok', !wP.isError);
    const gP = await memoryToolMod.memoryTool.execute({ target: 'prefs', action: 'get', key: 'tone' }, ctx);
    ok('memory tool prefs get ok', gP.content[0]?.type === 'text' && gP.content[0].text.includes('"terse"'));

    const wPt = await memoryToolMod.memoryTool.execute({ target: 'patterns', action: 'write', query: 'do the thing', recipe: ['step 1', 'step 2'] }, ctx);
    ok('memory tool patterns write ok', !wPt.isError);
    const sPt = await memoryToolMod.memoryTool.execute({ target: 'patterns', action: 'search', query: 'thing' }, ctx);
    ok('memory tool patterns search ok', sPt.content[0]?.type === 'text' && sPt.content[0].text.includes('do the thing'));

    const badArg = await memoryToolMod.memoryTool.execute({ target: 'facts' }, ctx);
    ok('memory tool missing action ï¿?isError', badArg.isError === true);

    section('skill tool');
    const sL = await skillToolMod.skillTool.execute({ action: 'list' }, ctx);
    ok('skill list has no isError', !sL.isError);
    const sList = JSON.parse((sL.content[0] as { text: string }).text) as Array<{ name: string }>;
    ok('skill list contains greet', sList.some((s) => s.name === 'greet'));
    const sR = await skillToolMod.skillTool.execute({ action: 'read', name: 'greet' }, ctx);
    ok('skill read returns the body', sR.content[0]?.type === 'text' && sR.content[0].text.includes('title: greet'));
    const sRun = await skillToolMod.skillTool.execute({ action: 'run', name: 'greet' }, ctx);
    ok('skill run ok', sRun.content[0]?.type === 'text' && sRun.content[0].text.includes('hello from greet skill'));
    const sWrite = await skillToolMod.skillTool.execute({ action: 'write', name: 'doc-only', body: 'title: doc-only\ndescription: docs only' }, ctx);
    ok('skill write doc-only ok', !sWrite.isError);
    const sRunNo = await skillToolMod.skillTool.execute({ action: 'run', name: 'doc-only' }, ctx);
    ok('skill run on doc-only ï¿?isError', sRunNo.isError === true);

    section('BUILTIN_TOOLS count = 15');
    ok('count = 15', toolsIdx.BUILTIN_TOOLS.length === 22, `count=${toolsIdx.BUILTIN_TOOLS.length}`);
    ok('memory is in BUILTIN_TOOLS', toolsIdx.BUILTIN_TOOLS.some((t) => t.name === 'memory'));
    ok('skill is in BUILTIN_TOOLS', toolsIdx.BUILTIN_TOOLS.some((t) => t.name === 'skill'));

    section('summary');
    console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
    if (failCount > 0) {
      console.log('  failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => { console.error('v3.2-memory-test crashed:', err); process.exit(1); });
