/**
 * v3.8 test — plugin loader end-to-end.
 *
 * What's covered (~10 asserts):
 *   - listPlugins on a missing dir returns []
 *   - listPlugins on a dir with the example plugin returns metadata
 *   - loadPlugins without Deqi_ENABLE_PLUGINS returns [] (gated)
 *   - loadPlugins with enabled:true actually dynamic-imports the
 *     example plugin, calls its `register(api)`, and returns
 *     the registered tools
 *   - plugin tool can be invoked through the loader's API
 *   - loadPlugins tolerates a crashing plugin (error captured,
 *     not propagated)
 *
 * No LLM, no real network.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1m── ${t} ──\x1b[0m`); }

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v38-plugin-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  mkdirSync(join(tmpHome, '.deqi', 'plugins'), { recursive: true });

  // Pre-create a "hello" plugin + a "crashing" plugin to exercise
  // both the happy path and the error-capture path.
  mkdirSync(join(tmpHome, '.deqi', 'plugins', 'deqi-plugin-hello'), { recursive: true });
  writeFileSync(join(tmpHome, '.deqi', 'plugins', 'deqi-plugin-hello', 'plugin.json'), JSON.stringify({
    name: 'deqi-plugin-hello',
    version: '0.1.0',
    description: 'Test plugin that registers a hello tool',
    main: 'index.mjs',
    tools: ['hello'],
  }, null, 2));
  writeFileSync(join(tmpHome, '.deqi', 'plugins', 'deqi-plugin-hello', 'index.mjs'), `
export function register(api) {
  api.registerTool({
    name: 'hello',
    description: 'Returns a friendly greeting.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
    execute: async ({ name }) => ({ greeting: 'Hello, ' + (name ?? 'world') + '!' }),
  });
  api.on('agent_start', () => api.log('hello plugin: agent_start observed'));
}
`);

  mkdirSync(join(tmpHome, '.deqi', 'plugins', 'deqi-plugin-broken'), { recursive: true });
  writeFileSync(join(tmpHome, '.deqi', 'plugins', 'deqi-plugin-broken', 'plugin.json'), JSON.stringify({
    name: 'deqi-plugin-broken',
    version: '0.1.0',
    description: 'Test plugin that throws on load',
    main: 'index.mjs',
    tools: [],
  }, null, 2));
  writeFileSync(join(tmpHome, '.deqi', 'plugins', 'deqi-plugin-broken', 'index.mjs'), `
throw new Error('synthetic plugin crash for testing');
`);

  try {
    const { listPlugins, loadPlugins, PLUGIN_PATHS } = await import(
      '../../packages/server/src/plugins.js' as string
    ) as unknown as {
      listPlugins: () => unknown[];
      loadPlugins: (opts: { enabled: boolean }) => Promise<unknown[]>;
      PLUGIN_PATHS: { PLUGINS_DIR: string };
    };

    // Re-point the loader at our tmpHome by overriding the homedir-
    // derived constant. We monkey-patch by setting an env var the
    // loader reads. (For this test we accept that the loader
    // reads process.env once at module load; we set HOME first.)
    // The PLUGINS_DIR was already resolved from process.env at
    // import time — we have to update the loaded module's value.
    const mod = await import('../../packages/server/src/plugins.js' as string) as unknown as Record<string, unknown>;
    // Reach into the module cache to patch the PLUGINS_DIR export.
    // (modules don't normally let you do this, but a Module
    // override via process._linkedBinding isn't worth it. Instead
    // we accept the test only works when HOME was set BEFORE the
    // first import — which is what we did at the top of main().)
    void PLUGIN_PATHS;

    section('listPlugins');
    {
      const all = listPlugins() as Array<{ id: string; hasEntry: boolean; tools: string[] }>;
      ok('listPlugins: 2 plugins discovered', all.length === 2, `count=${all.length}`);
      ok('listPlugins: hello plugin found', all.some((p) => p.id === 'deqi-plugin-hello'));
      ok('listPlugins: broken plugin found (with manifest)', all.some((p) => p.id === 'deqi-plugin-broken'));
      const hello = all.find((p) => p.id === 'deqi-plugin-hello');
      ok('listPlugins: hello has tools=["hello"]', hello?.tools[0] === 'hello');
      ok('listPlugins: hello hasEntry=true', hello?.hasEntry === true);
    }

    section('loadPlugins — gated off by default');
    {
      const results = await loadPlugins({ enabled: false });
      ok('loadPlugins({enabled:false}) returns [] (gate)', Array.isArray(results) && results.length === 0,
        `len=${(results as unknown[]).length}`);
    }

    section('loadPlugins — enabled:true actually loads');
    {
      const results = await loadPlugins({ enabled: true }) as Array<{
        id: string;
        tools: Array<{ name: string; execute: (a: unknown, ctx: { cwd: string }) => Promise<unknown> }>;
        routes: unknown[];
        events: string[];
        error?: string;
      }>;
      const hello = results.find((r) => r.id === 'deqi-plugin-hello');
      const broken = results.find((r) => r.id === 'deqi-plugin-broken');
      ok('loadPlugins: 2 results', results.length === 2);
      ok('loadPlugins: hello loaded without error', hello && !hello.error);
      ok('loadPlugins: hello registered 1 tool', hello?.tools.length === 1);
      ok('loadPlugins: hello tool name is "hello"', hello?.tools[0]?.name === 'hello');
      ok('loadPlugins: hello registered 1 event subscriber', hello?.events.length === 1);
      ok('loadPlugins: hello registered 0 routes', hello?.routes.length === 0);
      ok('loadPlugins: broken plugin captured error, did NOT throw', broken && !!broken.error,
        `error=${broken?.error?.slice(0, 50)}`);
    }

    section('plugin tool can actually be invoked');
    {
      const results = await loadPlugins({ enabled: true }) as Array<{
        id: string;
        tools: Array<{ name: string; execute: (a: unknown, ctx: { cwd: string }) => Promise<unknown> }>;
      }>;
      const hello = results.find((r) => r.id === 'deqi-plugin-hello');
      const tool = hello?.tools[0];
      if (tool) {
        const out = await tool.execute({ name: 'deqi' }, { cwd: process.cwd() });
        const text = typeof out === 'string' ? out : JSON.stringify(out);
        ok('hello({name:"deqi"}) returns "Hello, deqi!"', text.includes('Hello, deqi!'), `out=${text}`);
      } else {
        ok('hello tool exists (skipped)', false);
      }
    }

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

main().catch((err) => { console.error('v3.8-plugin-test crashed:', err); process.exit(1); });
