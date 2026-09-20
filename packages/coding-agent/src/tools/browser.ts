/**
 * v3.5: browser tool — navigate / extract / screenshot (safe URL fetching).
 *
 * IMPORTANT v3.5 SCOPE LIMITATIONS:
 *   - This is NOT a headless browser. There is no JS execution, no
 *     rendered layout. `screenshot` returns the raw HTML bytes as
 *     base64 with a clearly labeled "no-render" marker. A real
 *     headless browser (Puppeteer/Playwright) is the v3.5.1 path.
 *   - URL safety is enforced via safe-url.ts: only http(s), default
 *     deny private/loopback/link-local/multicast IPs. Pass
 *     `allowPrivate: true` ONLY for testing.
 *
 * Modes (mode param):
 *   - 'navigate'  (default): fetch a URL, return status, headers, content-type, and the first 4KB of body.
 *   - 'extract'   : fetch + extract text. Optional 'selector' param for simple selectors.
 *   - 'screenshot': fetch + return the raw HTML as base64 (NOT a real image).
 *
 * Parameters:
 *   - mode (string, optional, default 'navigate')
 *   - url (string, required for all modes)
 *   - selector (string, optional, only for extract): simple selector (#id, .class, tag, tag#id)
 *   - allowPrivate (boolean, optional, default false): bypass private-IP filter
 *
 * Returns:
 *   - navigate:  { ok, status, headers, contentType, bodyPreview }
 *   - extract:   { ok, text }   (or { ok, text, selector } if selector given)
 *   - screenshot:{ ok, mimeType, encoding, data, note }
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { safeResolve } from '../safe-url.js';
import { extractText, extractBySelector } from '../html.js';

const MAX_BODY_PREVIEW = 4096;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB hard cap

export const browserTool: AgentTool = {
  name: 'browser',
  description: `Fetch a URL and return its content. v3.5 ships a fetch-based implementation (no JS execution, no real layout). For real screenshots, use a headless browser via the MCP browser server (v3.5.1).

URL safety:
  - Only http/https schemes are accepted
  - Private/loopback/link-local/multicast IPs are REJECTED by default
  - Pass allowPrivate=true ONLY for testing against 127.0.0.1

Modes (mode param):
  - 'navigate'  (default): fetch + return status, headers, content-type, and a 4KB body preview
  - 'extract'   : fetch + extract text. Optional 'selector' for simple selectors (#id, .class, tag).
  - 'screenshot': fetch + return the raw HTML as base64 (clearly labeled; NOT a real image in v3.5)

Parameters:
  - mode (string, optional, default 'navigate')
  - url (string, required)
  - selector (string, optional, extract only)
  - allowPrivate (boolean, optional, default false)

Returns:
  - navigate:  { ok, status, headers, contentType, bodyPreview }
  - extract:   { ok, text }
  - screenshot:{ ok, mimeType, encoding, data, note }

When to use:
  - The user gives you a URL to read
  - You need to verify a doc or API
  - You need to extract text from a page (without JS)

When NOT to use:
  - For pages that require login + JS (use a real browser via MCP)
  - For binary downloads (use bash + curl/wget)
  - For internal services (private IPs are blocked)`,

  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['navigate', 'extract', 'screenshot'] },
      url: { type: 'string' },
      selector: { type: 'string' },
      allowPrivate: { type: 'boolean' },
    },
  },
  isConcurrencySafe: () => false,

  async execute(args: unknown, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const a = args as {
      mode?: 'navigate' | 'extract' | 'screenshot';
      url?: string;
      selector?: string;
      allowPrivate?: boolean;
    };
    const mode = a.mode ?? 'navigate';

    if (!a.url) return err('browser tool requires a url');
    if (mode === 'extract' && a.selector !== undefined && typeof a.selector !== 'string') {
      return err('selector must be a string');
    }

    const resolved = await safeResolve(a.url, { allowPrivate: a.allowPrivate ?? false });
    if (!resolved.ok) return err(`url rejected: ${resolved.reason}`);

    let response: Response;
    try {
      response = await fetch(resolved.url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return err(`fetch failed: ${(e as Error).message}`);
    }
    if (!response.ok) return err(`HTTP ${response.status} ${response.statusText}`);

    const contentType = response.headers.get('content-type') ?? '';
    if (mode === 'navigate') {
      const buf = new Uint8Array(Math.min(MAX_BODY_PREVIEW, MAX_BYTES));
      const reader = response.body?.getReader();
      let read = 0;
      if (reader) {
        while (read < buf.length) {
          const { value, done } = await reader.read();
          if (done || !value) break;
          const take = Math.min(value.length, buf.length - read);
          buf.set(value.subarray(0, take), read);
          read += take;
          if (read >= buf.length) break;
        }
        reader.cancel?.();
      }
      const preview = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, read));
      return ok({
        ok: true,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        contentType,
        bodyPreview: preview,
      });
    }

    if (mode === 'extract') {
      const text = await response.text();
      if (a.selector) {
        const found = extractBySelector(text, a.selector);
        if (found === null) return err(`selector "${a.selector}" did not match anything`);
        return ok({ ok: true, text: found, selector: a.selector });
      }
      return ok({ ok: true, text: extractText(text) });
    }

    if (mode === 'screenshot') {
      const text = await response.text();
      const data = Buffer.from(text, 'utf-8').toString('base64');
      return ok({
        ok: true,
        mimeType: contentType.split(';')[0] || 'text/html',
        encoding: 'base64',
        data,
        note: 'v3.5 ships raw-HTML-as-base64 (no JS, no layout). A real headless browser screenshot lands in v3.5.1.',
        bytes: text.length,
      });
    }

    return err(`unknown mode: ${mode}`);
  },
};

function ok(data: unknown): ToolExecutionResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string): ToolExecutionResult {
  return { content: [{ type: 'text', text: msg }], isError: true };
}
