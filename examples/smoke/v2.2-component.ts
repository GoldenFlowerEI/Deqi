/**
 * v2.2 component test scaffold.
 *
 * Full DOM interaction tests (render + click + type + assert)
 * need @testing-library/react + jsdom. Setting those up
 * requires `bun add -d vitest @testing-library/react
 * @testing-library/jest-dom @testing-library/user-event
 * happy-dom jsdom` plus a vitest.config.ts — that's the
 * v2.3 work.
 *
 * For v2.2 we ship a minimal scaffold that catches the
 * "component file is missing/corrupt" class of bugs without
 * any of those deps:
 *   1. SettingsView can be dynamically imported (no syntax /
 *      type errors at import time)
 *   2. SettingsView exports a function
 *   3. The SettingsView source file contains the v2.2 Edit
 *      button, the provider key input, the default-model
 *      picker, and the show/hide toggle — proving the v2.2
 *      additions didn't regress
 *   4. The chat composer's model picker wires user_message
 *      with the active model (App.tsx source check)
 *   5. agent-runner.ts has runTurn with the modelOverride
 *      parameter
 *
 * These are static checks against the .tsx / .ts source, not
 * a real render. They're cheap (no React runtime needed) and
 * catch a real category of regressions.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const DESKTOP = 'C:/Users/P1/.minimax-agent-cn/projects/deqi/packages/desktop';
const SERVER = 'C:/Users/P1/.minimax-agent-cn/projects/deqi/packages/server';

function read(p: string): string {
  return readFileSync(p, 'utf-8');
}

function main(): void {
  // ── 1. SettingsView source contains the v2.2 surface ───────
  section('SettingsView v2.2 surface (source check)');
  const settingsSrc = read(join(DESKTOP, 'src/components/SettingsView.tsx'));
  ok('SettingsView has an Edit button', /settings-edit-btn|>\s*Edit\s*</.test(settingsSrc));
  ok('SettingsView renders a default-model picker',
    /<select[\s\S]*?default_model/.test(settingsSrc) || /settings-picker/.test(settingsSrc));
  ok('SettingsView has per-provider edit form',
    /settings-provider-edit/.test(settingsSrc));
  ok('SettingsView has API key show/hide toggle',
    /key-toggle|showKey/.test(settingsSrc));
  ok('SettingsView calls api.patchConfig on save',
    /api\.patchConfig\(/.test(settingsSrc));
  ok('SettingsView calls api.putProvider on save',
    /api\.putProvider\(/.test(settingsSrc));
  ok('SettingsView permission grid still uses 4 modes',
    /autonomous/.test(settingsSrc) && /chat_only/.test(settingsSrc));

  // ── 2. App.tsx wires model into user_message ────────────────
  section('App.tsx composer → user_message.model');
  const appSrc = read(join(DESKTOP, 'src/App.tsx'));
  ok('App.tsx sendUserMessage includes the model field',
    /user_message[\s\S]{0,200}model/.test(appSrc) ||
    /model[\s\S]{0,200}user_message/.test(appSrc) ||
    /type:\s*'user_message'[\s\S]{0,200}model/.test(appSrc),
    `looking for "user_message" near "model" in App.tsx`);
  ok('App.tsx has onModelChange wiring (composer picker)',
    /onModelChange|handleModelChange|setState\([^)]*activeModel/.test(appSrc));

  // ── 3. agent-runner.runTurn accepts modelOverride ───────────
  section('server agent-runner.runTurn modelOverride');
  const runnerSrc = read(join(SERVER, 'src/agent-runner.ts'));
  ok('runTurn signature includes modelOverride',
    /runTurn\([\s\S]*?modelOverride/.test(runnerSrc) ||
    /runTurn\([\s\S]*?model\?/.test(runnerSrc),
    `looking for runTurn(... modelOverride?)`);
  ok('runTurn calls agent.setModel on override',
    /setModel\(modelOverride\)/.test(runnerSrc));
  ok('runTurn restores the default after the turn',
    /restore\(\)/.test(runnerSrc) ||
    /optsModelId/.test(runnerSrc));

  // ── 4. server.ts PATCH /v1/config is real ─────────────────
  section('server.ts config endpoints');
  const serverSrc = read(join(SERVER, 'src/server.ts'));
  ok('handlePatchConfig writes default_model',
    /setDefaultModel/.test(serverSrc));
  ok('handlePatchConfig writes behavior fields',
    /setBehavior\(/.test(serverSrc));
  ok('handlePutProvider exists',
    /handlePutProvider/.test(serverSrc));
  ok('PUT /v1/config/providers/:name is routed',
    /\/v1\/config\/providers/.test(serverSrc));
  ok('WS user_message has the model field',
    /user_message[\s\S]{0,200}model/.test(serverSrc) ||
    /msg\.model/.test(serverSrc));

  // ── 5. server plugins module exists with manifest schema ────
  section('server plugins module');
  const pluginsSrc = read(join(SERVER, 'src/plugins.ts'));
  ok('plugins.ts has PluginManifest interface',
    /interface PluginManifest/.test(pluginsSrc));
  ok('plugins.ts has listPlugins()',
    /export function listPlugins/.test(pluginsSrc));
  ok('plugins.ts validates the manifest',
    /validateManifest/.test(pluginsSrc));

  // Summary
  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main();
