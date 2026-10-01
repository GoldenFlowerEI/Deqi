/**
 * run-all.mjs — the harness test runner.
 *
 * Why this file replaces the hand-maintained `all` script
 * -------------------------------------------------------
 * The old script was a single `;`-chained command line:
 *
 *     "all": "bun run test.ts ; bun run tools-test.ts ; ..."
 *
 * Two defects came out of that:
 *
 *   1. `;` ignores exit codes, so the script reported success even when
 *      every test in it failed. A green `npm test` meant nothing.
 *   2. The file list was hand-maintained. When tests were added, nobody
 *      edited this line, so they were never run. At the audit there were
 *      52 test files on disk and 22 in this list — 30 orphans, including
 *      every v3.x–v5.x suite. Nobody noticed, because the runner couldn't
 *      report failure.
 *
 * This runner fixes both:
 *   - tests are DISCOVERED from the filesystem, so a new test file is
 *     picked up by `git add` alone;
 *   - each test runs in its own process with a real timeout, and the
 *     process exits non-zero if anything failed.
 *
 * Usage:
 *   node run-all.mjs                 # offline tier (the CI gate)
 *   node run-all.mjs --all           # offline + network tier
 *   node run-all.mjs --only v5.0     # run files whose name contains "v5.0"
 *   node run-all.mjs --list          # print the resolved test list, run nothing
 *
 * Tiers
 * -----
 *   offline  — hermetic. No network, no API key, no LLM. This is the gate.
 *   network  — needs a real provider key (ANTHROPIC/OPENAI/MINIMAX/...)
 *              or binds a port. Skipped unless --all is passed, because
 *              a test that needs a key is not a regression signal.
 *
 * A file is classified by the table below. Anything not listed is treated
 * as offline, which is the safe default: a new test must prove it needs
 * the network before it gets an exemption.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..');

// Node warns (DEP0190) that passing args with `shell: true` is
// unescaped. On Windows `bun` is an npm shim (`bun.cmd`), so spawning
// it without a shell does not work. Every argument we pass is
// constructed here from a discovered filename — no user input reaches
// this spawn — so the warning describes a risk we do not have. Swallow
// it so real warnings stay visible.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'DeprecationWarning' && w.code === 'DEP0190') return;
  console.warn(w.stack ?? String(w));
});

/** Files that need a real provider key, a live network, or a bound port. */
const NETWORK_TIER = new Set([
  'server-real-llm.ts',
  'integration-demo.ts',
  'v3.4-bench-demo.ts',
  'v3.7-demo.ts',
  // Needs a deqi-server already listening on 127.0.0.1:7700 — it drives
  // a live session rather than spawning its own.
  'v3.7-live-run.ts',
  'real-tasks/fix-bug.ts',
  'real-tasks/refactor.ts',
  'real-tasks/add-feature.ts',
]);

/** Files that are not tests (demos, fixtures) even though the name matches. */
const NOT_A_TEST = new Set([
  // Shared driver for real-tasks/*.ts — imported, not executed standalone.
  'real-tasks/driver.ts',
  // This runner.
  'run-all.mjs',
]);

/**
 * Test files whose names do not follow the *-test / *-smoke / *-demo /
 * test.ts convention. They are picked up explicitly so discovery stays
 * exhaustive — a test that nobody runs is indistinguishable from no
 * test at all, which is how 30 suites went missing before.
 *
 * `node run-all.mjs --list` prints the resolved set; compare it against
 * `git status` after adding a test file to make sure the new one is in.
 */
const EXTRA_TESTS = new Set([
  'v2.1-unit.ts',
  'v2.2-unit.ts',
  'v2.2-component.ts',
  'v2.2-plugins-unit.ts',
  'server-real-llm.ts',
  'v3.7-live-run.ts',
]);

/** Per-file timeout in seconds. Slow suites get more headroom. */
const TIMEOUT_S = 180;

function isTestFile(relPath) {
  if (NOT_A_TEST.has(relPath)) return false;
  if (EXTRA_TESTS.has(relPath)) return true;
  const name = relPath.split('/').pop();
  return (
    /-test\.ts$/.test(name) ||
    /-smoke\.ts$/.test(name) ||
    /-demo\.ts$/.test(name) ||
    /^test\.ts$/.test(name)
  );
}

/** Recursively collect candidate test files, skipping build output. */
function discover(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      discover(full, out);
    } else if (e.isFile() && e.name.endsWith('.ts')) {
      const rel = relative(HERE, full).split('\\').join('/');
      if (isTestFile(rel)) out.push(rel);
    }
  }
  return out;
}

function parseArgs(argv) {
  const opts = { all: false, only: null, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--only') opts.only = argv[++i] ?? null;
  }
  return opts;
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bun', ['run', join(HERE, file)], {
      cwd: HERE,
      env: { ...process.env, DEQI_TEST_CHILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    let out = '';
    const cap = 200_000;
    child.stdout.on('data', (d) => { if (out.length < cap) out += d; });
    child.stderr.on('data', (d) => { if (out.length < cap) out += d; });
    const timer = setTimeout(() => {
      out += `\n[timed out after ${TIMEOUT_S}s]`;
      child.kill();
    }, TIMEOUT_S * 1000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, code: code ?? -1, ms: Date.now() - started, out });
    });
  });
}

/**
 * Pull the pass/fail counts a suite printed, for the summary table.
 *
 * The suites predate any shared reporter and print one of two shapes:
 *   `passed: 25    failed: 0`      (newer)
 *   `[ok] name` / `[FAIL] name`     (older)
 * Handle both, and return null when a suite printed neither rather than
 * reporting a misleading zero.
 */
function extractCounts(out) {
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  const passed = [...plain.matchAll(/passed:\s*(\d+)/gi)].map((m) => Number(m[1]));
  const failed = [...plain.matchAll(/failed:\s*(\d+)/gi)].map((m) => Number(m[1]));
  if (passed.length || failed.length) {
    return {
      passed: passed.length ? Math.max(...passed) : null,
      failed: failed.length ? Math.max(...failed) : null,
    };
  }
  const oks = (plain.match(/\[\s*ok\s*\]/gi) || []).length;
  const bads = (plain.match(/\[\s*(FAIL|✗|not ok)\s*\]/gi) || []).length;
  if (oks || bads) return { passed: oks, failed: bads };
  return { passed: null, failed: null };
}

function pad(s, n) {
  // ANSI-aware: pad on the visible length.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, n - visible.length));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const all = discover(HERE).sort();
  if (all.length === 0) {
    console.error('no test files discovered — refusing to report success');
    process.exit(1);
  }

  let selected = all;
  if (opts.only) {
    selected = all.filter((f) => f.includes(opts.only));
    if (selected.length === 0) {
      console.error(`no test file matches --only ${opts.only}`);
      process.exit(1);
    }
  }
  const skipped = selected.filter((f) => NETWORK_TIER.has(f) && !opts.all);
  const toRun = selected.filter((f) => !(NETWORK_TIER.has(f) && !opts.all));

  if (opts.list) {
    for (const f of toRun) console.log(`run    ${f}`);
    for (const f of skipped) console.log(`skip   ${f}  (network tier; use --all)`);
    console.log(`\n${toRun.length} run, ${skipped.length} skipped, ${all.length} discovered`);
    return;
  }

  console.log(`\x1b[1mDeqi harness suite\x1b[0m — ${toRun.length} tests, offline tier`);
  if (skipped.length) {
    console.log(`\x1b[2mskipping ${skipped.length} network-tier test(s): ${skipped.join(', ')}\x1b[0m\n`);
  }

  const results = [];
  let idx = 0;
  for (const file of toRun) {
    idx += 1;
    process.stdout.write(`\x1b[2m[${String(idx).padStart(2, ' ')}/${toRun.length}]\x1b[0m ${file} … `);
    const r = await runOne(file);
    r.counts = extractCounts(r.out);
    results.push(r);
    const good = r.code === 0;
    process.stdout.write(good ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m');
    process.stdout.write(` \x1b[2m(${(r.ms / 1000).toFixed(1)}s)\x1b[0m\n`);
    if (!good) {
      // Echo the tail so the failure is diagnosable without re-running.
      const tail = r.out.split('\n').filter((l) => l.trim()).slice(-14);
      for (const l of tail) console.log(`      \x1b[31m│\x1b[0m ${l.replace(/\x1b\[[0-9;]*m/g, '')}`);
    }
  }

  const failed = results.filter((r) => r.code !== 0);
  const counts = results.map((r) => r.counts.passed).filter((n) => n != null);
  const totalAssert = counts.reduce((a, b) => a + b, 0);
  const noCounts = results.filter((r) => r.counts.passed == null).map((r) => r.file);

  console.log(`\n\x1b[1m── summary ──\x1b[0m`);
  console.log(`  discovered : ${all.length}`);
  console.log(`  run        : ${results.length}`);
  console.log(`  skipped    : ${skipped.length} (network tier)`);
  console.log(`  passed     : ${results.length - failed.length}`);
  console.log(`  failed     : ${failed.length}`);
  console.log(`  assertions : ${totalAssert}${noCounts.length ? ` (${results.length - noCounts.length}/${results.length} suites report counts)` : ''}`);
  console.log(`  duration   : ${(results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)}s`);

  if (failed.length) {
    console.log(`\n\x1b[1m\x1b[31m${failed.length} suite(s) failed:\x1b[0m`);
    for (const f of failed) console.log(`  - ${f.file} (exit ${f.code})`);
    console.log(`\n\x1b[31mHARNESS SUITE FAILED\x1b[0m`);
    process.exit(1);
  }
  console.log(`\n\x1b[32m\x1b[1mHARNESS SUITE PASSED\x1b[0m (${all.length} test files on disk)`);
}

main().catch((e) => {
  console.error('run-all crashed:', e);
  process.exit(1);
});
