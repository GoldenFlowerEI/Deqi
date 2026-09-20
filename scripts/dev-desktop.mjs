// dev-desktop — start deqi-server + Vite dev server in parallel, then
// hand control to Tauri's beforeDevCommand. Tauri will wait for the
// devUrl (http://localhost:5173) to be reachable before opening the
// window, so order doesn't strictly matter — but we want deqi-server
// ready first so the moment the React app mounts it can open a
// WebSocket and the user sees a live status.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// deqi-server source (Node) is fine in dev; the compiled .exe is for
// shipping. We try the Node launcher first because it picks up the
// dev build in dist/ and avoids downloading bun runtime on the dev box.
const serverLauncher = join(projectRoot, "bin", "deqi-server.js");

// Vite lives in the desktop package's node_modules/.bin (Bun hoists
// per-workspace, so the root .bin doesn't have vite). Try the desktop
// package first, then the root as a fallback. Bun on Windows produces
// `vite.exe` (not `vite.cmd`), and on POSIX it's a shell script.
function vitePathFor(root) {
  const bin = resolve(root, "node_modules", ".bin", "vite");
  if (process.platform === "win32") {
    for (const ext of [".exe", ".cmd", ".bat", ""]) {
      const p = bin + ext;
      if (existsSync(p)) return p;
    }
    return null;
  }
  return existsSync(bin) ? bin : null;
}
const viteBin =
  vitePathFor(resolve(projectRoot, "packages", "desktop")) ??
  vitePathFor(projectRoot);

if (!existsSync(serverLauncher)) {
  console.error(`[dev-desktop] missing launcher: ${serverLauncher}`);
  process.exit(1);
}
if (!viteBin) {
  console.error(
    `[dev-desktop] missing vite — run \`bun install\` in packages/desktop`,
  );
  process.exit(1);
}

function paint(name, color) {
  return (chunk) => {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line === "") continue;
      process.stdout.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);
    }
  };
}

const procs = [];

function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? projectRoot,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd),
  });
  child.stdout.on("data", paint(name, "36")); // cyan
  child.stderr.on("data", paint(name, "33")); // yellow
  child.on("exit", (code, sig) => {
    console.log(`[dev-desktop] ${name} exited code=${code} sig=${sig}`);
    // Tear down the other on hard exit
    for (const p of procs) {
      if (p !== child && !p.killed) {
        try { p.kill(); } catch { /* noop */ }
      }
    }
    process.exit(code ?? 0);
  });
  procs.push(child);
  return child;
}

console.log("[dev-desktop] starting deqi-server + Vite (Ctrl+C to stop)");

// deqi-server first so the React app can connect on first paint.
// We run the launcher with `node` (not bun) so the JS we ship is
// interpreted by the same runtime users will have on their machine
// and so the .js shim works in both worlds.
//
// If something is already listening on 7700 (e.g. a separate
// deqi-server you started, or a previous Tauri dev session that
// didn't clean up), skip launching our own — both processes would
// just EADDRINUSE.
const serverInUse = await isPortOpen(7700);
if (serverInUse) {
  paint("server", "33")(
    `port 7700 already in use — reusing the running deqi-server (skipping local spawn)\n`,
  );
} else {
  start(
    "server",
    "node",
    [serverLauncher],
  );
}

// Vite in the desktop package, with our standard port.
// Same reuse logic as deqi-server: a leftover dev server can
// happen if you Ctrl+C'd mid-build, and we don't want every
// retry to fight for the port.
const viteInUse = await isPortOpen(5173);
if (viteInUse) {
  paint("vite", "33")(
    `port 5173 already in use — reusing the running Vite dev server\n`,
  );
} else {
  start(
    "vite",
    viteBin,
    [],
    { cwd: resolve(projectRoot, "packages", "desktop") },
  );
}

// Forward Ctrl+C / SIGTERM to all children
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    for (const p of procs) {
      try { p.kill(sig); } catch { /* noop */ }
    }
  });
}

// ─── helpers ──────────────────────────────────────────────────

/** Returns true if something is already accepting TCP on `port` on
 *  the loopback interface. Used to skip spawning a duplicate
 *  deqi-server when one is already running. */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}
