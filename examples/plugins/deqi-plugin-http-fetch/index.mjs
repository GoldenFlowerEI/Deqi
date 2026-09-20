// Deqi plugin: deqi-plugin-http-fetch.
//
// Demonstrates v3.10's `network` capability and shows how a
// plugin can enforce a URL allowlist before opening a socket.
// Even with the capability granted, a host NOT in the allowlist
// is blocked at the plugin level (defense in depth — the OS still
// opens a socket, but only for hosts we trust).
//
// Copy to ~/.deqi/plugins/deqi-plugin-http-fetch/ and start the
// server with Deqi_ENABLE_PLUGINS=1 to load it.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ALLOWLIST = [
  'httpbin.org',
  'example.com',
  'jsonplaceholder.typicode.com',
  'api.github.com',
];

function isAllowedHost(url, allowlist) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return allowlist.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

async function safeFetch(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const headers = Object.fromEntries(r.headers.entries());
  const body = await r.text();
  return { status: r.status, headers, body: body.slice(0, 200_000) };
}

export function register(api) {
  // v3.10: load the allowlist from a config the user can edit
  // next to the plugin's index.mjs (allowlist.txt — one hostname
  // per line, # comments OK). Falls back to DEFAULT_ALLOWLIST.
  const here = dirname(fileURLToPath(import.meta.url));
  let allowlist = DEFAULT_ALLOWLIST;
  try {
    const path = join(here, 'allowlist.txt');
    if (existsSync(path)) {
      allowlist = readFileSync(path, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    }
  } catch { /* fall through to default */ }

  api.registerTool({
    name: 'http_get',
    description:
      'Fetch a URL with HTTP GET. The host MUST be in the plugin allowlist ' +
      '(edit allowlist.txt next to the plugin). ' +
      'Returns status code, headers, and the response body (capped at 200KB). ' +
      'Use this to grab a public API response, a JSON document, or HTML for parsing.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch (e.g. https://api.github.com/repos/foo/bar).' },
      },
      required: ['url'],
    },
    async execute(args) {
      api.requireCapability('network');
      const url = String(args?.url ?? '');
      if (!isAllowedHost(url, allowlist)) {
        return {
          error: `host not in allowlist (allowed: ${allowlist.join(', ')})`,
          url,
        };
      }
      try {
        const out = await safeFetch(url);
        return { ok: true, ...out };
      } catch (e) {
        return { error: String((e && e.message) || e), url };
      }
    },
  });

  // ── Route: health check ─────────────────────────────────────────
  api.registerRoute('GET', '/v1/plugin/http-fetch/health', async () => {
    return {
      ok: true,
      plugin: 'deqi-plugin-http-fetch',
      allowlist,
      version: '0.1.0',
    };
  });

  api.log(`deqi-plugin-http-fetch registered: allowlist=[${allowlist.join(', ')}]`);
}
