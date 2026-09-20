#!/usr/bin/env node
// Launcher for the deqi-server. We resolve the dist entry via the
// workspace package so this script works from a source checkout,
// from a packaged install, and from a Tauri sidecar.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Walk up from this launcher to find the project root, or honor
// Deqi_HOME. This mirrors the deqi.js launcher pattern so the
// server can be launched from a packaged bin or from a checkout.
function findEntry() {
  if (process.env.Deqi_HOME) {
    const p = resolve(process.env.Deqi_HOME, 'packages/server/dist/index.js');
    if (existsSync(p)) return p;
  }
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'packages', 'server', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back: assume this file lives in a packaged bin next to
  // node_modules/@deqi/server/dist/index.js
  return resolve(__dirname, '..', 'node_modules', '@deqi', 'server', 'dist', 'index.js');
}

// Node ≥22 (and certainly v24) refuses `import(<bare-windows-path>)`.
// Wrap the resolved path in a file:// URL before handing it to the
// ESM loader. This is the same fix deqi.js applied earlier.
await import(pathToFileURL(findEntry()).href);

