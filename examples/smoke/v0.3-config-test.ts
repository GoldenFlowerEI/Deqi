/**
 * v0.3-config-test.ts — a corrupt config must not cost you your keys.
 *
 * Why this file exists
 * --------------------
 * `loadConfig()` caught every error and returned an EMPTY config.
 * That alone is survivable — but the next `saveConfig()` (from the
 * settings page, the setup wizard, a provider edit, anything that
 * touches settings) wrote that EMPTY back over the original file. One
 * stray byte in ~/.deqi/config.json turned into permanently empty
 * providers: every stored API key gone, no error shown, and no file
 * left to recover from.
 *
 * The same function wrote with a bare `writeFileSync`, which truncates
 * before writing, so a crash mid-write produced exactly the corrupt
 * file the quarantine path then had to deal with.
 *
 * What this asserts
 *   1. A malformed config is preserved byte-for-byte under
 *      config.json.broken-N before anything else happens.
 *   2. A save after a failed load cannot destroy the original.
 *   3. A well-formed config with a future `version` is NOT quarantined
 *      — it may be deliberate, and rewriting it would downgrade data.
 *   4. saveConfig is atomic: the destination is never observed
 *      half-written, and a failed write leaves the old content.
 *   5. The error is reported rather than swallowed, so a UI can show
 *      it instead of silently losing settings.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Fresh module instance per scenario. The config module caches the
 * parsed config in a module-level variable, so re-importing under a
 * different HOME needs a cache-busting specifier — otherwise the
 * second scenario reads the first scenario's cached object and the
 * test proves nothing.
 */
let importCounter = 0;
async function freshConfigModule(home: string) {
  importCounter += 1;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const mod = await import(
    `../../packages/coding-agent/dist/src/config.js?case=${importCounter}`
  );
  return mod as {
    loadConfig: () => { version: number; providers: Record<string, { apiKey?: string }> };
    saveConfig: (c: unknown) => void;
    configLoadError: () => { message: string; backup: string | null } | null;
  };
}

function makeHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `deqi-v03-cfg-${label}-`));
  mkdirSync(join(home, '.deqi'), { recursive: true });
  return home;
}

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const homes: string[] = [];
  try {
    // ─── 1. a malformed config is preserved ─────────────────────
    section('a malformed config is quarantined, not overwritten');
    {
      const home = makeHome('bad');
      homes.push(home);
      const p = join(home, '.deqi', 'config.json');
      // A trailing comma — the single most likely way a hand-edited
      // file breaks, and exactly the kind of thing that used to cost
      // the user every key they had stored.
      const original = '{\n  "version": 1,\n  "providers": {\n    "anthropic": { "apiKey": "sk-ant-SECRET" },\n  },\n}\n';
      writeFileSync(p, original, 'utf8');

      const cfg = await freshConfigModule(home);
      const loaded = cfg.loadConfig();
      ok('a malformed config loads as empty rather than throwing', loaded.version === 1);
      ok('no providers are available', Object.keys(loaded.providers).length === 0);

      const err = cfg.configLoadError();
      ok('the failure is reported, not swallowed', err !== null, err?.message.slice(0, 70) ?? '');
      ok('the message says the file is not valid JSON',
        (err?.message ?? '').includes('not valid JSON'), err?.message.slice(0, 80) ?? '');

      const backups = readdirSync(join(home, '.deqi')).filter((n) => n.startsWith('config.json.broken-'));
      ok('a .broken-N copy was created', backups.length === 1, backups.join(','));
      if (backups.length) {
        const kept = readFileSync(join(home, '.deqi', backups[0]!), 'utf8');
        ok('the copy is byte-for-byte the original', kept === original,
          `${kept.length} vs ${original.length} bytes`);
        ok('the API key is recoverable from the copy', kept.includes('sk-ant-SECRET'));
      }
      ok('configLoadError points at the backup', (err?.backup ?? '').includes('config.json.broken-'),
        err?.backup ?? '');
    }

    // ─── 2. a later save cannot destroy the original ────────────
    section('a save after a failed load does not destroy the original');
    {
      const home = makeHome('save-after-bad');
      homes.push(home);
      const p = join(home, '.deqi', 'config.json');
      const original = '{ "version": 1, "providers": { "openai": { "apiKey": "sk-oai-SECRET" } }, }';
      writeFileSync(p, original, 'utf8');

      const cfg = await freshConfigModule(home);
      cfg.loadConfig();
      // The settings page writes whatever it thinks the config is. In
      // the old code that was EMPTY, and this line destroyed the file.
      cfg.saveConfig({ version: 1, providers: {} });

      ok('config.json now holds the newly written config',
        !readFileSync(p, 'utf8').includes('sk-oai-SECRET'));
      const backups = readdirSync(join(home, '.deqi')).filter((n) => n.startsWith('config.json.broken-'));
      ok('but the original survives in a backup', backups.length === 1, backups.join(','));
      if (backups.length) {
        const kept = readFileSync(join(home, '.deqi', backups[0]!), 'utf8');
        ok('the backup still contains the key', kept.includes('sk-oai-SECRET'));
      }
    }

    // ─── 3. a future version is NOT quarantined ────────────────
    section('a well-formed config from a newer build is left alone');
    {
      const home = makeHome('future');
      homes.push(home);
      const p = join(home, '.deqi', 'config.json');
      const original = JSON.stringify({ version: 99, providers: { google: { apiKey: 'g-SECRET' } } });
      writeFileSync(p, original, 'utf8');

      const cfg = await freshConfigModule(home);
      cfg.loadConfig();
      const backups = readdirSync(join(home, '.deqi')).filter((n) => n.startsWith('config.json.broken-'));
      ok('no .broken-N copy is made for a future version', backups.length === 0, backups.join(','));
      ok('the file is left exactly as it was', readFileSync(p, 'utf8') === original);
      const err = cfg.configLoadError();
      ok('but the version mismatch IS reported', (err?.message ?? '').includes('version 99'),
        err?.message.slice(0, 90) ?? '');
    }

    // ─── 4. saves are atomic ───────────────────────────────────
    section('saveConfig leaves no temp files and never a partial file');
    {
      const home = makeHome('atomic');
      homes.push(home);
      const cfg = await freshConfigModule(home);
      const p = join(home, '.deqi', 'config.json');

      cfg.saveConfig({ version: 1, providers: { anthropic: { apiKey: 'sk-1' } } });
      ok('the first save writes valid JSON', JSON.parse(readFileSync(p, 'utf8')).providers.anthropic.apiKey === 'sk-1');

      cfg.saveConfig({ version: 1, providers: { anthropic: { apiKey: 'sk-2' } } });
      ok('a second save replaces it', JSON.parse(readFileSync(p, 'utf8')).providers.anthropic.apiKey === 'sk-2');

      const leftovers = readdirSync(join(home, '.deqi')).filter((n) => n.includes('.tmp'));
      ok('no .tmp file is left behind', leftovers.length === 0, leftovers.join(','));
      ok('the final file parses', (() => { try { JSON.parse(readFileSync(p, 'utf8')); return true; } catch { return false; } })());

      // A save that cannot complete must throw AND leave the previous
      // content intact. The old code called writeFileSync(p, ...) which
      // truncates the destination FIRST, so any failure after that
      // point left an empty or half-written config.
      //
      // The way to force a failure is to make the destination a
      // directory: mkdirSync still succeeds, the temp write succeeds,
      // and only the final rename fails. (Pointing HOME at a
      // non-existent path does not work — saveConfig creates the
      // parent on purpose, which is correct.)
      const blocked = makeHome('blocked');
      homes.push(blocked);
      const blockedCfg = join(blocked, '.deqi', 'config.json');
      mkdirSync(blockedCfg, { recursive: true });
      const blockedMod = await freshConfigModule(blocked);
      let threw = false;
      let message = '';
      try {
        blockedMod.saveConfig({ version: 1, providers: {} });
      } catch (e) {
        threw = true;
        message = (e as Error).message;
      }
      ok('a save that cannot complete throws rather than failing silently', threw, message.slice(0, 90));
      ok('the error says the previous config is unchanged', message.includes('previous config is unchanged'),
        message.slice(0, 120));
      ok('the destination is still a directory, not a truncated file',
        readdirSync(blockedCfg).length === 0);
      const noTmp = readdirSync(join(blocked, '.deqi')).filter((n) => n.includes('.tmp'));
      ok('the temp file is cleaned up after a failed rename', noTmp.length === 0, noTmp.join(','));
    }

    // ─── 5. a good config still works normally ──────────────────
    section('the happy path is unchanged');
    {
      const home = makeHome('good');
      homes.push(home);
      const p = join(home, '.deqi', 'config.json');
      const good = { version: 1, providers: { anthropic: { apiKey: 'sk-good' } } };
      writeFileSync(p, JSON.stringify(good, null, 2), 'utf8');

      const cfg = await freshConfigModule(home);
      const loaded = cfg.loadConfig();
      ok('providers load', loaded.providers.anthropic?.apiKey === 'sk-good');
      ok('no error is reported', cfg.configLoadError() === null);
      const backups = readdirSync(join(home, '.deqi')).filter((n) => n.startsWith('config.json.broken-'));
      ok('no backup is created for a valid file', backups.length === 0);
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    for (const h of homes) {
      try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[31mv0.3-config-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mv0.3-config-test PASSED\x1b[0m');
}

main().catch((err) => {
  console.error('v0.3-config-test crashed:', err);
  process.exit(1);
});

void existsSync;
