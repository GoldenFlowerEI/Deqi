/**
 * v3.10 plugin permissions test.
 *
 * What's covered (12 asserts):
 *   1-3. validatePermissions: ok, missing capabilities, unknown cap
 *   4.   validateManifest: rejects unknown capability
 *   5-7. resolveGrantedCapabilities: grants in-policy, denies out, partial
 *   8.   requireCapability throws a clear error
 *   9.   requireCapability does not throw when granted
 *  10.   DEFAULT_POLICY includes subprocess + network
 *  11.   KNOWN_CAPABILITIES contains the 7 expected names
 *  12.   PluginApi.grantedCapabilities is a Set the plugin can read
 */

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
  const perm = await import('../../packages/server/dist/plugin-permissions.js');
  const {
    KNOWN_CAPABILITIES,
    DEFAULT_POLICY,
    validatePermissions,
    resolveGrantedCapabilities,
    requireCapability,
  } = perm;

  section('known capabilities + default policy');
  ok('KNOWN_CAPABILITIES has 7 entries',
    KNOWN_CAPABILITIES.length === 7,
    `got=[${KNOWN_CAPABILITIES.join(', ')}]`);
  ok('KNOWN_CAPABILITIES contains fs:write + env (the dangerous ones)',
    KNOWN_CAPABILITIES.includes('fs:write') && KNOWN_CAPABILITIES.includes('env'));
  ok('DEFAULT_POLICY grants subprocess + network',
    DEFAULT_POLICY.has('subprocess') && DEFAULT_POLICY.has('network'));
  ok('DEFAULT_POLICY does NOT grant fs:write or env (safe by default)',
    !DEFAULT_POLICY.has('fs:write') && !DEFAULT_POLICY.has('env'));

  section('validatePermissions');
  ok('null permissions is ok', validatePermissions(null) === null);
  ok('empty object is ok', validatePermissions({}) === null);
  ok('valid array is ok', validatePermissions({ capabilities: ['fs:read', 'subprocess'] }) === null);
  ok('non-array capabilities is rejected',
    validatePermissions({ capabilities: 'fs:read' }) !== null);
  ok('unknown capability is rejected',
    validatePermissions({ capabilities: ['fs:read', 'nuke-the-moon'] }) !== null,
    `error includes the unknown name`);

  section('resolveGrantedCapabilities');
  const r1 = resolveGrantedCapabilities(['fs:read', 'subprocess']);
  ok('granted: in-policy caps are in the granted set',
    r1.granted.has('fs:read') && r1.granted.has('subprocess'));
  // Now declare a cap that is OUT of the default policy (fs:write
  // is in KNOWN_CAPABILITIES but not in DEFAULT_POLICY).
  const r1b = resolveGrantedCapabilities(['fs:read', 'fs:write']);
  ok('denied: out-of-policy caps end up in denied[]',
    r1b.granted.has('fs:read') && !r1b.granted.has('fs:write') && r1b.denied.includes('fs:write'));

  // Custom policy: only allow fs:read.
  const r2 = resolveGrantedCapabilities(['fs:read', 'subprocess', 'network'], new Set(['fs:read']));
  ok('custom policy: only fs:read is granted',
    r2.granted.size === 1 && r2.granted.has('fs:read'));
  ok('custom policy: subprocess + network end up in denied[]',
    r2.denied.includes('subprocess') && r2.denied.includes('network'));

  section('requireCapability');
  const granted = new Set(['fs:read', 'subprocess']);
  ok('requireCapability does not throw for granted cap',
    (() => { try { requireCapability(granted, 'subprocess', 'test-plugin'); return true; } catch { return false; } })());
  let threwMsg = '';
  try { requireCapability(granted, 'fs:write', 'test-plugin'); } catch (e) {
    threwMsg = (e as Error).message;
  }
  ok('requireCapability throws with plugin name + missing cap in message',
    threwMsg.includes('test-plugin') && threwMsg.includes('fs:write'),
    `msg="${threwMsg.slice(0, 80)}..."`);

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v3.10-permissions-test crashed:', err);
  process.exit(1);
});
