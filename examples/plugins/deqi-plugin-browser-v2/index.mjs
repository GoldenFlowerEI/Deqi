// Deqi plugin: deqi-plugin-browser-v2 (v4.5).
//
// Real headless browser INTERACTION via Chrome DevTools Protocol
// (CDP) over WebSocket. This picks up where the v3.11 plugin left
// off: that one could only screenshot / dump-dom, this one adds
// click, type, wait, and form filling — the 80% of automation
// the model needs.
//
// Architecture:
//   1. LaunchEdge() — spawn msedge with --remote-debugging-port=9222
//   2. Hit http://127.0.0.1:9222/json/version to get the WS URL
//   3. Open a WebSocket, send CDP commands, await responses
//   4. Each tool is a small wrapper around a CDP method call
//
// No npm deps. Uses Node 22's built-in WebSocket.

import { spawn } from 'node:child_process';
import { existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const DEFAULT_ALLOWLIST = [
  'httpbin.org',
  'example.com',
  'jsonplaceholder.typicode.com',
  'api.github.com',
  'github.com',
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

function isPrivateHost(h) {
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (h.startsWith('10.') || h.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (h.startsWith('169.254.') || h.startsWith('fe80:')) return true;
  return false;
}

function isAllowedHost(url, allowlist) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPrivateHost(u.hostname)) return false;
    return allowlist.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

function loadAllowlist(here) {
  try {
    const p = join(here, 'allowlist.txt');
    if (existsSync(p)) {
      return readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    }
  } catch {}
  return DEFAULT_ALLOWLIST;
}

// ─── Minimal CDP client over WebSocket ──────────────────────────

/**
 * Tiny Chrome DevTools Protocol client. Opens a WebSocket to
 * the browser's debug port, sends JSON-RPC commands, awaits
 * responses by id, and exposes a small set of higher-level
 * helpers (navigate / click / type / screenshot).
 */
class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.connected = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP ws error: ' + (e.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  async send(method, params = {}) {
    await this.connected;
    const id = ++this.id;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
  async navigate(url) {
    await this.send('Page.enable');
    return await this.send('Page.navigate', { url });
  }
  async click(selector) {
    await this.send('DOM.enable');
    const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`selector not found: ${selector}`);
    const { model } = await this.send('DOM.getBoxModel', { nodeId });
    const cx = (model.content[0].x + model.content[1].x) / 2;
    const cy = (model.content[0].y + model.content[3].y) / 2;
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    return { clicked: true, x: cx, y: cy, selector };
  }
  async type(text) {
    for (const ch of text) {
      await this.send('Input.insertText', { text: ch });
    }
    return { typed: text.length };
  }
  async waitFor(selector, timeoutMs = 10_000) {
    await this.send('DOM.enable');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const { root } = await this.send('DOM.getDocument', { depth: -1, pierce: true });
        const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (nodeId) return { found: true, selector, waitedMs: Date.now() - start };
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`waitFor timeout: ${selector}`);
  }
  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(data, 'base64');
    if (path) writeFileSync(path, buf);
    return { path, bytes: buf.length };
  }
  async title() {
    const { result } = await this.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    return result.value;
  }
}

function launchEdge(browser, port) {
  const userData = join(homedir(), '.deqi', 'browser-v2-profile');
  try { mkdirSync(userData, { recursive: true }); } catch {}
  const proc = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
    'about:blank',
  ], { stdio: 'ignore' });
  return proc;
}

async function discoverWs(port, maxMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const j = await r.json();
        return j.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('CDP debug port never came up');
}

export function register(api) {
  const here = dirname(fileURLToPath(import.meta.url));
  const allowlist = loadAllowlist(here);
  const browser = findBrowser();
  if (!browser) {
    api.log('deqi-plugin-browser-v2: no system browser found; tools will return errors');
  } else {
    api.log(`deqi-plugin-browser-v2: using ${browser}`);
  }
  api.log(`deqi-plugin-browser-v2: allowlist=[${allowlist.join(', ')}]`);

  const shotDir = join(homedir(), '.deqi', 'browser-screenshots');
  try { mkdirSync(shotDir, { recursive: true }); } catch {}

  let proc = null;
  let cdp = null;
  let port = 0;

  async function ensureBrowser() {
    if (!browser) throw new Error('no system browser found');
    if (cdp) return cdp;
    port = 9222 + Math.floor(Math.random() * 100);
    proc = launchEdge(browser, port);
    proc.on('error', (e) => api.log(`browser process error: ${e.message}`));
    const wsUrl = await discoverWs(port);
    cdp = new CdpClient(wsUrl);
    api.log(`browser CDP up on port ${port}`);
    return cdp;
  }

  api.registerTool({
    name: 'browser_navigate',
    description:
      'Navigate to a URL in a real headless browser. Returns {ok, url, title}. ' +
      'After this call the browser is connected via CDP and ready for ' +
      'browser_click / browser_type / browser_wait / browser_screenshot.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The full URL.' } },
      required: ['url'],
    },
    async execute(args) {
      api.requireCapability('subprocess');
      const url = String(args?.url ?? '');
      if (!isAllowedHost(url, allowlist)) {
        return { error: `host not in allowlist (allowed: ${allowlist.join(', ')})`, url };
      }
      try {
        const c = await ensureBrowser();
        await c.navigate(url);
        await new Promise((r) => setTimeout(r, 500));
        const title = await c.title().catch(() => null);
        return { ok: true, url, title };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },
  });

  api.registerTool({
    name: 'browser_click',
    description:
      'Click an element by CSS selector. Resolves the selector via DOM, ' +
      'finds its bounding box, and dispatches a mousePressed/mouseReleased ' +
      'pair at the center. Returns {clicked, x, y, selector}.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS selector for the element to click.' } },
      required: ['selector'],
    },
    async execute(args) {
      api.requireCapability('subprocess');
      const sel = String(args?.selector ?? '');
      try {
        const c = await ensureBrowser();
        return await c.click(sel);
      } catch (e) {
        return { error: String((e && e.message) || e), selector: sel };
      }
    },
  });

  api.registerTool({
    name: 'browser_type',
    description:
      'Type a string into the focused element via Input.insertText. ' +
      'Click a form field first with browser_click, then call browser_type. ' +
      'Returns {typed, chars}.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The text to type.' } },
      required: ['text'],
    },
    async execute(args) {
      api.requireCapability('subprocess');
      const text = String(args?.text ?? '');
      try {
        const c = await ensureBrowser();
        return await c.type(text);
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },
  });

  api.registerTool({
    name: 'browser_wait',
    description:
      'Wait for a CSS selector to appear in the DOM. Polls every 200ms ' +
      'until the selector matches an element or the timeout (default 10s) ' +
      'is reached. Returns {found, selector, waitedMs}.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in ms. Default 10000.' },
      },
      required: ['selector'],
    },
    async execute(args) {
      api.requireCapability('subprocess');
      const sel = String(args?.selector ?? '');
      const t = parseInt(String(args?.timeoutMs ?? 10000), 10) || 10000;
      try {
        const c = await ensureBrowser();
        return await c.waitFor(sel, t);
      } catch (e) {
        return { error: String((e && e.message) || e), selector: sel };
      }
    },
  });

  api.registerTool({
    name: 'browser_screenshot',
    description:
      'Take a PNG screenshot of the current page via CDP. Returns the path ' +
      'to ~/.deqi/browser-screenshots/screenshot-N.png.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Optional filename suffix.' } },
    },
    async execute(args) {
      api.requireCapability('subprocess');
      api.requireCapability('fs:write');
      const suffix = String(args?.name ?? 'cdp');
      const filename = `screenshot-${suffix}-${Date.now()}.png`;
      const outPath = join(shotDir, filename);
      try {
        const c = await ensureBrowser();
        await c.screenshot(outPath);
        const st = statSync(outPath);
        return { ok: true, path: outPath, bytes: st.size };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },
  });

  api.registerRoute('GET', '/v1/plugin/browser-v2/health', async () => ({
    ok: !!browser,
    plugin: 'deqi-plugin-browser-v2',
    browser: browser || null,
    allowlist,
    cdpConnected: !!cdp,
    port,
    version: '0.1.0',
  }));

  api.log('deqi-plugin-browser-v2 registered: 5 tools, 1 route');
}
