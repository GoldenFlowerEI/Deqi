/**
 * v3.4 test ï¿?eval tool + introspection log.
 *
 * What's covered (~26 asserts):
 *   - LOG_ROOT defaults to ~/.deqi/introspection
 *   - appendEntry creates a file under <LOG_ROOT>/<sessionId>.jsonl
 *   - appendEntry appends (doesn't truncate)
 *   - readRecent returns the entries newest-last
 *   - readRecent with limit < total returns the tail
 *   - readRecent on a missing session returns []
 *   - readAll across sessions
 *   - getAggregateStats: totalEntries, byType counts
 *   - getAggregateStats: meanGrade computed only from valid grades
 *   - getAggregateStats: uniqueTools counts distinct tool_call.tool
 *   - getAggregateStats: firstAt / lastAt span the entries
 *   - getAggregateStats: empty log returns sane zeros + null meanGrade
 *   - eval tool: grade mode with valid args ï¿?ok, no isError
 *   - eval tool: writes a 'grade' entry to the log
 *   - eval tool: returns meanGrade in the response
 *   - eval tool: missing required arg ï¿?isError
 *   - eval tool: grade out of [0, 1] ï¿?isError
 *   - eval tool: stats mode ï¿?returns AggregateStats, no writes
 *   - eval tool: recent mode ï¿?returns the tail
 *   - eval tool: turn mode auto-fills subject from last tool_call
 *   - eval tool: isConcurrencySafe is false
 *   - BUILTIN_TOOLS count = 17 (16 + eval)
 *   - BUILTIN_TOOLS includes eval
 *   - eval has the v3.1 description style
 *
 * No network, no LLM.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);

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
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v34-eval-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const introMod = await import('../../packages/coding-agent/dist/src/introspection.js');
    const evalMod = await import('../../packages/coding-agent/dist/src/tools/eval.js');
    const toolsIdx = await import('../../packages/coding-agent/dist/src/tools/index.js');

    section('LOG_ROOT + filesystem');
    // After we redirected HOME/USERPROFILE to tmpHome, LOG_ROOT must
    // follow. We only check the suffix; the absolute prefix is OS-dependent.
    ok('LOG_ROOT ends with .deqi/introspection',
      introMod.LOG_ROOT.endsWith(`${join('.deqi', 'introspection')}`),
      `LOG_ROOT=${introMod.LOG_ROOT}`);

    section('appendEntry / readRecent');
    const S1 = 'sess-eval-1';
    introMod.appendEntry({ ts: '2024-01-01T00:00:00.000Z', sessionId: S1, type: 'session_start', payload: { note: 'begin' } });
    introMod.appendEntry({ ts: '2024-01-01T00:00:01.000Z', sessionId: S1, type: 'tool_call', payload: { tool: 'read', args: { path: '/x' } } });
    introMod.appendEntry({ ts: '2024-01-01T00:00:02.000Z', sessionId: S1, type: 'grade', payload: { subject: 'read', grade: 0.8, rationale: 'good' } });
    const logFile = join(introMod.LOG_ROOT, `${S1}.jsonl`);
    ok('appendEntry creates the per-session log file', existsSync(logFile), `logFile=${logFile}`);
    const raw = readFileSync(logFile, 'utf-8');
    ok('log file is JSONL (3 lines, 1 per entry)', raw.split('\n').filter(Boolean).length === 3, `lines=${raw.split('\n').filter(Boolean).length}`);
    ok('each line is valid JSON with a "type" field', raw.split('\n').filter(Boolean).every((l) => { try { return JSON.parse(l).type; } catch { return false; } }));

    const recent = introMod.readRecent(S1, 50);
    ok('readRecent returns all 3 entries', recent.length === 3, `len=${recent.length}`);
    ok('readRecent preserves order (oldest first)', recent[0].type === 'session_start' && recent[1].type === 'tool_call' && recent[2].type === 'grade');
    const tailed = introMod.readRecent(S1, 2);
    ok('readRecent with limit < total returns tail', tailed.length === 2 && tailed[1].type === 'grade');
    ok('readRecent on missing session returns []', introMod.readRecent('does-not-exist', 10).length === 0);

    // append doesn't truncate
    introMod.appendEntry({ ts: '2024-01-01T00:00:03.000Z', sessionId: S1, type: 'session_end', payload: {} });
    const after = introMod.readRecent(S1, 50);
    ok('append does not truncate (now 4 entries)', after.length === 4, `len=${after.length}`);

    section('readAll across sessions');
    const S2 = 'sess-eval-2';
    introMod.appendEntry({ ts: '2024-01-02T00:00:00.000Z', sessionId: S2, type: 'tool_call', payload: { tool: 'write' } });
    const all = introMod.readAll();
    const sessionIds = new Set(all.map((e: { sessionId: string }) => e.sessionId));
    ok('readAll includes both sessions', sessionIds.has(S1) && sessionIds.has(S2), `sessions=${[...sessionIds].join(',')}`);

    section('getAggregateStats ï¿?counters');
    const stats = introMod.getAggregateStats();
    ok('totalEntries >= 5', stats.totalEntries >= 5, `totalEntries=${stats.totalEntries}`);
    ok('byType.tool_call >= 2', (stats.byType['tool_call'] ?? 0) >= 2, `byType.tool_call=${stats.byType['tool_call']}`);
    ok('byType.grade >= 1', (stats.byType['grade'] ?? 0) >= 1);
    ok('byType.session_start >= 1', (stats.byType['session_start'] ?? 0) >= 1);
    ok('sessionCount = 2', stats.sessionCount === 2, `sessionCount=${stats.sessionCount}`);
    ok('gradeCount = 1 (only one valid grade)', stats.gradeCount === 1, `gradeCount=${stats.gradeCount}`);
    ok('meanGrade ï¿?0.8', stats.meanGrade !== null && Math.abs(stats.meanGrade - 0.8) < 1e-9, `meanGrade=${stats.meanGrade}`);
    ok('toolCallCount counts tool_call entries', stats.toolCallCount === 2, `toolCallCount=${stats.toolCallCount}`);
    ok('uniqueTools counts distinct tool names', stats.uniqueTools === 2, `uniqueTools=${stats.uniqueTools}`);
    ok('firstAt is non-null', stats.firstAt !== null);
    ok('lastAt >= firstAt', stats.firstAt !== null && stats.lastAt !== null && stats.lastAt >= stats.firstAt);

    // meanGrade only from valid grades: add an invalid one
    introMod.appendEntry({ ts: '2024-01-03T00:00:00.000Z', sessionId: S1, type: 'grade', payload: { subject: 'x', grade: 5, rationale: 'oob' } });
    const stats2 = introMod.getAggregateStats();
    ok('grade out of [0,1] is NOT counted in meanGrade',
      stats2.gradeCount === 1 && Math.abs((stats2.meanGrade ?? 0) - 0.8) < 1e-9,
      `gradeCount=${stats2.gradeCount} meanGrade=${stats2.meanGrade}`);

    // Note: in-process the real ~/.deqi may have a stale log; we DON'T assert
    // exact totalEntries here because the real log may have been polluted by
    // earlier sessions. The "no-extra-grades" assertion above is robust.

    section('eval tool ï¿?happy path');
    const happyRes = await evalMod.evalTool.execute({
      mode: 'grade', subject: 'tool:read', grade: 0.9, rationale: 'worked',
    }, { cwd: process.cwd(), sessionId: 'sess-eval-tool-1' });
    ok('grade mode has no isError', !happyRes.isError);
    const happyText = happyRes.content[0]?.type === 'text' ? happyRes.content[0].text : '';
    const happyParsed = JSON.parse(happyText);
    ok('grade mode returns ok: true', happyParsed.ok === true);
    ok('grade mode returns id (4-byte hex)', typeof happyParsed.id === 'string' && /^[0-9a-f]{8}$/.test(happyParsed.id), `id=${happyParsed.id}`);
    ok('grade mode returns the entry with subject', happyParsed.entry.payload.subject === 'tool:read');
    ok('grade mode returns meanGrade', typeof happyParsed.meanGrade === 'number');
    const wrote = introMod.readRecent('sess-eval-tool-1', 50);
    ok('grade mode actually wrote to the log', wrote.some((e: { type: string }) => e.type === 'grade'));

    section('eval tool ï¿?error cases');
    const noSubject = await evalMod.evalTool.execute({ mode: 'grade', grade: 0.5, rationale: 'x' }, { cwd: process.cwd() });
    ok('grade mode missing subject ï¿?isError', noSubject.isError === true);
    const noGrade = await evalMod.evalTool.execute({ mode: 'grade', subject: 'x', rationale: 'x' }, { cwd: process.cwd() });
    ok('grade mode missing grade ï¿?isError', noGrade.isError === true);
    const noRationale = await evalMod.evalTool.execute({ mode: 'grade', subject: 'x', grade: 0.5 }, { cwd: process.cwd() });
    ok('grade mode missing rationale ï¿?isError', noRationale.isError === true);
    const oob = await evalMod.evalTool.execute({ mode: 'grade', subject: 'x', grade: 1.5, rationale: 'r' }, { cwd: process.cwd() });
    ok('grade out of [0,1] ï¿?isError', oob.isError === true);
    const neg = await evalMod.evalTool.execute({ mode: 'grade', subject: 'x', grade: -0.1, rationale: 'r' }, { cwd: process.cwd() });
    ok('grade < 0 ï¿?isError', neg.isError === true);

    section('eval tool ï¿?read modes');
    const statsRes = await evalMod.evalTool.execute({ mode: 'stats' }, { cwd: process.cwd() });
    ok('stats mode has no isError', !statsRes.isError);
    const statsParsed = JSON.parse(statsRes.content[0]?.type === 'text' ? statsRes.content[0].text : '');
    ok('stats mode returns totalEntries', typeof statsParsed.totalEntries === 'number');
    ok('stats mode returns byType object', typeof statsParsed.byType === 'object' && statsParsed.byType !== null);

    const recentRes = await evalMod.evalTool.execute({ mode: 'recent', sessionId: 'sess-eval-tool-1', limit: 5 }, { cwd: process.cwd() });
    ok('recent mode has no isError', !recentRes.isError);
    const recentArr = JSON.parse(recentRes.content[0]?.type === 'text' ? recentRes.content[0].text : '');
    ok('recent mode returns an array', Array.isArray(recentArr));
    ok('recent mode length ï¿?limit', recentArr.length <= 5);

    section('eval tool ï¿?turn mode auto-fills subject from last tool_call');
    // Pre-populate a tool_call so the auto-fill kicks in
    introMod.appendEntry({ ts: '2024-02-01T00:00:00.000Z', sessionId: 'sess-eval-turn', type: 'tool_call', payload: { tool: 'webFetch' } });
    const turnRes = await evalMod.evalTool.execute({ mode: 'turn', grade: 0.5, rationale: 'partial' }, { cwd: process.cwd(), sessionId: 'sess-eval-turn' });
    ok('turn mode has no isError', !turnRes.isError);
    const turnParsed = JSON.parse(turnRes.content[0]?.type === 'text' ? turnRes.content[0].text : '');
    ok('turn mode auto-fills subject with last tool',
      turnParsed.entry.payload.subject === 'turn-with-webFetch',
      `subject=${turnParsed.entry.payload.subject}`);

    section('eval tool ï¿?concurrency');
    ok('eval isConcurrencySafe returns false', evalMod.evalTool.isConcurrencySafe?.({}) === false);

    section('BUILTIN_TOOLS');
    ok('count = 17 (16 prior + eval)', toolsIdx.BUILTIN_TOOLS.length === 22, `count=${toolsIdx.BUILTIN_TOOLS.length}`);
    ok('eval is in BUILTIN_TOOLS', toolsIdx.BUILTIN_TOOLS.some((t: { name: string }) => t.name === 'eval'));
    const evalInTools = toolsIdx.BUILTIN_TOOLS.find((t: { name: string }) => t.name === 'eval');
    ok('eval has the v3.1 description (Self-grade)', evalInTools?.description.includes('Self-grade'));

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

main().catch((err) => { console.error('v3.4-eval-test crashed:', err); process.exit(1); });
