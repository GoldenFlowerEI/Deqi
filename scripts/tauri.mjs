#!/usr/bin/env node
// Thin wrapper so `tauri ...` works the same as the cargo-installed CLI.
// Resolves to the npm prebuilt @tauri-apps/cli (native module) which is
// already in the workspace's node_modules. This avoids a 5-15 minute
// `cargo install tauri-cli` compile on every dev machine.

import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const candidates = [
  "node_modules/.bun/@tauri-apps+cli@2.11.4/node_modules/@tauri-apps/cli/tauri.js",
  "node_modules/@tauri-apps/cli/tauri.js",
];

let entry;
for (const c of candidates) {
  const p = join(projectRoot, c);
  if (existsSync(p)) {
    entry = p;
    break;
  }
}
if (!entry) {
  console.error("[tauri] could not find @tauri-apps/cli/tauri.js — run `bun install` first");
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
child.on("exit", (code) => process.exit(code ?? 0));
