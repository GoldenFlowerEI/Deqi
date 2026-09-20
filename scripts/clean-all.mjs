#!/usr/bin/env node
// Cross-package clean.
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const pkgs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

for (const pkg of pkgs) {
  const dist = join(root, 'packages', pkg, 'dist');
  if (existsSync(dist)) {
    console.log(`→ clean packages/${pkg}/dist`);
    rmSync(dist, { recursive: true, force: true });
  }
}
console.log('cleaned');
