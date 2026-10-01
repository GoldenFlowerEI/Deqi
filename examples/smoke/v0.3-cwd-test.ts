/**
 * v0.3-cwd-test.ts — proves the server works on the user's project.
 *
 * Why this file exists
 * --------------------
 * Eight server call sites used `process.cwd()`. That is the directory
 * the server *binary* was launched from, which has no relationship to
 * the project the user picked in the desktop. The consequences:
 *
 *   - a session created for D:\projects\api was filed under the
 *     server's own directory;
 *   - GET /v1/sessions/:id returned 404 for any session whose project
 *     differed from the launch directory;
 *   - and worst, an interactive turn ran the agent with the wrong cwd,
 *     so `read`, `write`, `edit` and `bash` all operated on a tree the
 *     user never selected.
 *
 * The rule this test locks in: a session's working directory comes
 * from the session itself. `process.cwd()` is only a last resort for a
 * session that does not exist yet and a request that names no project.
 *
 * The test deliberately runs the HTTP server from a *different*
 * directory than the project, which is the only way to catch this.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DeqiServer } from '../../packages/server/dist/server.js';
import { SessionManager } from '../../packages/coding-agent/dist/src/index.js';

let passCount = 0;
let failCount = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passCount += 1;
    console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

async function readBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const realCwd = process.cwd();
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v03-cwd-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  // The "server launch directory" — deliberately NOT the project.
  const launchDir = mkdtempSync(join(tmpdir(), 'deqi-v03-cwd-launch-'));
  // Two separate projects, so we can prove sessions do not cross over.
  const projectA = mkdtempSync(join(tmpdir(), 'deqi-v03-cwd-a-'));
  const projectB = mkdtempSync(join(tmpdir(), 'deqi-v03-cwd-b-'));
  writeFileSync(join(projectA, 'MARKER_A.txt'), 'this is project A\n', 'utf8');
  writeFileSync(join(projectB, 'MARKER_B.txt'), 'this is project B\n', 'utf8');
  mkdirSync(join(projectA, 'src'), { recursive: true });

  // Point the server's working directory at the launch dir, not a project.
  process.chdir(launchDir);

  const { createServer } = await import('node:net');
  const freePort: number = await new Promise((resolveP) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolveP(p));
    });
  });

  const server = new DeqiServer({ port: freePort });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;

  try {
    section('create a session against an explicit project');
    const created = await readBody<{ session: { id: string; cwd: string } }>(
      await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: projectA }),
      }),
    );
    const idA = created.session.id;
    ok('create returned an id', typeof idA === 'string' && idA.length > 0, idA);
    ok('the reported cwd is the requested project, not the launch dir',
      created.session.cwd === projectA, `got ${created.session.cwd}`);
    ok('the reported cwd is not the JSONL file path',
      !created.session.cwd.endsWith('.jsonl'), created.session.cwd);
    ok('the reported cwd is not the server launch directory',
      created.session.cwd !== launchDir, created.session.cwd);

    section('create a second session against a different project');
    const createdB = await readBody<{ session: { id: string; cwd: string } }>(
      await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: projectB }),
      }),
    );
    const idB = createdB.session.id;
    ok('project B session has its own cwd', createdB.session.cwd === projectB, createdB.session.cwd);
    ok('the two sessions are distinct', idA !== idB);

    section('fetch each session from the server, which is running elsewhere');
    const gotA = await fetch(`${base}/v1/sessions/${idA}`);
    ok('GET project A session is 200 (not 404)', gotA.status === 200, `status ${gotA.status}`);
    const bodyA = await readBody<{ session: { cwd: string } }>(gotA);
    ok('project A session reports cwd = A', bodyA.session.cwd === projectA, bodyA.session.cwd);

    const gotB = await fetch(`${base}/v1/sessions/${idB}`);
    ok('GET project B session is 200 (not 404)', gotB.status === 200, `status ${gotB.status}`);
    const bodyB = await readBody<{ session: { cwd: string } }>(gotB);
    ok('project B session reports cwd = B', bodyB.session.cwd === projectB, bodyB.session.cwd);

    section('session messages resolve across projects');
    const msgsA = await fetch(`${base}/v1/sessions/${idA}/messages`);
    ok('GET messages for A is 200', msgsA.status === 200, `status ${msgsA.status}`);
    const msgsB = await fetch(`${base}/v1/sessions/${idB}/messages`);
    ok('GET messages for B is 200', msgsB.status === 200, `status ${msgsB.status}`);

    section('the sessions landed on disk under their own projects');
    const listA = await SessionManager.list(projectA);
    const listB = await SessionManager.list(projectB);
    ok('project A holds exactly one session', listA.length === 1, `got ${listA.length}`);
    ok('project B holds exactly one session', listB.length === 1, `got ${listB.length}`);
    ok('project A session records cwd A', listA[0]?.header.cwd === projectA, listA[0]?.header.cwd);
    ok('project B session records cwd B', listB[0]?.header.cwd === projectB, listB[0]?.header.cwd);
    const listLaunch = await SessionManager.list(launchDir);
    ok('the server launch directory holds no sessions', listLaunch.length === 0,
      `${listLaunch.length} stray session(s)`);

    section('listAll() finds sessions regardless of project');
    const all = await SessionManager.listAll();
    ok('listAll() returns both sessions', all.length === 2, `got ${all.length}`);
    ok('listAll() recovers each project from the header, not the folder name',
      all.some((s) => s.header.cwd === projectA) && all.some((s) => s.header.cwd === projectB));

    section('cwdFor(id) resolves the project for a runner');
    const cwdA = await SessionManager.cwdFor(idA);
    const cwdB = await SessionManager.cwdFor(idB);
    ok('cwdFor(session A) = project A', cwdA === projectA, String(cwdA));
    ok('cwdFor(session B) = project B', cwdB === projectB, String(cwdB));
    ok('cwdFor(a bogus id) is null', (await SessionManager.cwdFor('nope_not_a_session')) === null);

    section('a bad cwd falls back instead of binding to a non-existent path');
    const bad = await readBody<{ session: { cwd: string } }>(
      await fetch(`${base}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: join(projectA, 'does', 'not', 'exist') }),
      }),
    );
    ok('a non-existent cwd is not echoed back verbatim',
      bad.session.cwd !== join(projectA, 'does', 'not', 'exist'), bad.session.cwd);
    ok('it falls back to a real directory that exists', existsSync(bad.session.cwd), bad.session.cwd);
  } finally {
    try { await server.stop(); } catch { /* ignore */ }
    process.chdir(realCwd);
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    for (const d of [tmpHome, launchDir, projectA, projectB]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[31mv0.3-cwd-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mv0.3-cwd-test PASSED\x1b[0m');
}

main().catch((err) => {
  console.error('v0.3-cwd-test crashed:', err);
  process.exit(1);
}).finally(() => {
  // The HTTP server holds the event loop open; without an explicit
  // exit the process would hang here after printing a green summary.
  process.exit(process.exitCode ?? 0);
});
