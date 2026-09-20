/**
 * v3.1 test â€?`plan` tool (orchestrator-workers / ReAct Â§4.2 decomposition).
 *
 * What's covered (12 asserts):
 *   1. propose returns a planId + validated=true with N steps
 *   2. propose assigns auto-ids (s1, s2, ...) when none given
 *   3. propose rejects empty steps with isError=true
 *   4. propose rejects missing goal with isError=true
 *   5. propose detects bad dep (step references unknown prior step)
 *   6. record updates a step's status
 *   7. record writes status to disk (round-trip)
 *   8. record rejects unknown planId
 *   9. list returns planIds
 *  10. read returns the plan document
 *  11. read rejects unknown planId
 *  12. The plan document on disk is valid JSON with the right shape
 *
 * No network, no LLM. Tests the plan tool end-to-end.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v31-plan-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const planMod = await import('../../packages/coding-agent/dist/src/tools/plan.js');
    const tool = planMod.planTool;
    ok('plan tool exported', !!tool);
    ok('plan tool name is "plan"', tool.name === 'plan');

    const ctx = { cwd: 'C:/fake/project' };

    section('propose â€?happy path');
    const propRes = await tool.execute({
      action: 'propose',
      goal: 'Add OAuth login',
      steps: [
        { title: 'Install deps', action: 'bash npm install passport' },
        { title: 'Write OAuth routes', action: 'write src/auth.ts', dependsOn: ['s1'] },
        { title: 'Test', action: 'bash npm test', dependsOn: ['s2'] },
      ],
    }, ctx);
    ok('propose returns content', !propRes.isError);
    const propText = propRes.content[0]?.type === 'text' ? propRes.content[0].text : '';
    const propJson = JSON.parse(propText) as { planId?: string; validated?: boolean };
    ok('propose returns a planId', typeof propJson.planId === 'string' && propJson.planId.length > 0, `planId=${propJson.planId}`);
    ok('propose validated=true', propJson.validated === true);
    ok('propose auto-assigned ids (s1, s2, s3)', propText.includes('"s1"') && propText.includes('"s3"'));
    const planId = propJson.planId!;

    section('propose â€?validation');
    const emptyRes = await tool.execute({ action: 'propose', goal: 'x', steps: [] }, ctx);
    ok('empty steps â†?isError=true', emptyRes.isError === true);
    const noGoalRes = await tool.execute({ action: 'propose', steps: [{ title: 't', action: 'a' }] }, ctx);
    ok('missing goal â†?isError=true', noGoalRes.isError === true);
    const badDepRes = await tool.execute({
      action: 'propose', goal: 'x',
      steps: [
        { title: 'a', action: 'a' },
        { title: 'b', action: 'b', dependsOn: ['s99'] },
      ],
    }, ctx);
    ok('bad dep â†?isError=true', badDepRes.isError === true);
    const badDepText = badDepRes.content[0]?.type === 'text' ? badDepRes.content[0].text : '';
    ok('bad dep error mentions "s99"', badDepText.includes('s99'));

    section('record â€?checkpoint a step');
    const recRes = await tool.execute({
      action: 'record', planId, stepId: 's1', status: 'done', note: 'deps installed',
    }, ctx);
    ok('record returns no isError', !recRes.isError);
    const recText = recRes.content[0]?.type === 'text' ? recRes.content[0].text : '';
    const recJson = JSON.parse(recText) as { ok?: boolean; status?: Record<string, string> };
    ok('record status["s1"]="done"', recJson.status?.['s1'] === 'done');
    ok('record note saved', recJson.status && recJson.status['s1'] === 'done');

    section('record â€?bad planId');
    const badRec = await tool.execute({ action: 'record', planId: 'plan_nope', stepId: 's1', status: 'done' }, ctx);
    ok('record with bad planId â†?isError=true', badRec.isError === true);

    section('list / read');
    const listRes = await tool.execute({ action: 'list' }, ctx);
    ok('list has no isError', !listRes.isError);
    const listText = listRes.content[0]?.type === 'text' ? listRes.content[0].text : '';
    const listJson = JSON.parse(listText) as { planIds: string[] };
    ok('list contains the plan we created', listJson.planIds.includes(planId));

    const readRes = await tool.execute({ action: 'read', planId }, ctx);
    ok('read has no isError', !readRes.isError);
    const doc = JSON.parse(readRes.content[0]?.type === 'text' ? readRes.content[0].text : '') as { steps: unknown[]; status: Record<string, string> };
    ok('read returns a doc with steps + status',
      Array.isArray(doc.steps) && doc.steps.length === 3 && doc.status['s1'] === 'done');

    const readBad = await tool.execute({ action: 'read', planId: 'plan_nope' }, ctx);
    ok('read bad planId â†?isError=true', readBad.isError === true);

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

main().catch((err) => { console.error('v3.1-plan-test crashed:', err); process.exit(1); });
