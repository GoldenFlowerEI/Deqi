/**
 * Live deqi-server smoke — connect via WebSocket, send a user
 * message, watch the session_event stream come back.
 *
 * The server uses a custom RFC 6455 codec (not the `ws` npm
 * package), so we implement just enough of the client-side
 * frame codec here to drive one turn.
 *
 * We force the model to `mock` so the run completes without a
 * real LLM API key. The mock model returns a canned
 * "echoed" response so we can see the full event flow.
 */
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';

const HOST = '127.0.0.1';
const PORT = 7700;
const SESSION_ID = 'demo-' + randomBytes(4).toString('hex');

let buffer = Buffer.alloc(0);
let opened = false;

function encodeFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  const maskKey = randomBytes(4);
  // Mask the data: payload[i] ^= maskKey[i % 4]
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i]! ^ maskKey[i % 4]!;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = 0x80 | len; // mask bit set (client→server MUST mask)
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

function decodeFrames(buf: Buffer): { frames: string[]; rest: Buffer } {
  const frames: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 2) break;
    const b1 = buf[offset + 1]!;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let headerLen = 2;
    if (payloadLen === 126) {
      if (buf.length - offset < 4) break;
      payloadLen = buf.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (payloadLen === 127) {
      if (buf.length - offset < 10) break;
      payloadLen = Number(buf.readBigUInt64BE(offset + 2));
      headerLen = 10;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (buf.length - offset < headerLen + 4) break;
      maskKey = buf.subarray(offset + headerLen, offset + headerLen + 4);
      headerLen += 4;
    }
    if (buf.length - offset < headerLen + payloadLen) break;
    const payload = buf.subarray(offset + headerLen, offset + headerLen + payloadLen);
    let text: Buffer;
    if (maskKey) {
      text = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) {
        text[i] = payload[i]! ^ maskKey[i % 4]!;
      }
    } else {
      text = Buffer.from(payload);
    }
    frames.push(text.toString('utf8'));
    offset += headerLen + payloadLen;
  }
  return { frames, rest: buf.subarray(offset) };
}

function send(obj: object): void {
  if (!sock) return;
  sock.write(encodeFrame(JSON.stringify(obj)));
}

const sock = connect(PORT, HOST, () => {
  // WS upgrade handshake
  const key = randomBytes(16).toString('base64');
  sock.write(
    'GET /v1/chat HTTP/1.1\r\n' +
    `Host: ${HOST}:${PORT}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n',
  );
});

sock.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!opened) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const head = buffer.subarray(0, headerEnd).toString('utf8');
    if (!head.includes('101')) {
      console.error('WS handshake failed:', head);
      process.exit(1);
    }
    buffer = buffer.subarray(headerEnd + 4);
    opened = true;
    onOpen();
  }
  if (opened) {
    const { frames, rest } = decodeFrames(buffer);
    buffer = rest;
    for (const f of frames) onFrame(f);
  }
});

sock.on('error', (e) => { console.error('socket error:', e.message); process.exit(1); });
sock.on('close', () => { console.log('\n[socket closed]'); process.exit(0); });

let helloAcked = false;
let turnDone = false;
let msgCount = 0;

function onOpen(): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Deqi live run  —  WebSocket session_event stream');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  session_id : ${SESSION_ID}`);
  console.log(`  ws         : ws://${HOST}:${PORT}/v1/chat`);
  console.log('');
  send({ type: 'hello', protocol: 1 });
}

function startRun(): void {
  // Force the model to `mock` so no real API key is needed
  fetch('http://127.0.0.1:7700/v1/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ default_model: 'mock' }),
  })
    .then((r) => r.json())
    .then((c) => console.log(`config set   default_model=${c.default_model ?? c.model ?? '?'}`))
    .catch((e) => console.error('config set failed:', e.message));

  // Create a session via REST, then send the user message via WS
  fetch('http://127.0.0.1:7700/v1/sessions', { method: 'POST' })
    .then((r) => r.json())
    .then((data: { session: { id: string } }) => {
      const id = data.session.id;
      console.log(`session created   id=${id}\n`);
      // Now send the user message on the new session
      const prompt = 'Hi! Please read the file `package.json` and tell me the version.';
      console.log(`>>> USER (${id}): ${prompt}\n`);
      send({ type: 'user_message', session_id: id, text: prompt });
    })
    .catch((e) => {
      console.error('session create failed:', e.message);
      sock?.end();
    });
}

function onFrame(raw: string): void {
  let msg: { type: string; [k: string]: unknown };
  try { msg = JSON.parse(raw); } catch { return; }
  msgCount += 1;
  const evt = msg['event'] as { type: string; [k: string]: unknown } | undefined;

  if (msg.type === 'hello_ack') {
    if (helloAcked) return; // ignore re-hellos
    helloAcked = true;
    console.log(`[${msgCount}] hello_ack   protocol=${msg['protocol']}  server_version=${msg['server_version']}`);
    startRun();
    return;
  }

  if (msg.type === 'session_event' && evt) {
    const e = evt;
    const head = `[${msgCount}] ${e.type.padEnd(20)}`;
    if (e.type === 'agent_start') {
      console.log(`${head}  model=${e['model']}`);
    } else if (e.type === 'agent_end') {
      const u = e['usage'] as { input: number; output: number; cost_usd?: number };
      console.log(`${head}  input=${u.input}t  output=${u.output}t  cost=$${(u.cost_usd ?? 0).toFixed(4)}`);
    } else if (e.type === 'turn_start') {
      console.log(`${head}  turn=${e['turn']}`);
    } else if (e.type === 'turn_end') {
      console.log(`${head}  stop_reason=${e['stop_reason']}`);
    } else if (e.type === 'text_delta') {
      const d = (e['delta'] as string) ?? '';
      process.stdout.write(d);
    } else if (e.type === 'thinking_delta') {
      // skip
    } else if (e.type === 'tool_start') {
      const input = JSON.stringify(e['input']);
      console.log(`\n${head}  ${e['name']}(${input.length > 80 ? input.slice(0, 77) + '...' : input})`);
    } else if (e.type === 'tool_end') {
      const out = (e['output'] as string) ?? '';
      const preview = out.length > 120 ? out.slice(0, 117) + '...' : out.replace(/\n/g, ' ');
      console.log(`${head}  ${e['is_error'] ? 'ERROR' : 'ok'}  ${(e['duration_ms'] as number).toFixed(0)}ms  ${preview}`);
    } else if (e.type === 'info') {
      console.log(`${head}  [${e['kind']}] ${e['text']}`);
    } else if (e.type === 'reflection') {
      console.log(`${head}  ${(e['note'] as string).slice(0, 100)}`);
    } else if (e.type === 'tokens') {
      const c = e['cumulative'] as { input: number; output: number };
      console.log(`${head}  cumulative input=${c.input}t output=${c.output}t`);
    } else if (e.type === 'permission_request') {
      console.log(`${head}  ${e['tool_name']} (would ask user; auto-allowing for demo)`);
    } else if (e.type === 'permission_resolved') {
      console.log(`${head}  ${e['decision']}`);
    } else {
      console.log(`${head}`);
    }
  } else if (msg.type === 'error') {
    console.log(`[${msgCount}] ERROR  ${msg['message']}`);
  } else {
    console.log(`[${msgCount}] ${msg.type}`);
  }

  if (msg.type === 'session_event' && evt?.type === 'turn_end') {
    turnDone = true;
    setTimeout(() => {
      console.log('\n═══════════════════════════════════════════════════════════════');
      console.log('  turn complete — closing');
      console.log('═══════════════════════════════════════════════════════════════');
      sock?.end();
    }, 800);
  }
}

function finish(): void {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  done — closing');
  console.log('═══════════════════════════════════════════════════════════════');
  sock?.end();
}

// Safety timeout: 30s
setTimeout(() => {
  console.log('\n[timeout] 30s — closing');
  sock?.end();
}, 30_000);
