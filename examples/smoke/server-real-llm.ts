/**
 * v2.0-alpha real-LLM smoke: deqi-server end-to-end against the
 * user's actual provider (M3 by default). Complements the
 * server-smoke.ts which uses the mock provider.
 *
 * Run: bun run server-real-llm.ts
 *
 * Skips itself if no provider key is configured (so it's safe
 * to include in `all` without breaking the mock-only path).
 */

import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';

const REPO_ROOT = join(
  typeof import.meta.dir === 'string' ? import.meta.dir : process.cwd(),
  '..', '..',
);

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

function decodeFrame(buf: Buffer): { payload: string; totalLength: number } | null {
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
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    if (buf.length < offset + payloadLen) return null;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i += 1) {
      payload[i] = buf[offset + i]! ^ mask[i % 4]!;
    }
    return { payload: payload.toString('utf8'), totalLength: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return { payload: buf.subarray(offset, offset + payloadLen).toString('utf8'), totalLength: offset + payloadLen };
}

class MiniWs {
  private socket: Socket | null = null;
  private buf = Buffer.alloc(0);
  private handlers: ((m: any) => void)[] = [];
  /** Queue for messages that arrived before a recv() was called. */
  private queue: any[] = [];
  public readonly port: number;
  constructor(port: number) { this.port = port; }

  async connect(path: string): Promise<void> {
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
          this.socket!.on('data', (c) => this.onData(c));
          resolve();
        } else {
          reject(new Error(`bad upgrade: ${text.slice(0, 100)}`));
        }
      });
    });
  }

  send(msg: unknown): void {
    if (!this.socket) throw new Error('not connected');
    this.socket.write(encodeFrame(JSON.stringify(msg)));
  }

  recv(timeoutMs = 30_000): Promise<any> {
    // If a message is already buffered (arrived before this call),
    // return it immediately. This avoids the race where the
    // server emits events faster than the test can register
    // a handler.
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers = this.handlers.filter((h) => h !== handler);
        reject(new Error('ws recv timeout'));
      }, timeoutMs);
      const handler = (m: any) => {
        clearTimeout(timer);
        this.handlers = this.handlers.filter((h) => h !== handler);
        resolve(m);
      };
      this.handlers.push(handler);
    });
  }

  close(): void { try { this.socket?.end(); } catch { /* ignore */ } }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const frame = decodeFrame(this.buf);
      if (!frame) break;
      this.buf = this.buf.subarray(frame.totalLength);
      try {
        const msg = JSON.parse(frame.payload);
        if (this.handlers.length > 0) {
          // Hand off to the first waiting handler.
          const h = this.handlers.shift()!;
          h(msg);
        } else {
          // No handler yet — queue.
          this.queue.push(msg);
        }
      } catch { /* ignore */ }
    }
  }
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/\\/g, '-').replace(/:/g, '-').replace(/\//g, '-');
}

async function main(): Promise<void> {
  // -- 0. Load the user's real config from ~/.deqi/config.json.
  //    This test is skipped if no provider key is configured.
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const userCfgPath = join(home, '.deqi', 'config.json');
  if (!existsSync(userCfgPath)) {
    console.log('  SKIP: no ~/.deqi/config.json (no real key configured)');
    return;
  }
  let userCfg: any;
  try {
    userCfg = JSON.parse(readFileSync(userCfgPath, 'utf8'));
  } catch (err) {
    console.log(`  SKIP: bad config.json: ${(err as Error).message}`);
    return;
  }
  const hasKey = userCfg?.providers?.['openai-compat']?.apiKey
    || userCfg?.providers?.anthropic?.apiKey
    || userCfg?.providers?.openai?.apiKey
    || userCfg?.providers?.google?.apiKey;
  if (!hasKey) {
    console.log('  SKIP: no provider API key in ~/.deqi/config.json');
    return;
  }
  ok('real provider key found in ~/.deqi/config.json', true, `model=${userCfg.defaultModel ?? 'unset'}`);

  // -- 1. Start the server with HOME pointing at the user's real config.
  const tmpDir = mkdtempSync(join(tmpdir(), 'deqi-server-real-llm-'));
  console.log(`  using temp cwd: ${tmpDir}`);

  const port = await findFreePort();
  console.log(`  using port: ${port}`);

  const server: ChildProcess = spawn(
    'node',
    [join(REPO_ROOT, 'packages/server/dist/index.js'), '--port', String(port)],
    {
      cwd: tmpDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home },
    },
  );
  let serverOut = '';
  server.stdout?.on('data', (b) => { serverOut += b.toString(); });
  server.stderr?.on('data', (b) => { serverOut += b.toString(); });

  // Periodic dump so we can see what the server was doing before
  // a crash. Without this, the test process exits with a
  // timeout error and the server's stdout is lost.
  const dumpInterval = setInterval(() => {
    if (serverOut.length > 0) {
      process.stderr.write(`--- server output so far ---\n${serverOut}\n--- end ---\n`);
    }
  }, 2000);

  process.on('uncaughtException', (err) => {
    clearInterval(dumpInterval);
    if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
    console.error('uncaughtException:', err);
    console.error('--- server output ---');
    console.error(serverOut);
    process.exit(1);
  });

  try {
    await waitForServer(port);
    ok('server is ready on /health', true);

    // -- 2. Open a WebSocket and send a user_message against the
    //    real provider. The mock provider also accepts arbitrary
    //    text, so this test is meaningful only when the configured
    //    model is NOT mock.
    const ws = new MiniWs(port);
    await ws.connect('/v1/chat');
    await ws.recv(); // hello_ack
    ok('WS handshake → hello_ack', true);

    const createRes = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { method: 'POST' });
    const { session } = (await createRes.json()) as { session: { id: string } };
    ok('session created', Boolean(session.id), `id=${session.id}`);

    // -- 3. Real LLM call. M3 should answer "ping" with something
    //    that contains "pong" (the model's standard mock answer is
    //    also a no-op, so we use a different probe to distinguish).
    ws.send({ type: 'user_message', session_id: session.id, text: 'Reply with the single word: pong' });
    process.stderr.write(`[test] sent user_message at ${Date.now()}\n`);

    const events: any[] = [];
    const start = Date.now();
    while (Date.now() - start < 90_000) {
      const event = await Promise.race([
        ws.recv(30_000).then((m) => {
          process.stderr.write(`[test] recv at +${Date.now() - start}ms: ${m.type}${m.event ? '.' + m.event.type : ''} ${m.event?.text ? JSON.stringify(m.event.text).slice(0, 200) : ''}\n`);
          return m;
        }),
        sleep(35_000).then(() => null),
      ]);
      if (event === null) break;
      events.push(event);
      if (event.type === 'session_event' && event.event?.type === 'agent_end') break;
    }
    process.stderr.write(`[test] loop ended, events=${events.length}\n`);

    const sessionEvents = events
      .filter((e) => e.type === 'session_event')
      .map((e) => e.event.type);
    ok('events streamed', sessionEvents.length > 0, `events=${sessionEvents.join(',')}`);
    ok('agent_end fired', sessionEvents.includes('agent_end'));

    // -- 4. Verify the model actually said "pong" (not just echoed).
    const assistantText = sessionEvents
      .filter((t) => t === 'text_delta')
      .join(''); // would be a bug to count text_deltas as one
    // text_delta events are individual chunks, so we need to sum.
    // We can't reconstruct text here from event types alone;
    // we do it via the session JSONL after the turn completes.

    // Wait for the WS handler to flush.
    await sleep(500);

    // -- 5. Session JSONL has the assistant's response.
    const sessDir = join(home, '.deqi', 'sessions', encodeCwd(tmpDir));
    if (existsSync(sessDir)) {
      const files = readdirSync(sessDir).filter((f) => f.endsWith('.jsonl'));
      const target = files.find((f) => f.startsWith(session.id)) ?? files.sort().pop();
      if (target) {
        const lines = readFileSync(join(sessDir, target), 'utf8').split('\n').filter((l) => l.length > 0);
        const asst = lines.find((l) => l.includes('"role":"assistant"'));
        ok('session JSONL has assistant message', Boolean(asst), `file=${target}`);
        if (asst) {
          const hasPong = /pong/i.test(asst);
          ok('real LLM replied with "pong"', hasPong, `tail=${asst.slice(-200)}`);
        }
      }
    }

    ws.close();
  } finally {
    clearInterval(dumpInterval);
    try {
      server.kill('SIGTERM');
      await new Promise<void>((r) => {
        server.once('exit', () => r());
        setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* ignore */ } r(); }, 1000);
      });
    } catch { /* ignore */ }
  }

  if (process.exitCode === 1) {
    console.error('--- server output ---');
    console.error(serverOut);
  }

  console.log(process.exitCode === 1 ? 'SERVER REAL LLM FAILED' : 'SERVER REAL LLM PASSED');
}

main().catch((err) => {
  console.error('server-real-llm crashed:', err);
  process.exit(1);
});
