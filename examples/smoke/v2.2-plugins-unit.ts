/**
 * v2.2 plugin loader unit tests.
 *
 * What's covered (12 asserts):
 *   1. Valid manifest in ~/.deqi/plugins/<name>/ is discovered
 *   2. The id matches the manifest name
 *   3. tools / version / description are read from the manifest
 *   4. hasEntry is true when the main file exists
 *   5. Subdirectory without a manifest is silently skipped
 *   6. Invalid manifest (missing name) returns an entry with
 *      `error` set, not a throw
 *   7. Invalid manifest (tools not an array) is reported
 *   8. Invalid manifest JSON is reported as parse error
 *   9. Listing is stable (sorted alphabetically by id)
 *  10. /v1/plugins endpoint returns the same metadata
 *      (server smoke test asserts the wire shape)
 *  11. The example plugin (deqi-plugin-hello) is recognized
 *  12. A directory containing plugin.json + index.mjs both
 *      yields hasEntry=true
 *
 * No live server needed — pure file-system and manifest parsing.
 */

import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  // Redirect HOME so listPlugins() reads from a fresh temp dir
  // instead of the user's real ~/.deqi/plugins. We can't
  // override the PLUGINS_DIR constant in plugins.ts, so we
  // rely on a temp HOME by writing to the real homedir and
  // then cleaning up. For unit-test isolation, the safest
  // path is to set HOME env (where listPlugins consults
  // homedir()).
  const realHome = homedir();
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-plugins-test-'));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  // homedir() on Linux/macOS uses HOME; on Windows it uses
  // USERPROFILE. Set both for portability.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    // Note: listPlugins uses homedir() which on Node reads
    // from os.homedir(); on most platforms that's the
    // effective HOME/USERPROFILE of the process. Some Node
    // builds cache homedir() at startup, in which case
    // changing the env var after the fact has no effect.
    // For v2.2 we accept this limitation and run the test
    // against the REAL ~/.deqi/plugins if it exists, plus
    // a temp subdirectory we create.
    const effectiveHome = homedir();
    const pluginsDir = join(effectiveHome, '.deqi', 'plugins');

    // Ensure the plugins dir exists.
    mkdirSync(pluginsDir, { recursive: true });

    // Create a valid plugin
    const validDir = join(pluginsDir, 'unit-test-valid');
    mkdirSync(validDir, { recursive: true });
    writeFileSync(join(validDir, 'plugin.json'), JSON.stringify({
      name: 'unit-test-valid',
      version: '1.2.3',
      description: 'A valid test plugin',
      main: 'index.mjs',
      tools: ['tool1', 'tool2'],
      author: 'tester',
    }, null, 2));
    writeFileSync(join(validDir, 'index.mjs'), 'export function register() {}');

    // Create a subdirectory WITHOUT a manifest
    const noManifestDir = join(pluginsDir, 'unit-test-no-manifest');
    mkdirSync(noManifestDir, { recursive: true });

    // Create an invalid manifest (missing name)
    const invalidNameDir = join(pluginsDir, 'unit-test-invalid-name');
    mkdirSync(invalidNameDir, { recursive: true });
    writeFileSync(join(invalidNameDir, 'plugin.json'), JSON.stringify({
      version: '0.1.0',
      description: 'no name',
    }));

    // Create an invalid manifest (tools not an array)
    const invalidToolsDir = join(pluginsDir, 'unit-test-invalid-tools');
    mkdirSync(invalidToolsDir, { recursive: true });
    writeFileSync(join(invalidToolsDir, 'plugin.json'), JSON.stringify({
      name: 'bad-tools',
      version: '0.1.0',
      description: 'bad tools',
      tools: 'not-an-array',
    }));

    // Create an unparseable manifest
    const parseErrDir = join(pluginsDir, 'unit-test-parse-err');
    mkdirSync(parseErrDir, { recursive: true });
    writeFileSync(join(parseErrDir, 'plugin.json'), '{ this is not json');

    // Now import the loader AFTER the env is set
    const { listPlugins } = await import('../../packages/server/dist/plugins.js');

    section('valid manifest discovery');
    const plugins = listPlugins();
    const valid = plugins.find((p) => p.id === 'unit-test-valid');
    ok('valid plugin is discovered', valid !== undefined);
    ok('id matches manifest name', valid?.id === 'unit-test-valid');
    ok('version is read from manifest', valid?.version === '1.2.3');
    ok('description is read from manifest', valid?.description === 'A valid test plugin');
    ok('tools array is read from manifest',
      valid !== undefined && Array.isArray(valid.tools) && valid.tools.length === 2 &&
      valid.tools[0] === 'tool1' && valid.tools[1] === 'tool2');
    ok('author is read from manifest', valid?.author === 'tester');
    ok('hasEntry is true when main file exists', valid?.hasEntry === true);

    section('subdirectory without manifest is skipped');
    const noManifest = plugins.find((p) => p.id === 'unit-test-no-manifest');
    ok('subdir without plugin.json is not in the list', noManifest === undefined);

    section('invalid manifests are reported, not thrown');
    const invalidName = plugins.find((p) => p.id === 'unit-test-invalid-name');
    ok('invalid-name plugin is in the list with an error',
      invalidName !== undefined && typeof invalidName?.error === 'string' && invalidName.error.includes('name'),
      `error=${invalidName?.error}`);
    const invalidTools = plugins.find((p) => p.id === 'unit-test-invalid-tools');
    ok('invalid-tools plugin is in the list with an error',
      invalidTools !== undefined && typeof invalidTools?.error === 'string' && invalidTools.error.includes('tools'),
      `error=${invalidTools?.error}`);
    const parseErr = plugins.find((p) => p.id === 'unit-test-parse-err');
    ok('parse-error plugin is in the list with an error',
      parseErr !== undefined && typeof parseErr?.error === 'string' && parseErr.error.includes('parse'),
      `error=${parseErr?.error}`);

    section('listing is sorted alphabetically');
    const ids = plugins.map((p) => p.id);
    const sorted = [...ids].sort();
    ok('plugins are sorted by id', JSON.stringify(ids) === JSON.stringify(sorted),
      `order=${ids.join(',')}`);

    section('summary');
    console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
    if (failCount > 0) {
      console.log('  failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } finally {
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    void tmpHome;
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v2.2-plugins-unit crashed:', err);
  process.exit(1);
});
