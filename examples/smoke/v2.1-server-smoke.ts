/**
 * v2.1 smoke test: 5 new server endpoints end-to-end.
 *
 * What's covered:
 *   1. /v1/search        — walks session JSONLs, matches text, ranks,
 *                          returns snippet previews with role pills
 *   2. /v1/schedule CRUD — create / list / patch / delete, plus
 *                          POST /v1/schedule/:id/run
 *   3. /v1/files         — directory walk with depth limit, skips
 *                          node_modules etc., rejects unsafe paths
 *   4. /v1/pair          — 6-char code format, persistence, delete
 *   5. Edge cases         — empty search, missing field, bad cadence,
 *                          unsafe relative path, duplicate delete
 *
 * The server is spawned against a fresh temp HOME with an empty
 * schedule + pairs + no sessions, so the counts we assert are
 * exact (not "at least N"). This makes the failures point at
 * the actual broken behavior, not a stale test artifact.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const SMOKE_DIR = typeof import.meta.dir === 'string' ? import.meta.dir : process.cwd();
const REPO_ROOT = join(SMOKE_DIR, '..', '..');

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

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const addr = listener.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        listener.close(() => resolve(port));
      } else {
        listener.close(() => reject(new Error('no port')));
      }
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not ready */ }
    await sleep(100);
  }
  throw new Error(`server did not become ready on port ${port}`);
}

async function jget<T>(port: number, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function jpost<T>(port: number, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function jpatch<T>(port: number, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function jdelete<T>(port: number, path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE' });
  return { status: res.status, body: (await res.json()) as T };
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'deqi-v21-smoke-'));
  const fakeHome = join(tmpDir, 'home');
  mkdirSync(join(fakeHome, '.deqi', 'sessions', 'C--test'), { recursive: true });

  // Seed two session JSONL files with known content so the
  // search test has something to match against. The directory
  // name must match encodeCwd('/test') = 'test' (SessionManager
  // strips leading slashes).
  mkdirSync(join(fakeHome, '.deqi', 'sessions', 'test'), { recursive: true });
  const sessionA = {
    type: 'session', id: 's_alpha', cwd: '/test', model: 'MiniMax-M3', provider: 'openai-compat',
    createdAt: new Date().toISOString(),
  };
  const sessionB = {
    type: 'session', id: 's_beta', cwd: '/test', model: 'claude-sonnet-4-5', provider: 'openai-compat',
    createdAt: new Date().toISOString(),
  };
  const msgA1 = {
    type: 'message', id: 'm1', parentId: null, role: 'user',
    content: 'Refactor src/auth.ts to use the new SessionStore API',
    ts: new Date().toISOString(),
  };
  const msgA2 = {
    type: 'message', id: 'm2', parentId: 'm1', role: 'assistant',
    content: [{ type: 'text', text: 'Sure, I will rewrite auth.ts using SessionStore.' }],
    ts: new Date().toISOString(),
  };
  const msgB1 = {
    type: 'message', id: 'm3', parentId: null, role: 'user',
    content: 'Fix the SessionStore bug in src/auth.ts',
    ts: new Date().toISOString(),
  };
  writeFileSync(join(fakeHome, '.deqi', 'sessions', 'test', 's_alpha.jsonl'),
    [JSON.stringify(sessionA), JSON.stringify(msgA1), JSON.stringify(msgA2)].join('\n') + '\n', 'utf8');
  writeFileSync(join(fakeHome, '.deqi', 'sessions', 'test', 's_beta.jsonl'),
    [JSON.stringify(sessionB), JSON.stringify(msgB1)].join('\n') + '\n', 'utf8');

  // Seed a fixture directory for /v1/files
  const fixtureDir = join(tmpDir, 'fixture');
  mkdirSync(join(fixtureDir, 'src'), { recursive: true });
  mkdirSync(join(fixtureDir, 'node_modules', 'foo'), { recursive: true });
  writeFileSync(join(fixtureDir, 'README.md'), '# Fixture\n', 'utf8');
  writeFileSync(join(fixtureDir, 'src', 'index.ts'), 'export {};\n', 'utf8');
  writeFileSync(join(fixtureDir, 'node_modules', 'foo', 'index.js'), 'noop();\n', 'utf8');

  const port = await findFreePort();
  const server: ChildProcess = spawn(
    'node',
    [join(REPO_ROOT, 'packages/server/dist/index.js'), '--port', String(port)],
    {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    },
  );
  let serverOut = '';
  server.stdout?.on('data', (b) => { serverOut += b.toString(); });
  server.stderr?.on('data', (b) => { serverOut += b.toString(); });
  process.on('exit', () => {
    if (process.exitCode === 1) {
      console.error('--- server output ---');
      console.error(serverOut);
    }
  });

  try {
    await waitForServer(port);
    ok('server is ready on /health', true, `port=${port}`);

    // ── /v1/search ──────────────────────────────────────────────
    section('search across session JSONLs');

    const empty = await jget<{ results: any[]; total: number; query: string }>(
      port, '/v1/search?q=&limit=10',
    );
    ok('empty q returns empty results', empty.status === 200 && empty.body.results.length === 0 && empty.body.total === 0);

    const findAuth = await jget<{ results: any[]; total: number; query: string }>(
      port, `/v1/search?q=auth.ts&limit=10&cwd=${encodeURIComponent('/test')}`,
    );
    ok('search for "auth.ts" returns 200', findAuth.status === 200);
    ok('search matches both seeded sessions', findAuth.body.results.length === 2, `count=${findAuth.body.results.length}`);
    const sids = findAuth.body.results.map((r) => r.sessionId).sort();
    ok('search hit sessionIds are correct', JSON.stringify(sids) === JSON.stringify(['s_alpha', 's_beta']));

    const aResult = findAuth.body.results.find((r) => r.sessionId === 's_alpha');
    ok('s_alpha has at least one hit', aResult && aResult.hits.length >= 1);
    const firstHit = aResult?.hits[0];
    ok('s_alpha hit role is user or assistant', firstHit?.role === 'user' || firstHit?.role === 'assistant');
    ok('s_alpha hit snippet contains "auth.ts"', firstHit?.snippet?.includes('auth.ts'));

    const rankTest = await jget<{ results: any[]; total: number }>(
      port, `/v1/search?q=SessionStore&limit=10&cwd=${encodeURIComponent('/test')}`,
    );
    ok('search for "SessionStore" returns results', rankTest.body.results.length >= 1);
    // s_alpha has TWO "SessionStore" mentions (in user msg and assistant text),
    // s_beta has ONE. So s_alpha should be ranked first.
    ok('search ranks by hit count (more hits first)',
      rankTest.body.results[0]?.sessionId === 's_alpha',
      `top=${rankTest.body.results[0]?.sessionId}`);

    const limitTest = await jget<{ results: any[] }>(
      port, `/v1/search?q=auth.ts&limit=1&cwd=${encodeURIComponent('/test')}`,
    );
    ok('search respects limit', limitTest.body.results.length === 1);

    const noCwd = await jget<{ results: any[]; total: number }>(
      port, '/v1/search?q=auth.ts&limit=10',
    );
    ok('search with no cwd uses server cwd and returns empty', noCwd.body.results.length === 0,
      `count=${noCwd.body.results.length}`);

    // ── /v1/schedule ───────────────────────────────────────────
    section('schedule CRUD + run-now');

    const emptySched = await jget<{ items: any[] }>(port, '/v1/schedule');
    ok('schedule list starts empty', emptySched.status === 200 && emptySched.body.items.length === 0);

    const createMissing = await jpost(port, '/v1/schedule', { name: 'no cadence' });
    ok('create rejects missing cadence', createMissing.status === 400, `status=${createMissing.status}`);

    const create1 = await jpost<{ item: any }>(port, '/v1/schedule', {
      name: 'Daily brief',
      prompt: 'What changed in AI today?',
      cadence: 'daily',
    });
    ok('create schedule returns 201', create1.status === 201, `status=${create1.status}`);
    ok('create schedule has id', !!create1.body.item.id);
    ok('create schedule defaults enabled=true', create1.body.item.enabled === true);
    const id1 = create1.body.item.id;

    const create2 = await jpost<{ item: any }>(port, '/v1/schedule', {
      name: '5m status check',
      prompt: 'summarize git status',
      cadence: '5m',
      enabled: false,
    });
    const id2 = create2.body.item.id;
    ok('create schedule honors explicit enabled', create2.body.item.enabled === false);

    const listAfter = await jget<{ items: any[] }>(port, '/v1/schedule');
    ok('list shows both schedules', listAfter.body.items.length === 2);

    const patch1 = await jpatch<{ item: any }>(port, `/v1/schedule/${id1}`, {
      name: 'Daily morning brief',
    });
    ok('patch renames schedule', patch1.status === 200 && patch1.body.item.name === 'Daily morning brief');
    ok('patch preserves id and createdAt', patch1.body.item.id === id1 && !!patch1.body.item.createdAt);

    const run1 = await jpost<{ ok: boolean; item: any }>(port, `/v1/schedule/${id1}/run`);
    if (run1.status !== 200 || !run1.body.ok) {
      console.error('   DEBUG run1:', JSON.stringify(run1));
    }
    ok('run-now returns 200 with ok=true', run1.status === 200 && run1.body.ok === true, `status=${run1.status}`);
    ok('run-now sets lastRunAt', !!run1.body?.item?.lastRunAt);
    // v2.2: lastRunStatus is no longer pre-set to 'ok' — it's
    // written by the background runner after the prompt actually
    // completes. The initial response sets lastRunNote='queued'
    // to signal the intent.
    ok('run-now sets lastRunNote=queued (v2.2)', run1.body?.item?.lastRunNote === 'queued');

    const del1 = await jdelete<{ ok: boolean; id: string }>(port, `/v1/schedule/${id1}`);
    ok('delete returns ok + id', del1.status === 200 && del1.body.ok && del1.body.id === id1);

    const delMissing = await jdelete(port, `/v1/schedule/${id1}`);
    ok('double-delete returns 404', delMissing.status === 404);

    const listAfter2 = await jget<{ items: any[] }>(port, '/v1/schedule');
    ok('list after delete shows 1', listAfter2.body.items.length === 1);
    ok('remaining is the other one', listAfter2.body.items[0]?.id === id2);

    // ── /v1/files ──────────────────────────────────────────────
    section('file tree (with skip rules)');

    const filesRoot = await jget<{ root: string; node: any }>(
      port, `/v1/files?path=.`,
    );
    // server defaults to process.cwd() of the server (which is tmpDir),
    // so the root is the tmpDir. We can't assert exact contents
    // (tmpDir has its own scaffolding), but we can assert structure.
    ok('files returns node=dir', filesRoot.status === 200 && filesRoot.body.node.kind === 'dir');

    const filesFixture = await jget<{ root: string; node: any }>(
      port, `/v1/files?path=.&root=${encodeURIComponent(fixtureDir)}`,
    );
    ok('files at fixture root returns 200', filesFixture.status === 200);
    const names = (filesFixture.body.node.children || []).map((c: any) => c.name);
    ok('files lists README.md and src', names.includes('README.md') && names.includes('src'),
      `names=${names.join(',')}`);
    ok('files skips node_modules', !names.includes('node_modules'), `names=${names.join(',')}`);

    const filesSrc = await jget<{ node: any }>(
      port, `/v1/files?path=src&root=${encodeURIComponent(fixtureDir)}`,
    );
    const srcChildren = (filesSrc.body.node.children || []).map((c: any) => c.name);
    ok('files recurses into src/', srcChildren.includes('index.ts'), `children=${srcChildren.join(',')}`);

    const unsafe = await jget(port, `/v1/files?path=..&root=${encodeURIComponent(fixtureDir)}`);
    ok('files rejects unsafe path', unsafe.status === 400, `status=${unsafe.status}`);

    const missing = await jget(port, `/v1/files?path=does-not-exist&root=${encodeURIComponent(fixtureDir)}`);
    ok('files returns 404 for missing path', missing.status === 404, `status=${missing.status}`);

    // ── /v1/pair ───────────────────────────────────────────────
    section('mobile pair (CRUD)');

    const emptyPair = await jget<{ items: any[] }>(port, '/v1/pair');
    ok('pair list starts empty', emptyPair.body.items.length === 0);

    const pairRes = await jpost<{ item: any; expiresInSec: number }>(port, '/v1/pair', { deviceName: 'iPhone' });
    ok('pair create returns 201', pairRes.status === 201);
    ok('pair returns 12-hex code in 3 dash-separated groups', /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(pairRes.body.item.code),
      `code=${pairRes.body.item.code}`);
    ok('pair returns expiresInSec', pairRes.body.expiresInSec === 600);
    const pairId = pairRes.body.item.id;

    const pairList = await jget<{ items: any[] }>(port, '/v1/pair');
    ok('pair list shows the new one', pairList.body.items.length === 1 && pairList.body.items[0]?.id === pairId);

    const pairDel = await jdelete(port, `/v1/pair/${pairId}`);
    ok('pair delete returns ok', pairDel.status === 200);
    ok('pair delete is idempotent (returns 404 on second)', (await jdelete(port, `/v1/pair/${pairId}`)).status === 404);

    const pairListAfter = await jget<{ items: any[] }>(port, '/v1/pair');
    ok('pair list empty after delete', pairListAfter.body.items.length === 0);

    // ── cleanup ────────────────────────────────────────────────
    server.kill();
  } catch (err) {
    console.error('test threw:', err);
    server.kill();
    process.exitCode = 1;
  }

  // ── summary ────────────────────────────────────────────────
  console.log(`\n\x1b[1m── summary ──\x1b[0m`);
  console.log(`  ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
