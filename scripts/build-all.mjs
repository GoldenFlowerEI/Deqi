#!/usr/bin/env node
// Cross-package build. Topologically sorts packages/* by their
// @deqi/* dependencies and runs `tsc -p tsconfig.json` in each.
// Works under bun, node, or pnpm/npm — no dependency on a specific
// workspace orchestrator.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const allPkgs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/** Returns the @deqi/* deps declared by a package, or []. */
function deqiDeps(pkg) {
  const pkgJsonPath = join(root, 'packages', pkg, 'package.json');
  if (!existsSync(pkgJsonPath)) return [];
  try {
    const j = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const out = [];
    for (const name of Object.keys(j.dependencies ?? {})) {
      if (name.startsWith('@deqi/')) out.push(name.slice('@deqi/'.length));
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Kahn's algorithm: each level is a set of packages whose deps are
 * already built. Build all packages in the same level in order — they
 * are independent of each other.
 */
function topoSort(pkgs) {
  const inSet = new Set(pkgs);
  const depCounts = new Map(pkgs.map((p) => [p, 0]));
  for (const p of pkgs) {
    for (const d of deqiDeps(p)) {
      if (inSet.has(d)) depCounts.set(p, (depCounts.get(p) ?? 0) + 1);
    }
  }
  const order = [];
  let frontier = pkgs.filter((p) => (depCounts.get(p) ?? 0) === 0);
  while (frontier.length > 0) {
    order.push(frontier);
    const next = new Set();
    for (const p of frontier) {
      for (const other of pkgs) {
        if (deqiDeps(other).includes(p)) {
          const c = (depCounts.get(other) ?? 0) - 1;
          depCounts.set(other, c);
          if (c === 0) next.add(other);
        }
      }
    }
    frontier = Array.from(next);
  }
  return order;
}

const levels = topoSort(allPkgs);
const noEmit = process.argv.includes('--noEmit');
let failed = 0;

for (const level of levels) {
  for (const pkg of level) {
    const dir = join(root, 'packages', pkg);
    if (!existsSync(join(dir, 'tsconfig.json'))) continue;
    console.log(`→ build ${pkg}`);
    const args = noEmit
      ? ['tsc', '-p', 'tsconfig.json', '--noEmit']
      : ['tsc', '-p', 'tsconfig.json'];
    const r = spawnSync('bun', args, { cwd: dir, stdio: 'inherit', shell: false });
    if (r.status !== 0) {
      console.error(`build failed in ${pkg}`);
      failed += 1;
    }
  }
}

if (failed > 0) {
  console.error(`${failed} package(s) failed to build`);
  process.exit(1);
}
console.log('all packages built');

