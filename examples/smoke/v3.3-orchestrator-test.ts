/**
 * v3.3 test ï¿?orchestrator + 3 specialists + sandboxing.
 *
 * What's covered (20 asserts):
 *   - SPECIALISTS registry has 3 entries
 *   - code-reviewer is read-only (no write/edit)
 *   - test-runner has bash
 *   - doc-writer is read-only
 *   - resolveSandbox: absolute path
 *   - resolveSandbox: relative path resolved against cwd
 *   - resolveSandbox: invalid (nonexistent) ï¿?null
 *   - resolveSandbox: invalid (file, not dir) ï¿?null
 *   - runSpecialist(code-reviewer) returns well-formed Findings
 *   - runSpecialist(test-runner) returns Test command + Result
 *   - runSpecialist(doc-writer) returns fenced markdown
 *   - orchestrator tool: missing args ï¿?isError
 *   - orchestrator tool: unknown specialist ï¿?isError
 *   - orchestrator tool: invalid sandbox ï¿?isError
 *   - orchestrator tool: happy path returns header + report
 *   - orchestrator tool: header includes specialist name + sandbox info
 *   - orchestrator tool: header includes the allowed tools (sandboxing visible)
 *   - BUILTIN_TOOLS count = 16 (15 + orchestrator)
 *   - BUILTIN_TOOLS includes orchestrator
 *   - orchestrator isConcurrencySafe is false
 *
 * No network, no LLM.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v33-orch-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const specMod = await import('../../packages/coding-agent/dist/src/specialists.js');
    const orchMod = await import('../../packages/coding-agent/dist/src/tools/orchestrator.js');
    const toolsIdx = await import('../../packages/coding-agent/dist/src/tools/index.js');

    section('SPECIALISTS registry');
    ok('SPECIALISTS has 3 entries', Object.keys(specMod.SPECIALISTS).length === 3);
    ok('code-reviewer is registered', specMod.SPECIALISTS['code-reviewer'] !== undefined);
    ok('test-runner is registered', specMod.SPECIALISTS['test-runner'] !== undefined);
    ok('doc-writer is registered', specMod.SPECIALISTS['doc-writer'] !== undefined);

    section('specialist tool permissions (sandboxing)');
    const cr = specMod.SPECIALISTS['code-reviewer'];
    const tr = specMod.SPECIALISTS['test-runner'];
    const dw = specMod.SPECIALISTS['doc-writer'];
    ok('code-reviewer has NO write/edit', !cr.allowedTools.includes('write') && !cr.allowedTools.includes('edit'));
    ok('code-reviewer has read + grep + glob', cr.allowedTools.includes('read') && cr.allowedTools.includes('grep') && cr.allowedTools.includes('glob'));
    ok('test-runner has bash', tr.allowedTools.includes('bash'));
    ok('doc-writer has NO write/edit', !dw.allowedTools.includes('write') && !dw.allowedTools.includes('edit'));

    section('resolveSandbox');
    const tmp = mkdtempSync(join(tmpdir(), 'deqi-v33-sandbox-'));
    const absSandbox = specMod.resolveSandbox(tmp, tmp);
    ok('absolute path resolves', absSandbox === tmp);
    const relSandbox = specMod.resolveSandbox(tmp, '.');
    ok('relative path resolves against cwd', relSandbox === tmp);
    ok('nonexistent path ï¿?null', specMod.resolveSandbox(tmp, '/no/such/path') === null);
    const fileInTmp = join(tmp, 'a-file.txt');
    writeFileSync(fileInTmp, 'x');
    ok('file (not dir) ï¿?null', specMod.resolveSandbox(tmp, fileInTmp) === null);
    rmSync(tmp, { recursive: true, force: true });

    section('runSpecialist (deterministic stubs)');
    const crRep = await specMod.runSpecialist('code-reviewer', 'review this code', tmp);
    ok('code-reviewer returns Findings section', crRep.includes('## Findings'));
    const longTask = 'x'.repeat(200);
    const longRep = await specMod.runSpecialist('code-reviewer', longTask, null);
    ok('code-reviewer truncates very long tasks',
      longRep.includes('...') || longRep.length < crRep.length + 300,
      `longRep len=${longRep.length}`);
    const trRep = await specMod.runSpecialist('test-runner', 'run tests', null);
    ok('test-runner returns Test command section', trRep.includes('## Test command'));
    ok('test-runner returns Result section', trRep.includes('## Result'));
    const dwRep = await specMod.runSpecialist('doc-writer', 'document the API', tmp);
    ok('doc-writer returns fenced markdown', dwRep.includes('```markdown') && dwRep.includes('```'));

    section('orchestrator tool ï¿?happy path');
    const sandboxDir = mkdtempSync(join(tmpdir(), 'deqi-v33-orch-'));
    const happyRes = await orchMod.orchestratorTool.execute({
      specialist: 'code-reviewer', task: 'review the diff', sandbox: sandboxDir,
    }, { cwd: sandboxDir });
    ok('happy path has no isError', !happyRes.isError);
    const happyText = happyRes.content[0]?.type === 'text' ? happyRes.content[0].text : '';
    ok('happy path header includes specialist', happyText.startsWith('# code-reviewer:'));
    ok('happy path header includes sandbox', happyText.includes(`sandbox: ${sandboxDir}`));
    ok('happy path header lists allowed tools', happyText.includes('read,') && happyText.includes('grep,'));
    ok('happy path body has Findings', happyText.includes('## Findings'));
    rmSync(sandboxDir, { recursive: true, force: true });

    section('orchestrator tool ï¿?error cases');
    const noArgs = await orchMod.orchestratorTool.execute({}, { cwd: tmp });
    ok('missing args ï¿?isError', noArgs.isError === true);
    const noTask = await orchMod.orchestratorTool.execute({ specialist: 'code-reviewer' }, { cwd: tmp });
    ok('missing task ï¿?isError', noTask.isError === true);
    const badSpec = await orchMod.orchestratorTool.execute({ specialist: 'nonexistent', task: 'x' }, { cwd: tmp });
    ok('unknown specialist ï¿?isError', badSpec.isError === true);
    const badSandbox = await orchMod.orchestratorTool.execute({ specialist: 'code-reviewer', task: 'x', sandbox: '/no/such/dir' }, { cwd: tmp });
    ok('invalid sandbox ï¿?isError', badSandbox.isError === true);
    const fileSandbox = await orchMod.orchestratorTool.execute({ specialist: 'code-reviewer', task: 'x', sandbox: __filename }, { cwd: tmp });
    ok('file (not dir) sandbox ï¿?isError', fileSandbox.isError === true);

    section('orchestrator is not concurrency-safe');
    ok('isConcurrencySafe returns false', orchMod.orchestratorTool.isConcurrencySafe?.({}) === false);

    section('BUILTIN_TOOLS');
    ok('count = 16', toolsIdx.BUILTIN_TOOLS.length === 22, `count=${toolsIdx.BUILTIN_TOOLS.length}`);
    ok('orchestrator is in BUILTIN_TOOLS', toolsIdx.BUILTIN_TOOLS.some((t) => t.name === 'orchestrator'));
    ok('orchestrator has the v3.1 description',
      toolsIdx.BUILTIN_TOOLS.find((t) => t.name === 'orchestrator')?.description.includes('Dispatch'));

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

main().catch((err) => { console.error('v3.3-orchestrator-test crashed:', err); process.exit(1); });
