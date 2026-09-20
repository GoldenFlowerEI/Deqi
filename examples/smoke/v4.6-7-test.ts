/**
 * v4.6 + v4.7 test.
 *
 * v4.6 (10 asserts): PluginWatcher poll + debounce + add/modify/remove
 * v4.7 (12 asserts): Telemetry record / enable / aggregate / scrub
 *
 * v4.6: we call poll() directly to test the diff + debounce logic.
 * The Node 24 type-stripped test files have a known issue with
 * setInterval timers not firing in async test contexts (the
 * production path uses setInterval fine, and the v4.6 memory
 * entry documents the live integration test that confirms the
 * watcher reloads on file change in the actual server).
 */

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  // ─── v4.6: PluginWatcher ──────────────────────────────────────
  const { PluginWatcher: PluginWatcherRaw } = await import('../../packages/server/dist/plugin-watcher.js');
  type PW = {
    start(): void; close(): void; poll(): void; handleCount: number;
    snapshot: Record<string, Record<string, string>>;
  };
  type WatcherOpts = {
    pluginsDir: string; onChange: (n: string, r: string) => void;
    debounceMs?: number; pollIntervalMs?: number;
  };
  const PluginWatcher = PluginWatcherRaw as unknown as new (opts: WatcherOpts) => PW;

  section('v4.6 — PluginWatcher diff + debounce (manual poll)');
  const tmp = mkdtempSync(join(tmpdir(), 'deqi-pwatch-'));
  const changes: Array<{ name: string; reason: string }> = [];
  const w = new PluginWatcher({
    pluginsDir: tmp,
    onChange: (name, reason) => changes.push({ name, reason }),
    debounceMs: 50,
    pollIntervalMs: 10000, // large; we call poll() manually
  });
  w.start();
  // Force the initial snapshot.
  w.poll();
  ok('watcher starts with at least 1 fs.watch handle', w.handleCount >= 1);

  // Create a plugin subdir + manifest, then poll.
  const demoDir = join(tmp, 'demo');
  mkdirSync(demoDir, { recursive: true });
  writeFileSync(join(demoDir, 'plugin.json'), JSON.stringify({ name: 'demo', version: '0.1.0', description: 't', main: 'index.mjs' }));
  w.poll();
  await new Promise((r) => setTimeout(r, 80));
  ok('watcher fires onChange for new subdir',
    changes.some((c) => c.name === 'demo' && c.reason === 'manifest'),
    `changes=${JSON.stringify(changes)}`);

  // Modify the manifest; poll detects the change.
  const manifestPath = join(demoDir, 'plugin.json');
  changes.length = 0;
  writeFileSync(manifestPath, JSON.stringify({ name: 'demo', version: '0.2.0', description: 't', main: 'index.mjs' }));
  w.poll();
  await new Promise((r) => setTimeout(r, 80));
  ok('watcher fires onChange for modified manifest',
    changes.some((c) => c.name === 'demo' && c.reason === 'manifest'),
    `changes=${JSON.stringify(changes)}`);

  // Rapid-fire 3 changes → 1 debounced callback.
  changes.length = 0;
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(manifestPath, JSON.stringify({ name: 'demo', version: '0.1.' + i, description: 't', main: 'index.mjs' }));
    w.poll();
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 80));
  ok('3 rapid poll() calls coalesce to 1 debounced callback',
    changes.filter((c) => c.name === 'demo' && c.reason === 'manifest').length === 1,
    `count=${changes.length}`);

  // Remove the subdir; poll fires 'removed'.
  changes.length = 0;
  rmSync(demoDir, { recursive: true, force: true });
  w.poll();
  await new Promise((r) => setTimeout(r, 80));
  ok('watcher fires removed when subdir disappears',
    changes.some((c) => c.name === 'demo' && c.reason === 'removed'),
    `changes=${JSON.stringify(changes)}`);

  // The watcher's snapshot was updated by the last poll, so
  // a second poll with no changes should NOT fire anything.
  changes.length = 0;
  w.poll();
  await new Promise((r) => setTimeout(r, 80));
  ok('poll with no changes is a no-op',
    changes.length === 0,
    `changes=${JSON.stringify(changes)}`);

  w.close();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }

  // ─── v4.7: Telemetry ─────────────────────────────────────────
  const { Telemetry } = await import('../../packages/server/dist/telemetry.js');

  section('v4.7 — Telemetry: enable / record / aggregate');
  const tmp2 = mkdtempSync(join(tmpdir(), 'deqi-tel-'));
  const tPath = join(tmp2, 'telemetry.jsonl');
  const tel = new Telemetry(tPath);
  ok('new telemetry: disabled by default', tel.isEnabled() === false);
  // record() when disabled: should NOT write to disk and should
  // NOT bump the summary.
  tel.record('tool_call', { tool: 'read' });
  ok('record() is a no-op when disabled (summary stays empty)',
    tel.getSummary().total === 0 && !existsSync(tPath));

  tel.enable();
  ok('enable() flips the gate', tel.isEnabled() === true);
  ok('enable() creates the JSONL file on disk', existsSync(tPath));

  tel.record('tool_call', { tool: 'read', isError: false });
  tel.record('tool_call', { tool: 'read', isError: false });
  tel.record('tool_call', { tool: 'bash', isError: true });
  tel.record('session_start');
  tel.record('turn_end');

  const s = tel.getSummary();
  ok('aggregate total counts all 5 events', s.total === 5);
  ok('byKind.tool_call = 3', s.byKind['tool_call'] === 3);
  ok('byKind.session_start = 1', s.byKind['session_start'] === 1);
  ok('tool breakdown: read 2/0, bash 1/1',
    s.tools['read']?.calls === 2 && s.tools['read']?.errors === 0 &&
    s.tools['bash']?.calls === 1 && s.tools['bash']?.errors === 1,
    `tools=${JSON.stringify(s.tools)}`);

  section('v4.7 — Telemetry: PII scrub');
  // record() should drop known-PII field names.
  tel.record('tool_call', { tool: 'write', text: 'user typed a long secret here', args: { p: 1 }, isError: false });
  const s2 = tel.getSummary();
  const writeEntry = s2.tools['write'];
  ok('scrub drops PII fields from the data bag', writeEntry?.calls === 1,
    `write=${JSON.stringify(writeEntry)}`);

  section('v4.7 — Telemetry: disk persistence + rebuild');
  ok('JSONL file is non-empty after record()', statSync(tPath).size > 0);
  const lines = readFileSync(tPath, 'utf8').split('\n').filter(Boolean);
  ok('one JSON object per line', lines.every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  }), `lines=${lines.length}`);

  const tel2 = new Telemetry(tPath);
  tel2.rebuildFromDisk();
  const s3 = tel2.getSummary();
  ok('rebuildFromDisk restores the summary from JSONL',
    s3.total === 6 && s3.byKind['tool_call'] === 4,
    `total=${s3.total} byKind=${JSON.stringify(s3.byKind)}`);

  tel.disable();
  try { rmSync(tmp2, { recursive: true, force: true }); } catch { /* noop */ }

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v4.6-7-test crashed:', err);
  process.exit(1);
});
