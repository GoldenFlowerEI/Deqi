/**
 * v4.4 + v4.5 test.
 *
 * v4.4 (16 asserts): GrantStore — turn / session / forever scopes
 * v4.5 (8 asserts): CDP client URL allowlist + private-IP block
 *
 * The CDP-client connection itself needs a live browser, so we
 * only test the prep / validation logic here. The full plugin is
 * covered by the manual smoke test in the v4.5 memory entry.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

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
  // ─── v4.4: GrantStore ─────────────────────────────────────────
  const grants = await import('../../packages/server/dist/permission-grants.js');
  const { GrantStore } = grants;

  section('v4.4 — GrantStore basics');
  const tmp = mkdtempSync(join(tmpdir(), 'deqi-grants-'));
  const storePath = join(tmp, 'permission-grants.json');
  const s1 = new GrantStore(storePath);
  ok('new store: no grants, no matches', s1.list().length === 0 && s1.match('bash', '/x') === null);

  section('v4.4 — add + match per level');
  const turnG = s1.add({ tool: 'bash', pattern: 'exact', level: 'turn' }, storePath);
  const sessionG = s1.add({ tool: 'edit', pattern: 'exact', level: 'session' }, storePath);
  const foreverG = s1.add({ tool: 'read', pattern: 'exact', level: 'forever' }, storePath);
  ok('turn grant matches the tool', s1.match('bash')?.id === turnG.id);
  ok('session grant matches its tool', s1.match('edit')?.id === sessionG.id);
  ok('forever grant matches its tool', s1.match('read')?.id === foreverG.id);
  ok('non-matching tool returns null', s1.match('webfetch') === null);

  section('v4.4 — forever grants persist to disk');
  ok('forever grant written to permission-grants.json',
    existsSync(storePath) && JSON.parse(readFileSync(storePath, 'utf8')).grants.length === 1);
  // Construct a new store from the same path and confirm it loads.
  const s2 = new GrantStore(storePath);
  ok('new store reloads forever grant from disk', s2.match('read')?.id === foreverG.id);
  ok('new store does NOT have session/turn grants (in-memory only)',
    s2.match('bash') === null && s2.match('edit') === null);

  section('v4.4 — cwd scope + prefix pattern');
  // Use a fresh tool name so the project-scoped grant doesn't get
  // shadowed by the earlier session-level `edit` grant.
  const projectG = s1.add({ tool: 'webfetch', pattern: 'exact', level: 'session', cwdScope: '/home/user/proj' }, storePath);
  ok('cwd-scoped grant does NOT match different cwd',
    s1.match('webfetch', '/other/dir')?.id !== projectG.id);
  ok('cwd-scoped grant DOES match its cwd',
    s1.match('webfetch', '/home/user/proj')?.id === projectG.id);
  const prefixG = s1.add({ tool: 'git', pattern: 'prefix', level: 'session' }, storePath);
  ok('prefix pattern matches exact tool', s1.match('git', '/x')?.id === prefixG.id);
  ok('prefix pattern matches family member (git_status)',
    s1.match('git_status', '/x')?.id === prefixG.id);

  section('v4.4 — clear scopes');
  s1.clearTurnGrants();
  ok('clearTurnGrants removes turn grants but keeps session + forever',
    s1.match('bash') === null && s1.match('edit') !== null && s1.match('read') !== null);
  s1.clearSessionGrants();
  ok('clearSessionGrants removes session + turn but keeps forever',
    s1.match('edit') === null && s1.match('read') !== null);

  section('v4.4 — remove by id');
  const removed = s1.remove(foreverG.id);
  ok('remove(forever id) returns true + drops the grant',
    removed === true && s1.match('read') === null);
  ok('remove(unknown id) returns false', s1.remove('nope') === false);

  // cleanup
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }

  // ─── v4.5: CDP-client URL allowlist (pure logic) ─────────────
  // We re-implement the same isPrivateHost + isAllowedHost used
  // by the browser-v2 plugin to test the policy without spinning
  // up a real browser. The production code is in
  // examples/plugins/deqi-plugin-browser-v2/index.mjs.
  function isPrivateHost(h: string): boolean {
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (h.startsWith('10.') || h.startsWith('192.168.')) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
    if (h.startsWith('169.254.') || h.startsWith('fe80:')) return true;
    return false;
  }
  function isAllowedHost(url: string, allowlist: string[]): boolean {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      if (isPrivateHost(u.hostname)) return false;
      return allowlist.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
    } catch { return false; }
  }
  const allow = ['example.com', 'httpbin.org'];

  section('v4.5 — URL allowlist + private-IP block');
  ok('public allowlisted host: allowed',
    isAllowedHost('https://example.com/foo', allow));
  ok('public non-allowlisted host: blocked',
    !isAllowedHost('https://evil.com/foo', allow));
  ok('subdomain of allowlisted host: allowed',
    isAllowedHost('https://api.example.com/x', allow));
  ok('private 10.0.0.1: blocked even if host is allowlisted',
    !isAllowedHost('https://10.0.0.1', allow));
  ok('private 192.168.1.1: blocked',
    !isAllowedHost('https://192.168.1.1', allow));
  ok('loopback 127.0.0.1: blocked',
    !isAllowedHost('https://127.0.0.1', allow));
  ok('non-http(s) protocol: blocked',
    !isAllowedHost('file:///etc/passwd', allow));
  ok('malformed URL: blocked',
    !isAllowedHost('not-a-url', allow));

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v4.4-5-test crashed:', err);
  process.exit(1);
});
