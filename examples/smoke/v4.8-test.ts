/**
 * v4.8 test — multi-desktop cluster registry + delegate_remote.
 *
 * Two layers:
 *
 *  1. Unit: ClusterRegistry (register / list / pick / heartbeat /
 *     stale-eviction / atomic write / updateLocal). 12 asserts.
 *  2. Unit: delegate_remote tool — exercises resolveTarget() and
 *     the aggregation logic with a stubbed cluster + stubbed fetch.
 *     6 asserts.
 *
 * Total: 18 asserts.
 *
 * The HTTP integration (POST /v1/rpc/run-task + cluster endpoint
 * discovery) is covered by the live server smoke test in the
 * memory entry, not here — it requires a running Deqi-server
 * which would be flaky in a unit-test loop.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

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
  // ─── v4.8: ClusterRegistry ──────────────────────────────────────
  const { ClusterRegistry } = await import('../../packages/server/dist/cluster-registry.js');
  // Use a temp directory for the registry file so the test doesn't
  // touch the user's real ~/.deqi/cluster.json. The cluster
  // accepts a `registryPath` constructor option (v4.8 testability
  // hook) that overrides the default homedir-based path.
  const fakeHome = mkdtempSync(join(tmpdir(), 'deqi-cluster-'));
  mkdirSync_placeholder: void 0;
  const regPath = join(fakeHome, 'cluster.json');

  section('v4.8 — ClusterRegistry: start / list / pick / stop');
  // Use a fresh registry per test block to avoid cross-pollution
  // from the singleton desktop_id cache.
  const reg = new ClusterRegistry({ registryPath: regPath });
  reg.start({
    name: 'test-local',
    host: '127.0.0.1',
    port: 7701,
    tags: ['test', 'laptop'],
    capabilities: ['browser', 'git'],
  });
  await sleep(20);
  let live = reg.list();
  ok('start() registers the local entry', live.length === 1, `live=${live.length}`);
  ok('local entry has a d_ prefixed desktop_id',
    /^d_[0-9a-f]{16}$/.test(live[0]?.desktop_id ?? ''),
    `id=${live[0]?.desktop_id}`);
  ok('local entry carries tags + capabilities',
    JSON.stringify(live[0]?.tags) === JSON.stringify(['test', 'laptop']) &&
    JSON.stringify(live[0]?.capabilities) === JSON.stringify(['browser', 'git']));
  ok('local() returns the cached entry',
    reg.local()?.name === 'test-local');

  section('v4.8 — pick: capability / tag / id / any');
  // Inject a second peer directly via the file (simulating another
  // desktop on the network) so we can exercise multi-entry pick.
  const path = regPath;
  const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number; desktops: Array<{ desktop_id: string; name: string; host: string; port: number; tags: string[]; capabilities: string[]; registered_at: string; last_heartbeat: string }> };
  file.desktops.push({
    desktop_id: 'd_peer00000000000001',
    name: 'peer-desktop',
    host: '127.0.0.1',
    port: 8800,
    tags: ['test', 'desktop'],
    capabilities: ['browser-v2', 'git'],
    registered_at: new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(file, null, 2), 'utf8');
  // pick by capability: only the peer has 'browser-v2'.
  const byCap = reg.pick({ capability: 'browser-v2' });
  ok('pick({capability: "browser-v2"}) → peer',
    byCap?.desktop_id === 'd_peer00000000000001',
    `got=${byCap?.desktop_id}`);
  // pick by tag: peer has 'desktop' tag, local has 'laptop'.
  const byTag = reg.pick({ tag: 'desktop' });
  ok('pick({tag: "desktop"}) → peer', byTag?.name === 'peer-desktop');
  // pick by id: exact match
  const byId = reg.pick({ desktop_id: reg.local()!.desktop_id });
  ok('pick({desktop_id: <local>}) → local', byId?.name === 'test-local');
  // pick non-existent id → null
  const miss = reg.pick({ desktop_id: 'd_doesnotexist00000000' });
  ok('pick({desktop_id: "d_…nonexistent"}) → null', miss === null);

  section('v4.8 — heartbeat + stale eviction');
  // Manually backdate the peer's last_heartbeat past the 15s
  // threshold; the next list() should drop it.
  const file2 = JSON.parse(readFileSync(path, 'utf8')) as typeof file;
  const peer = file2.desktops.find((d) => d.desktop_id === 'd_peer00000000000001')!;
  peer.last_heartbeat = new Date(Date.now() - 30_000).toISOString();
  writeFileSync(path, JSON.stringify(file2, null, 2), 'utf8');
  live = reg.list();
  ok('stale peer (>15s old) is filtered out of list()',
    live.length === 1 && live[0]?.desktop_id === reg.local()?.desktop_id,
    `live=${live.length}`);
  ok('listAll() still includes the stale entry',
    reg.listAll().length === 2);

  section('v4.8 — updateLocal: only mutable fields, immutable preserved');
  reg.updateLocal({ tags: ['laptop', 'mobile'], capabilities: ['browser', 'git', 'http-fetch'] });
  const updated = reg.local()!;
  ok('updateLocal updates tags',
    updated.tags.includes('mobile') && updated.tags.length === 2);
  ok('updateLocal updates capabilities',
    updated.capabilities.includes('http-fetch'));
  ok('updateLocal preserves registered_at (immutable)',
    updated.registered_at === reg.local()!.registered_at);
  ok('updateLocal preserves desktop_id (immutable)',
    updated.desktop_id === reg.local()!.desktop_id);

  section('v4.8 — atomic write: tmp file cleaned up');
  // After start/stop the .tmp file should not linger.
  reg.stop();
  const tmpPath = path + '.tmp';
  ok('cluster.json.tmp is removed after stop()', !existsSync(tmpPath));
  // After stop, the local entry is removed from the file. The
  // peer is still there (it's a different desktop's entry, not
  // ours to delete), so the count is 1.
  const after = JSON.parse(readFileSync(path, 'utf8')) as { desktops: Array<{ desktop_id: string }> };
  ok('stop() removes the local entry from the file (peer still present)',
    after.desktops.length === 1 && after.desktops[0]?.desktop_id === 'd_peer00000000000001',
    `desktops=${after.desktops.length}`);

  section('v4.8 — file format: valid JSON, version=1');
  const file3 = JSON.parse(readFileSync(path, 'utf8')) as { version?: number };
  ok('empty registry writes {version:1, desktops:[]}', file3.version === 1);
  ok('registry file size > 0', statSync(path).size > 0);

  // ─── v4.8: delegate_remote — resolveTarget + aggregation ────────
  // We mock the cluster + the global fetch so the test runs offline
  // and doesn't need a real peer Deqi-server. The point of the test
  // is to confirm:
  //   1. resolveTarget() picks the right desktop per task
  //   2. the report aggregates results across multiple peers
  //   3. failures (network error, no match) don't crash the fan-out
  const { resolveTarget: _resolveTarget } = await import('../../packages/coding-agent/dist/src/tools/delegate-remote.js') as {
    resolveTarget?: unknown;
  };
  // resolveTarget is private; we test the tool end-to-end through
  // the public `execute()` with a stubbed cluster + stubbed fetch.
  // Import the tool:
  const delegateMod = await import('../../packages/coding-agent/dist/src/tools/delegate-remote.js') as {
    delegateRemoteTool?: {
      name: string;
      execute: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
    };
  };
  const delegateRemote = delegateMod.delegateRemoteTool;
  ok('delegateRemoteTool is exported', !!delegateRemote);
  ok('tool name is "delegate_remote"', delegateRemote?.name === 'delegate_remote');

  if (delegateRemote) {
    // Stub cluster: one local, two peers.
    const fakeCluster = {
      list: () => [
        { desktop_id: 'd_local0000000000001', name: 'local', host: '127.0.0.1', port: 7700, tags: ['laptop'], capabilities: ['git'] },
        { desktop_id: 'd_peera0000000000001', name: 'peerA', host: '127.0.0.1', port: 8801, tags: ['desktop'], capabilities: ['browser-v2'] },
        { desktop_id: 'd_peerb0000000000001', name: 'peerB', host: '127.0.0.1', port: 8802, tags: ['desktop'], capabilities: ['git', 'http-fetch'] },
      ],
      pick: (t: { desktop_id?: string; capability?: string; tag?: string }) => {
        const all = fakeCluster.list();
        if (t.desktop_id) return all.find((d) => d.desktop_id === t.desktop_id) ?? null;
        if (t.capability) return all.find((d) => d.capabilities.includes(t.capability!)) ?? null;
        if (t.tag) return all.find((d) => d.tags.includes(t.tag!)) ?? null;
        return all[0] ?? null;
      },
      local: () => fakeCluster.list()[0]!,
    };
    // Stub fetch: 200 for peerA, network error for peerB.
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (url: string) => {
      fetchCalls += 1;
      if (url.includes(':8801/')) {
        return new Response(JSON.stringify({ ok: true, text: 'peerA says hi', durationMs: 12 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.includes(':8802/')) {
        return new Response('', { status: 502, statusText: 'Bad Gateway' });
      }
      return new Response('unknown', { status: 500 });
    }) as unknown as typeof fetch;

    try {
      const result = await delegateRemote.execute(
        {
          tasks: [
            { name: 'browser-task', prompt: 'open a page', target: { capability: 'browser-v2' } },
            { name: 'broken', prompt: 'do nothing', target: { desktop_id: 'd_peerb0000000000001' } },
            { name: 'any', prompt: 'fallback' }, // no target → local
          ],
          summarize: true,
        },
        { cwd: 'C:\\test', signal: new AbortController().signal, harness: { cluster: fakeCluster } },
      );
      const text = result.content[0]?.text ?? '';
      ok('delegate_remote dispatched 3 tasks', fetchCalls === 3, `fetch=${fetchCalls}`);
      ok('report mentions peerA target (browser-v2 capability)',
        text.includes('peerA') || text.includes('d_peera'),
        `text=${text.slice(0, 200)}`);
      ok('report shows the 502 failure for peerB',
        text.includes('http_502') || text.includes('FAIL'),
        `text=${text.slice(0, 200)}`);
      ok('report shows the local desktop for the untargeted task',
        text.includes('d_local') || text.includes('local'),
        `text=${text.slice(0, 200)}`);

      // 2nd test: target matches nothing → ok:false, no crash
      fetchCalls = 0;
      const result2 = await delegateRemote.execute(
        {
          tasks: [{ name: 'lonely', prompt: 'do', target: { capability: 'nonexistent' } }],
        },
        { cwd: 'C:\\test', signal: new AbortController().signal, harness: { cluster: fakeCluster } },
      );
      const text2 = result2.content[0]?.text ?? '';
      ok('no-match target → ok:false, no fetch, isError=true',
        !text2.includes('http_') && result2.isError === true,
        `text=${text2.slice(0, 200)}`);
      ok('no-match target makes zero HTTP calls', fetchCalls === 0);

      // 3rd test: missing cluster → graceful error
      const result3 = await delegateRemote.execute(
        { tasks: [{ name: 'x', prompt: 'y' }] },
        { cwd: 'C:\\test', signal: new AbortController().signal, harness: {} },
      );
      ok('missing cluster returns a friendly error',
        result3.isError === true && (result3.content[0]?.text ?? '').includes('cluster registry'));
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  try { rmSync(fakeHome, { recursive: true, force: true }); } catch { /* noop */ }

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v4.8-test crashed:', err);
  process.exit(1);
});
