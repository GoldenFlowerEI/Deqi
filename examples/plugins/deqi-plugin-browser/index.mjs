// Deqi plugin: deqi-plugin-browser.
//
// Real headless browser via Microsoft Edge's --headless flag.
// No npm deps — just spawnSync the system-installed Edge binary.
//
// Tools:
//   - browser_navigate(url)        → { status, title, body, contentType }
//   - browser_screenshot(url, out) → { path, bytes }  (PNG file)
//
// Safety:
//   - URL allowlist (configurable via allowlist.txt next to the plugin)
//   - 20-second timeout per page
//   - No private/loopback hosts (SSRF protection)
//
// Copy to ~/.deqi/plugins/deqi-plugin-browser/ and start the
// server with Deqi_ENABLE_PLUGINS=1 to load it.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

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
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}

function isPrivateHost(hostname) {
  // Reject loopback, private, link-local, and IPv6 equivalents.
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (hostname.startsWith('10.') || hostname.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  if (hostname.startsWith('169.254.') || hostname.startsWith('fe80:')) return true;
  return false;
}

function isAllowedHost(url, allowlist) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (isPrivateHost(u.hostname)) return false;
    return allowlist.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function loadAllowlist(here) {
  try {
    const path = join(here, 'allowlist.txt');
    if (existsSync(path)) {
      return readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    }
  } catch { /* fall through */ }
  return DEFAULT_ALLOWLIST;
}

function runEdge(args, timeoutMs = 20_000) {
  // Edge's headless mode writes to files (--screenshot, --dump-dom)
  // and exits. spawnSync + timeout is the safe choice.
  return spawnSync(args[0], args.slice(1), {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
    timeout: timeoutMs,
  });
}

export function register(api) {
  const here = dirname(fileURLToPath(import.meta.url));
  const allowlist = loadAllowlist(here);
  const browser = findBrowser();
  if (!browser) {
    api.log('deqi-plugin-browser: NO browser found in well-known paths; tools will return errors');
  } else {
    api.log(`deqi-plugin-browser: using ${browser}`);
  }
  api.log(`deqi-plugin-browser: allowlist=[${allowlist.join(', ')}]`);

  // Screenshot output dir: ~/.deqi/browser-screenshots/
  const shotDir = join(homedir(), '.deqi', 'browser-screenshots');
  try { mkdirSync(shotDir, { recursive: true }); } catch { /* best-effort */ }

  // ── browser_navigate ──────────────────────────────────────────
  api.registerTool({
    name: 'browser_navigate',
    description:
      'Navigate to a URL in a real headless browser and return the rendered ' +
      'DOM (up to 16KB). The host MUST be in the plugin allowlist. ' +
      'Returns status, title, contentType, and the post-render HTML body. ' +
      'For a PNG screenshot, use browser_screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to navigate to.' },
      },
      required: ['url'],
    },
    async execute(args) {
      api.requireCapability('subprocess');
      if (!browser) return { error: 'no system browser found' };
      const url = String(args?.url ?? '');
      if (!isAllowedHost(url, allowlist)) {
        return { error: `host not in allowlist (allowed: ${allowlist.join(', ')})`, url };
      }
      const tmp = join(tmpdir(), `deqi-dom-${Date.now()}.html`);
      try {
        const r = runEdge([
          browser,
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--virtual-time-budget=5000',
          `--dump-dom`,
          url,
        ]);
        if (r.error) return { error: r.error.message };
        if (r.status !== 0) return { error: `edge exited ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
        const html = (r.stdout || '').slice(0, 16_000);
        // Naive title extraction.
        const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
        return {
          ok: true,
          url,
          title: titleMatch ? titleMatch[1] : null,
          contentType: 'text/html',
          body: html,
          bytes: html.length,
        };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      } finally {
        try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* noop */ }
      }
    },
  });

  // ── browser_screenshot ────────────────────────────────────────
  api.registerTool({
    name: 'browser_screenshot',
    description:
      'Take a PNG screenshot of a URL using a real headless browser. ' +
      'The host MUST be in the plugin allowlist. Returns the path of the ' +
      'saved file. Use this when you need to visually inspect a page ' +
      '(e.g. to verify a layout, a chart, or an error dialog).',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to capture.' },
        width: { type: 'number', description: 'Viewport width in pixels (default 1280).' },
        height: { type: 'number', description: 'Viewport height in pixels (default 800).' },
      },
      required: ['url'],
    },
    async execute(args) {
      api.requireCapability('subprocess');
      api.requireCapability('fs:write');
      if (!browser) return { error: 'no system browser found' };
      const url = String(args?.url ?? '');
      if (!isAllowedHost(url, allowlist)) {
        return { error: `host not in allowlist (allowed: ${allowlist.join(', ')})`, url };
      }
      const w = Math.max(320, Math.min(3840, parseInt(String(args?.width ?? 1280), 10) || 1280));
      const h = Math.max(240, Math.min(2160, parseInt(String(args?.height ?? 800), 10) || 800));
      const filename = `screenshot-${Date.now()}.png`;
      const outPath = join(shotDir, filename);
      try {
        const r = runEdge([
          browser,
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--hide-scrollbars',
          `--window-size=${w},${h}`,
          `--screenshot=${outPath}`,
          url,
        ], 25_000);
        if (r.error) return { error: r.error.message };
        if (r.status !== 0) return { error: `edge exited ${r.status}: ${(r.stderr || '').slice(0, 200)}` };
        if (!existsSync(outPath)) return { error: 'screenshot file not created' };
        const st = statSync(outPath);
        return { ok: true, url, path: outPath, bytes: st.size, width: w, height: h };
      } catch (e) {
        return { error: String((e && e.message) || e) };
      }
    },
  });

  // ── Route: health check ────────────────────────────────────────
  api.registerRoute('GET', '/v1/plugin/browser/health', async () => {
    return {
      ok: !!browser,
      plugin: 'deqi-plugin-browser',
      browser: browser || null,
      allowlist,
      version: '0.1.0',
    };
  });

  api.log('deqi-plugin-browser registered: 2 tools, 1 route');
}
