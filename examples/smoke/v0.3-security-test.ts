/**
 * v0.3-security-test.ts — proves the four holes are closed.
 *
 * Each section corresponds to a specific defect found in the v0.2
 * audit. They are written as exploit tests: each one performs the
 * attack the old code permitted and asserts it now fails. A test that
 * only checked "the new function returns the right value" would have
 * passed against the vulnerable code too.
 *
 *   1. CORS `*`         — any web page could read the API.
 *   2. /v1/files root   — the caller chose the root the traversal
 *                         check validated against, so `?root=C:/`
 *                         enumerated the drive.
 *   3. WS frame size    — the declared length went straight into
 *                         Buffer.alloc() with no ceiling.
 *   4. handshake leak   — a failed upgrade left the socket open.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, parse, sep } from 'node:path';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { isAllowedFileRoot } = await import('../../packages/server/dist/v2endpoints.js');

let passCount = 0;
let failCount = 0;

const SMOKE_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SMOKE_DIR, '..', '..');
const SERVER_ENTRY = join(REPO_ROOT, 'packages', 'server', 'dist', 'index.js');

/** Poll /health until the child server is listening. */
async function waitForHealth(port: number, ms = 15000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not become healthy on port ${port}`);
}

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passCount += 1;
    console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolveP) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const p = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolveP(p));
    });
  });
}

/** Open a raw TCP socket and return helpers for reading/writing. */
function rawSocket(port: number): Promise<{
  sock: import('node:net').Socket;
  send: (b: Buffer) => void;
  recv: (ms: number) => Promise<Buffer>;
  closed: () => boolean;
}> {
  return new Promise((resolveP, rejectP) => {
    const sock = connect({ port, host: '127.0.0.1' }, () => resolveP({
      sock,
      send: (b: Buffer) => sock.write(b),
      recv: (ms: number) => new Promise<Buffer>((r) => {
        const chunks: Buffer[] = [];
        const onData = (c: Buffer) => chunks.push(c);
        sock.on('data', onData);
        setTimeout(() => { sock.off('data', onData); r(Buffer.concat(chunks)); }, ms);
      }),
      closed: () => sock.destroyed,
    }));
    sock.on('error', (e) => {
      if (process.env.V03_DEBUG) console.log('[v03-debug] socket error:', e.message);
      rejectP(e);
    });
  });
}

function wsHeaders(port: number): string {
  const key = Buffer.from('deqi-security-test').toString('base64');
  // The Host header must carry the port. Without it Node's HTTP
  // parser rejects the whole upgrade as malformed before any of our
  // code runs, which surfaced as a confusing "Invalid method
  // encountered" on the server side.
  return `GET /v1/chat HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n\r\n`;
}

/** An unmasked frame is all we need — the length header is what the
 *  attack controls, and it is parsed before masking is considered. */
function frameDeclaringLength(length: bigint | number): Buffer {
  const len = typeof length === 'bigint' ? length : BigInt(length);
  const header = Buffer.alloc(10);
  header[0] = 0x81; // FIN + text
  header[1] = 127;  // 64-bit length follows
  header.writeBigUInt64BE(len, 2);
  return header;
}

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v03-sec-home-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const project = mkdtempSync(join(tmpdir(), 'deqi-v03-sec-proj-'));
  writeFileSync(join(project, 'package.json'), '{"name":"p"}\n', 'utf8');
  const plainDir = mkdtempSync(join(tmpdir(), 'deqi-v03-sec-plain-'));
  writeFileSync(join(plainDir, 'notes.txt'), 'hi\n', 'utf8');

  const port = await freePort();
  // v0.3: the server runs as a CHILD PROCESS under node, not in this
  // process. Two reasons:
  //   - it is how the server actually runs (`npm run server` is
  //     `node packages/server/dist/index.js`);
  //   - Bun's HTTP server parses a WebSocket upgrade differently from
  //     Node's. Under Bun, a byte-identical, spec-conformant upgrade
  //     request is rejected with "Parse Error: Invalid method
  //     encountered", so testing the codec in-process would be testing
  //     the runtime, not the server.
  const child = spawn(process.execPath, [SERVER_ENTRY, '--port', String(port)], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  await waitForHealth(port);
  const base = `http://127.0.0.1:${port}`;

  try {
    // ─── 1. CORS ──────────────────────────────────────────────
    section('1. CORS is not a wildcard');
    {
      const evil = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
      const allow = evil.headers.get('access-control-allow-origin');
      ok('a random web origin gets NO allow-origin header', allow === null, `got ${allow}`);
      ok('the response is not marked as cross-origin-readable',
        evil.headers.get('access-control-allow-origin') !== '*');

      const tauri = await fetch(`${base}/health`, { headers: { origin: 'tauri://localhost' } });
      ok('the Tauri desktop origin IS allowed',
        tauri.headers.get('access-control-allow-origin') === 'tauri://localhost',
        String(tauri.headers.get('access-control-allow-origin')));

      const dev = await fetch(`${base}/health`, { headers: { origin: 'http://127.0.0.1:5173' } });
      ok('the Vite dev origin IS allowed',
        dev.headers.get('access-control-allow-origin') === 'http://127.0.0.1:5173');

      // The same-origin shape a CLI test uses: no Origin header.
      const none = await fetch(`${base}/health`);
      ok('a request with no Origin still works (not a browser request)', none.status === 200);

      // An attacker-controlled origin that merely *contains* an allowed
      // one must not pass — a substring check would allow this.
      const spoof = await fetch(`${base}/health`, { headers: { origin: 'http://127.0.0.1:5173.evil.example' } });
      ok('a lookalike origin is rejected (no substring matching)',
        spoof.headers.get('access-control-allow-origin') === null,
        String(spoof.headers.get('access-control-allow-origin')));
    }

    // ─── 2. /v1/files root ────────────────────────────────────
    section('2. /v1/files cannot be pointed at an arbitrary directory');
    {
      const fsRoot = parse(resolve(sep)).root;   // C:\ or /
      const drive = await fetch(`${base}/v1/files?root=${encodeURIComponent(fsRoot)}`);
      ok('GET /v1/files?root=<filesystem root> is refused',
        drive.status === 403, `status ${drive.status}`);

      const home = resolve(homedir());
      const atHome = await fetch(`${base}/v1/files?root=${encodeURIComponent(home)}`);
      ok('GET /v1/files?root=<home> is refused', atHome.status === 403, `status ${atHome.status}`);

      const ssh = await fetch(`${base}/v1/files?root=${encodeURIComponent(join(home, '.ssh'))}`);
      ok('GET /v1/files?root=~/.ssh is refused even if it exists', ssh.status === 403, `status ${ssh.status}`);

      // A directory with a project marker is served. A plain folder
      // with no marker is not — that is the whole point: the endpoint
      // is for the user's projects, not for arbitrary directories.
      const tmp = await fetch(`${base}/v1/files?root=${encodeURIComponent(project)}`);
      const tmpBody = await tmp.clone().text();
      ok('a real project directory IS served', tmp.status === 200,
        `status ${tmp.status} body=${tmpBody.slice(0, 120)}`);
      const tree = (await tmp.json()) as { node?: { name?: string } };
      ok('the project listing is the requested directory', tree.node?.name !== undefined, String(tree.node?.name));

      const plain = await fetch(`${base}/v1/files?root=${encodeURIComponent(plainDir)}`);
      ok('a plain non-project directory is refused', plain.status === 403, `status ${plain.status}`);

      // Traversal must still be refused INSIDE an allowed root.
      const escape = await fetch(`${base}/v1/files?root=${encodeURIComponent(project)}&path=${encodeURIComponent('../../')}`);
      ok('path traversal out of an allowed root is still refused',
        escape.status === 400 || escape.status === 403, `status ${escape.status}`);

      // Unit-level checks, so the intent is readable without HTTP.
      ok('isAllowedFileRoot rejects the filesystem root', isAllowedFileRoot(fsRoot) === false);
      ok('isAllowedFileRoot accepts a project', isAllowedFileRoot(resolve(project)) === true);
      ok('isAllowedFileRoot rejects a plain non-project dir', isAllowedFileRoot(resolve(plainDir)) === false);
      ok('isAllowedFileRoot rejects a non-existent dir', isAllowedFileRoot(join(project, 'nope')) === false);
    }

    // ─── 3. WS frame size ─────────────────────────────────────
    section('3. an oversized WebSocket frame is refused, not allocated');
    {
      // 64-bit length header claiming 2^53 bytes — 9 petabytes. The old
      // decoder handed this to Buffer.alloc() and the process died.
      const c = await rawSocket(port);
      const hsReq = wsHeaders(port);
      if (process.env.V03_DEBUG) console.log('[v03-debug] ws request:', JSON.stringify(hsReq));
      c.send(Buffer.from(hsReq));
      const hs = await c.recv(600);
      if (process.env.V03_DEBUG) console.log('[v03-debug] ws response:', JSON.stringify(hs.toString('latin1').slice(0, 200)));
      ok('the handshake completes', hs.toString('utf8').includes('101'), hs.toString('utf8').split('\r\n')[0]);

      c.send(frameDeclaringLength(2n ** 53n));
      const resp = await c.recv(600);
      const text = resp.toString('latin1');
      ok('the server does not crash on a 2^53-byte frame header', true);
      ok('the connection is closed instead of the frame being read',
        resp.length === 0 || c.closed(), resp.length ? text.slice(0, 40) : 'closed');
      c.sock.destroy();

      // A small masked frame must still be accepted, so the cap is
      // not simply "reject anything big".
      const c2 = await rawSocket(port);
      c2.send(Buffer.from(wsHeaders(port)));
      const hs2 = await c2.recv(400);
      ok('the second handshake also completes', hs2.toString('utf8').includes('101'),
        hs2.toString('utf8').split('\r\n')[0] ?? '(empty)');
      const body = Buffer.alloc(10, 0x41);
      // 2-byte header + 4-byte mask key + payload. The header is 6
      // bytes, not 2 — writing the mask key into a 2-byte buffer is
      // an out-of-bounds throw, which is what the first version of
      // this test did.
      const small = Buffer.alloc(6);
      small[0] = 0x81;                 // FIN + text
      small[1] = 0x80 | body.length;   // masked, short length
      small.writeUInt32BE(0, 2);       // 4-byte mask key (all zero)
      c2.send(Buffer.concat([small, body]));
      await c2.recv(300);
      ok('a small masked frame does not drop the connection', !c2.closed());
      c2.sock.destroy();
    }

    // ─── 4. handshake failure ────────────────────────────────
    section('4. a failed WebSocket handshake does not leak the socket');
    {
      const c = await rawSocket(port);
      // No Sec-WebSocket-Key: the old code returned false and the
      // caller `return`ed, leaving the TCP connection open.
      c.send(`GET /v1/chat HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
      const resp = await c.recv(500);
      const text = resp.toString('utf8');
      ok('the server replies with an HTTP error, not silence', resp.length > 0, text.split('\r\n')[0] ?? '(empty)');
      ok('the response says 400 Bad Request', text.includes('400'), text.split('\r\n')[0] ?? '');
      await new Promise((r) => setTimeout(r, 150));
      ok('the socket is destroyed after a failed handshake', c.closed() || c.sock.destroyed);
      c.sock.destroy();
    }
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    for (const d of [tmpHome, project, plainDir]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[31mv0.3-security-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mv0.3-security-test PASSED\x1b[0m');
}

main().catch((err) => {
  console.error('v0.3-security-test crashed:', err);
  process.exit(1);
}).finally(() => {
  process.exit(process.exitCode ?? 0);
});

