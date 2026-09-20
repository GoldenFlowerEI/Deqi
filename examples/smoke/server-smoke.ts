/**
 * v2.0 smoke test: deqi-server end-to-end over WebSocket.
 *
 * What this covers:
 *   1. Server starts on a random port and accepts HTTP /health
 *   2. WebSocket /v1/chat accepts a `hello` and replies with
 *      `hello_ack`
 *   3. WebSocket `user_message` triggers a full agent turn
 *      against the mock provider, streaming session_event
 *      frames back: agent_start → turn_start → text_delta*
 *      → turn_end → agent_end
 *   4. The session JSONL file ends up on disk with the user
 *      + assistant messages
 *
 * Why this is the integration test for v2.0:
 *   The TUI tests (real-session-test, tui-multiturn-test) used
 *   the same wiring under the hood — they spawned `node deqi.js`
 *   which now becomes `node deqi-server.js` plus a thin client.
 *   v2.0 replaces the TUI entirely; the WebSocket path is the
 *   new "thin client" boundary.
 */

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

// Resolve the repo root from the smoke directory regardless of
// whether we're running under node (no import.meta.dir) or bun.
const SMOKE_DIR = typeof import.meta.dir === 'string'
  ? import.meta.dir
  : process.cwd();
const REPO_ROOT = join(SMOKE_DIR, '..', '..');

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const addr = listener.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        listener.close(() => resolve(port));
      } else {
        listener.close(() => reject(new Error('no port')));
      }
    });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await sleep(100);
  }
  throw new Error(`server did not become ready on port ${port}`);
}

function encodeFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  const header = Buffer.alloc(2);
  header[0] = 0x81;
  header[1] = 0x80 | len;
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) {
    masked[i] = data[i]! ^ mask[i % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

interface DecodedFrame {
  payload: string;
  totalLength: number;
}

function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const b1 = buf[1]!;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    payloadLen = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  if (masked) {
    if (buf.length < offset + 4) return null;
    offset += 4;
  }
  if (buf.length < offset + payloadLen) return null;
  return { payload: buf.subarray(offset, offset + payloadLen).toString('utf8'), totalLength: offset + payloadLen };
}

/**
 * Open a raw WebSocket connection (client→server frames ARE masked
 * per RFC 6455). Implements just enough of the WS protocol to send
 * a couple of text frames and read the streamed responses.
 */
class MiniWs {
  private socket: Socket | null = null;
  private buf = Buffer.alloc(0);
  private handlers: ((m: any) => void)[] = [];
  private oncloseHandlers: (() => void)[] = [];
  private connected = false;
  public readonly port: number;

  constructor(port: number) {
    this.port = port;
  }

  async connect(path: string): Promise<void> {
    // createConnection with {host, port} already starts the
    // connection. We just need to wait for 'connect', then send
    // the WS upgrade request on the same socket.
    this.socket = createConnection({ host: '127.0.0.1', port: this.port });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.socket!.once('error', onError);

      this.socket!.once('connect', () => {
        this.socket!.removeListener('error', onError);
        const key = randomBytes(16).toString('base64');
        this.socket!.write(
          `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${this.port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          `\r\n`,
        );
      });
      this.socket!.once('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (text.includes('101 Switching Protocols')) {
          this.connected = true;
          this.socket!.on('data', (c) => this.onData(c));
          this.socket!.on('close', () => this.oncloseHandlers.forEach((h) => h()));
          resolve();
        } else {
          reject(new Error(`bad upgrade: ${text.slice(0, 100)}`));
        }
      });
    });
  }

  send(msg: unknown): void {
    if (!this.connected) throw new Error('not connected');
    this.socket!.write(encodeFrame(JSON.stringify(msg)));
  }

  recv(timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws recv timeout')), timeoutMs);
      const handler = (m: any) => {
        clearTimeout(timer);
        this.handlers = this.handlers.filter((h) => h !== handler);
        resolve(m);
      };
      this.handlers.push(handler);
    });
  }

  recvAll(timeoutMs = 30_000): Promise<any[]> {
    return new Promise((resolve) => {
      const out: any[] = [];
      const handler = (m: any) => out.push(m);
      this.handlers.push(handler);
      const timer = setTimeout(() => {
        this.handlers = this.handlers.filter((h) => h !== handler);
        resolve(out);
      }, timeoutMs);
    });
  }

  close(): void {
    try { this.socket?.end(); } catch { /* ignore */ }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const frame = decodeFrame(this.buf);
      if (!frame) break;
      this.buf = this.buf.subarray(frame.totalLength);
      try {
        const msg = JSON.parse(frame.payload);
        for (const h of [...this.handlers]) h(msg);
      } catch {
        // ignore malformed
      }
    }
  }
}

async function main(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'deqi-server-smoke-'));
  console.log(`  using temp cwd: ${tmpDir}`);

  // -- 1. Start the server on a random port, in a temp cwd.
  // Point HOME at tmpDir so loadConfig() reads our test config
  // (which forces the mock model — no real LLM key required).
  const fakeHome = join(tmpDir, 'home');
  mkdirSync(join(fakeHome, '.deqi', 'sessions'), { recursive: true });
  const configJson = JSON.stringify({ version: 1, providers: {}, defaultModel: 'mock' }, null, 2);
  writeFileSync(join(fakeHome, '.deqi', 'config.json'), configJson, 'utf8');

  const port = await findFreePort();
  console.log(`  using port: ${port}`);

  const server: ChildProcess = spawn(
    'node',
    [join(REPO_ROOT, 'packages/server/dist/index.js'), '--port', String(port)],
    {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    },
  );
  let serverOut = '';
  server.stdout?.on('data', (b) => { serverOut += b.toString(); });
  server.stderr?.on('data', (b) => { serverOut += b.toString(); });
  // Capture unhandled errors so a stray ECONNRESET during cleanup
  // doesn't fail the test. We still re-throw if the test failed
  // for a real reason (exit code != 0).
  process.on('uncaughtException', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
      // The server was killed before we could drain; benign.
      return;
    }
    console.error('uncaughtException:', err);
    process.exit(1);
  });
  process.on('exit', () => {
    if (process.exitCode === 1) {
      console.error('--- server output ---');
      console.error(serverOut);
    }
  });

  try {
    await waitForServer(port);
    ok('server is ready on /health', true);

    // -- 2. HTTP endpoints.
    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
    const models = (await modelsRes.json()) as { models: Array<{ id: string }> };
    ok('GET /v1/models returns the catalog', models.models.length >= 10, `count=${models.models.length}`);

    const toolsRes = await fetch(`http://127.0.0.1:${port}/v1/tools`);
    const tools = (await toolsRes.json()) as { tools: Array<{ name: string }> };
    const toolNames = tools.tools.map((t) => t.name);
    ok('GET /v1/tools lists 11 built-in tools', toolNames.length === 11, `got ${toolNames.length}: ${toolNames.join(',')}`);

    const configRes = await fetch(`http://127.0.0.1:${port}/v1/config`);
    const config = (await configRes.json()) as { default_model: string };
    ok('GET /v1/config returns default model', typeof config.default_model === 'string', `model=${config.default_model}`);

    // -- 3. Switch to mock model (--demo equivalent) for a deterministic run.
    // We do this by overriding the config and re-loading the server.
    // For simplicity, the test just uses whatever model is configured;
    // with the mock provider always available as a fallback, this works.
    // The runner's runTurn will use it. If the env has no real key, the
    // mock provider is used (see registry.ts).

    // -- 4. WebSocket: open a chat session.
    const ws = new MiniWs(port);
    await ws.connect('/v1/chat');
    const hello = await ws.recv();
    ok('WS handshake → hello_ack', hello.type === 'hello_ack', `type=${hello.type} protocol=${hello.protocol}`);

    // -- 5. Create a session via REST, then send a user_message over WS.
    const createRes = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { method: 'POST' });
    const { session } = (await createRes.json()) as { session: { id: string } };
    ok('POST /v1/sessions creates a session', Boolean(session.id), `id=${session.id}`);

    ws.send({ type: 'user_message', session_id: session.id, text: 'hello' });

    // -- 6. Collect events until we see agent_end.
    const events: any[] = [];
    const start = Date.now();
    while (Date.now() - start < 25_000) {
      const event = await Promise.race([
        ws.recv(5_000),
        sleep(8_000).then(() => null),
      ]);
      if (event === null) break;
      events.push(event);
      if (event.type === 'session_event' && event.event?.type === 'agent_end') break;
    }

    const sessionEvents = events
      .filter((e) => e.type === 'session_event')
      .map((e) => e.event.type);
    ok('WS received session events', sessionEvents.length > 0, `events=${sessionEvents.join(',')}`);
    ok('agent_start fired', sessionEvents.includes('agent_start'));
    ok('turn_start fired', sessionEvents.includes('turn_start'));
    const textDeltas = sessionEvents.filter((t) => t === 'text_delta').length;
    ok('text_delta streamed (>= 1)', textDeltas >= 1, `count=${textDeltas}`);
    ok('agent_end fired', sessionEvents.includes('agent_end'));

    // -- 7. Session JSONL was written.
    const sessDir = join(fakeHome, '.deqi', 'sessions', encodeCwd(tmpDir));
    ok('session dir was created', existsSync(sessDir), `path=${sessDir}`);
    if (existsSync(sessDir)) {
      const files = readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
      const targetFile = files.find((f) => f.startsWith(session.id)) ?? files.sort().pop();
      if (targetFile) {
        const lines = readFileSync(join(sessDir, targetFile), 'utf8').split('\n').filter((l) => l.length > 0);
        const userLines = lines.filter((l) => l.includes('"role":"user"'));
        const asstLines = lines.filter((l) => l.includes('"role":"assistant"'));
        ok('session JSONL has user message', userLines.length >= 1, `count=${userLines.length}`);
        ok('session JSONL has assistant message', asstLines.length >= 1, `count=${asstLines.length}`);
      } else {
        ok('session JSONL exists', false, `no .jsonl files in ${sessDir}`);
      }
    }

    ws.close();
  } finally {
    // Soft-kill the server. The SIGTERM may race with the test
    // process's last writes; we catch the resulting ECONNRESET
    // so it doesn't taint the exit code.
    try {
      server.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        server.once('exit', () => resolve());
        setTimeout(() => {
          try { server.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 1000);
      });
    } catch {
      // server already gone
    }
  }

  console.log(process.exitCode === 1 ? 'SERVER SMOKE FAILED' : 'SERVER SMOKE PASSED');
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\\/g, '-').replace(/:/g, '-').replace(/\//g, '-');
}

main().catch((err) => {
  console.error('server smoke crashed:', err);
  process.exit(1);
});
