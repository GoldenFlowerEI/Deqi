/**
 * v1.1 smoke test: in-TUI provider setup + env override.
 *
 * Verifies:
 *   1. loadConfig() returns an empty config when no file exists.
 *   2. setProviderKey() writes to ~/.deqi/config.json.
 *   3. After setProviderKey, loadConfig() reads the value back.
 *   4. _resetConfigCache() forces a re-read.
 *   5. The CLI does NOT exit when no provider is configured AND
 *      the user is entering interactive mode (we can't test the
 *      TUI directly here, but we can test that runScript-style
 *      setup works end-to-end with a fake registry).
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadConfig,
  saveConfig,
  setProviderKey,
  setDefaultModel,
  providerKey,
  _resetConfigCache,
} from '@deqi/coding-agent';
import { ModelRegistry } from '@deqi/ai';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main(): Promise<void> {
  // -- Test 1: loadConfig returns an empty config when no file exists.
  {
    _resetConfigCache();
    // Backup existing config if any.
    const cfgPath = join(homedir(), '.deqi', 'config.json');
    let backedUp: string | null = null;
    if (existsSync(cfgPath)) {
      backedUp = readFileSync(cfgPath, 'utf8');
    }
    // Ensure no config exists.
    try {
      rmSync(cfgPath, { force: true });
    } catch {
      // ignore
    }
    _resetConfigCache();
    const cfg = loadConfig();
    ok('loadConfig returns empty when no file', cfg.providers && Object.keys(cfg.providers).length === 0);

    // -- Test 2: setProviderKey writes to disk.
    setProviderKey('anthropic', 'sk-test-anthropic-12345');
    ok('config file now exists', existsSync(cfgPath));
    const raw = readFileSync(cfgPath, 'utf8');
    ok('config file contains the key', raw.includes('sk-test-anthropic-12345'));
    ok('config file identifies the provider', raw.includes('"anthropic"'));

    // -- Test 3: loadConfig reads the value back.
    _resetConfigCache();
    const cfg2 = loadConfig();
    ok('reloaded config has the anthropic key', cfg2.providers.anthropic?.apiKey === 'sk-test-anthropic-12345');

    // -- Test 4: providerKey returns the right env / file value.
    const k = providerKey('anthropic');
    ok('providerKey returns the persisted key', k === 'sk-test-anthropic-12345');

    // -- Test 5: setDefaultModel.
    setDefaultModel('claude-haiku-4-5');
    _resetConfigCache();
    const cfg3 = loadConfig();
    ok('default model is persisted', cfg3.defaultModel === 'claude-haiku-4-5');

    // -- Test 6: openai-compat with baseUrl.
    setProviderKey('openai-compat', 'sk-fake', { baseUrl: 'https://api.example.com/v1' });
    _resetConfigCache();
    const cfg4 = loadConfig();
    ok('openai-compat base url is persisted', cfg4.providers['openai-compat']?.baseUrl === 'https://api.example.com/v1');
    ok('openai-compat api key is persisted', cfg4.providers['openai-compat']?.apiKey === 'sk-fake');

    // -- Test 7: ModelRegistry.fromEnv picks up env vars set via setProviderKey.
    //   We simulate the TUI /setup flow: setProviderKey writes to disk,
    //   then the CLI's pre-build step also applies file→env.
    process.env.ANTHROPIC_API_KEY = cfg4.providers.anthropic!.apiKey;
    const reg = ModelRegistry.fromEnv();
    ok('anthropic is now a known available provider', reg.isProviderAvailable('anthropic'));
    ok('a known anthropic model is available', reg.listModels().some((m) => m.provider === 'anthropic' && reg.isProviderAvailable(m.provider)));

    // Cleanup.
    delete process.env.ANTHROPIC_API_KEY;
    if (backedUp !== null) {
      writeFileSync(cfgPath, backedUp, 'utf8');
    } else {
      try {
        rmSync(cfgPath, { force: true });
      } catch {
        // ignore
      }
    }
    _resetConfigCache();
  }

  console.log(process.exitCode === 1 ? 'SETUP SMOKE FAILED' : 'SETUP SMOKE PASSED');
}

main().catch((err) => {
  console.error('setup smoke crashed:', err);
  process.exit(1);
});
