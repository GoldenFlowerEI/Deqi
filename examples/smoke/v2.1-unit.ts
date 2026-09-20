/**
 * v2.1 unit tests: deqi desktop lib (api.ts + types).
 *
 * The desktop app is a thin React client. The non-trivial
 * logic lives in `packages/desktop/src/lib/api.ts` (the
 * DeqiApi REST client) and the wire types in `types.ts`.
 *
 * These tests mock `fetch` and assert:
 *   1. Every method hits the right URL with the right method
 *   2. Query parameters are URL-encoded (spaces, slashes, etc.)
 *   3. Request bodies are JSON-stringified when present
 *   4. Non-2xx responses throw with status + path in the message
 *   5. 2xx responses are JSON-parsed into the declared return type
 *
 * We don't need a live deqi-server for any of this — pure
 * fetch-mock logic, fast (< 1s), runs in CI.
 */

import { DeqiApi } from '../../packages/desktop/src/lib/api';
import type {
  SearchResponse,
  ScheduleItem,
  FileNode,
  MobilePair,
} from '../../packages/desktop/src/lib/types';

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

interface MockCall {
  url: string;
  init?: RequestInit;
}

function makeFetchMock(responses: Array<{ match: (u: string, i?: RequestInit) => boolean; status: number; body: unknown }>) {
  const calls: MockCall[] = [];
  const fn = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    for (const r of responses) {
      if (r.match(url, init)) {
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('{"error":"no_match_in_mock"}', { status: 599, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

function lastCall(calls: MockCall[]): MockCall {
  if (calls.length === 0) throw new Error('no calls');
  return calls[calls.length - 1];
}

async function main(): Promise<void> {
  // ── search() ──────────────────────────────────────────────
  section('search()');

  {
    const { fn, calls } = makeFetchMock([
      { match: (u) => u.endsWith('/v1/search?q=auth.ts&limit=10'), status: 200, body: { results: [], query: 'auth.ts', total: 0 } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const r = await api.search('auth.ts', 10);
      ok('search returns parsed body', r.results.length === 0 && r.query === 'auth.ts');
      const lc = lastCall(calls);
      ok('search hits /v1/search', lc.url === 'http://127.0.0.1:7700/v1/search?q=auth.ts&limit=10', lc.url);
      ok('search uses GET', (lc.init?.method ?? 'GET') === 'GET');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // URL encoding: spaces, slashes, ampersands
  {
    const { fn, calls } = makeFetchMock([
      { match: () => true, status: 200, body: { results: [], query: 'a b/c&d', total: 0 } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      await api.search('a b/c&d', 20);
      const lc = lastCall(calls);
      ok('search URL-encodes spaces/slashes/&', lc.url.includes('a%20b%2Fc%26d') || lc.url.includes('a+b%2Fc%26d') || lc.url.includes('a%20b/c%26d'),
        lc.url);
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // ── schedule CRUD ─────────────────────────────────────────
  section('schedule CRUD');

  {
    const { fn, calls } = makeFetchMock([
      { match: (u) => u.endsWith('/v1/schedule'), status: 200, body: { items: [] } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const r = await api.listSchedule();
      ok('listSchedule returns {items:[]}', r.items.length === 0);
      ok('listSchedule hits /v1/schedule', lastCall(calls).url.endsWith('/v1/schedule'));
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  {
    const { fn, calls } = makeFetchMock([
      { match: (u, i) => u.endsWith('/v1/schedule') && i?.method === 'POST', status: 201, body: { item: { id: 'sch_abc', name: 'x', prompt: 'y', cadence: '1h', enabled: true, createdAt: '' } } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const r = await api.createSchedule({ name: 'x', prompt: 'y', cadence: '1h' });
      ok('createSchedule returns 201-wrapped item', r.item.id === 'sch_abc');
      const lc = lastCall(calls);
      ok('createSchedule uses POST', lc.init?.method === 'POST');
      ok('createSchedule body is JSON', lc.init?.body === JSON.stringify({ name: 'x', prompt: 'y', cadence: '1h' }));
      ok('createSchedule sets Content-Type', (lc.init?.headers as any)?.['Content-Type'] === 'application/json');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  {
    const { fn, calls } = makeFetchMock([
      { match: (u, i) => i?.method === 'PATCH', status: 200, body: { item: { id: 'sch_x', name: 'renamed', prompt: 'p', cadence: 'daily', enabled: true, createdAt: 't' } } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      await api.updateSchedule('sch_x', { name: 'renamed' });
      const lc = lastCall(calls);
      ok('updateSchedule uses PATCH', lc.init?.method === 'PATCH');
      ok('updateSchedule URL has id', lc.url.endsWith('/v1/schedule/sch_x'));
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  {
    const { fn, calls } = makeFetchMock([
      { match: (u, i) => i?.method === 'DELETE' && u.includes('/v1/schedule/sch_del'), status: 200, body: { ok: true, id: 'sch_del' } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const r = await api.deleteSchedule('sch_del');
      ok('deleteSchedule returns ok + id', r.ok && r.id === 'sch_del');
      ok('deleteSchedule uses DELETE', lastCall(calls).init?.method === 'DELETE');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  {
    const { fn, calls } = makeFetchMock([
      { match: (u, i) => i?.method === 'POST' && u.includes('/v1/schedule/sch_run/run'), status: 200, body: { ok: true, item: { id: 'sch_run', name: '', prompt: '', cadence: '5m', enabled: true, createdAt: '' } } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const r = await api.runScheduleNow('sch_run');
      ok('runScheduleNow returns ok', r.ok === true);
      ok('runScheduleNow uses POST /run', lastCall(calls).url.endsWith('/v1/schedule/sch_run/run'));
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // ── files ─────────────────────────────────────────────────
  section('files');

  {
    const tree: FileNode = {
      name: 'root', path: '.', kind: 'dir',
      children: [
        { name: 'src', path: 'src', kind: 'dir', children: [] },
        { name: 'README.md', path: 'README.md', kind: 'file', size: 100 },
      ],
    };
    const { fn, calls } = makeFetchMock([
      { match: (u) => u.includes('/v1/files?'), status: 200, body: { root: 'C:\\proj', path: '.', node: tree } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const r = await api.listFiles('.', 'C:\\proj');
      ok('listFiles returns tree node', r.node.kind === 'dir' && r.node.children?.length === 2);
      const lc = lastCall(calls);
      ok('listFiles URL-encodes root with backslashes', lc.url.includes('root=') && (lc.url.includes('%5C') || lc.url.includes('%5c')),
        lc.url);
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  {
    // default root: no `root` param
    const { fn, calls } = makeFetchMock([
      { match: () => true, status: 200, body: { root: '', path: '.', node: { name: 'x', path: '.', kind: 'dir' } } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      await api.listFiles('src');
      const lc = lastCall(calls);
      ok('listFiles default omits root param', !lc.url.includes('root='), lc.url);
      ok('listFiles includes path param', lc.url.includes('path=src'));
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // ── pair ──────────────────────────────────────────────────
  section('mobile pair');

  {
    const item: MobilePair = {
      id: 'pair_1', code: '29FC-1552-C6A0', deviceName: 'iPhone',
      pairedAt: '2026-09-07T00:00:00Z',
    };
    // Track which call this is, since both GET and POST hit the
    // same /v1/pair path and differ only in method.
    let callCount = 0;
    const { fn, calls } = makeFetchMock([
      { match: (u, i) => { callCount += 1; return i?.method === 'GET' || i?.method === undefined; }, status: 200, body: { items: [] } },
      { match: (u, i) => { callCount += 1; return i?.method === 'POST'; }, status: 201, body: { item, expiresInSec: 600 } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const list = await api.listPairs();
      const created = await api.createPair('iPhone');
      ok('listPairs returns items', list.items.length === 0);
      ok('createPair returns item + expiresInSec', created.item.id === 'pair_1' && created.expiresInSec === 600);
      ok('createPair body has deviceName', JSON.parse(lastCall(calls).init?.body as string).deviceName === 'iPhone');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  {
    const { fn, calls } = makeFetchMock([
      { match: (u, i) => i?.method === 'DELETE' && u.includes('/v1/pair/pair_xyz'), status: 200, body: { ok: true, id: 'pair_xyz' } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      const r = await api.deletePair('pair_xyz');
      ok('deletePair uses DELETE', lastCall(calls).init?.method === 'DELETE');
      ok('deletePair URL has id', lastCall(calls).url.endsWith('/v1/pair/pair_xyz'));
      ok('deletePair returns ok + id', r.ok && r.id === 'pair_xyz');
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // ── error handling ───────────────────────────────────────
  section('error handling');

  {
    const { fn } = makeFetchMock([
      { match: () => true, status: 500, body: { error: 'internal' } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      let caught: Error | null = null;
      try { await api.listSessions(); } catch (e) { caught = e as Error; }
      ok('non-2xx throws Error', caught !== null);
      ok('error message includes status + path', caught?.message.includes('500') && caught?.message.includes('/v1/sessions'),
        caught?.message);
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  {
    // 404 with structured error body
    const { fn } = makeFetchMock([
      { match: (u) => u.includes('/v1/schedule/sch_missing'), status: 404, body: { error: 'not_found' } },
    ]);
    const api = new DeqiApi('http://127.0.0.1:7700');
    const origFetch = globalThis.fetch;
    globalThis.fetch = fn;
    try {
      let caught: Error | null = null;
      try { await api.deleteSchedule('sch_missing'); } catch (e) { caught = e as Error; }
      ok('404 throws with path in message', caught?.message.includes('404') && caught?.message.includes('/v1/schedule/sch_missing'),
        caught?.message);
    } finally {
      globalThis.fetch = origFetch;
    }
  }

  // ── summary ───────────────────────────────────────────────
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
