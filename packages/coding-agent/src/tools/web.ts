/**
 * webFetch — fetch a URL over HTTP(S) and return the body as text.
 *
 * Why: v2.2.1. The deqi agent had no way to read web content
 * (no curl, no fetch tool). The model would say "I can't
 * browse the internet" and stop. This tool gives the agent
 * a real fetch — it can hit APIs, scrape news sites, read
 * documentation, etc.
 *
 * Safety:
 *   - Only http(s) URLs are accepted (rejects file://, etc.)
 *   - Response is capped at MAX_BYTES (default 200KB) so a
 *     giant page doesn't blow up the context
 *   - Up to 30s timeout; the runner's permission queue handles
 *     the "ask the user before each tool call" UX
 *   - We do NOT parse HTML. The model gets the raw text and
 *     can do its own extraction / summarization. Parsing
 *     belongs in higher-level tools (e.g. a future
 *     `webScrape` with readability-style extraction).
 *
 * Concurrency: `webFetch` is NOT marked concurrency-safe.
 * Network calls can have arbitrary latency, and we don't
 * want to fan out N parallel fetches if the model decides
 * to enumerate a list. Each one is shown to the user in
 * sequence via the permission queue.
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { hashKey, type ToolCache } from '../cache.js';

const MAX_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;
/** v3.6: 5-minute TTL for webFetch cache. The model can override per-call. */
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

export const webFetchTool: AgentTool = {
  name: 'webFetch',
  description:
    'Fetch a URL over HTTP(S) and return the response body as text. Use this to read web pages, call public APIs, or download text content. Only http and https URLs are allowed. The response is capped at 200KB; use offsetBytes / maxBytes for large responses.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Absolute http:// or https:// URL to fetch. Must be a fully-qualified URL.',
      },
      headers: {
        type: 'object',
        description: 'Optional request headers, e.g. { "User-Agent": "...", "Accept": "application/json" }. Values must be strings.',
      },
      maxBytes: {
        type: 'number',
        description: 'Cap the response body at N bytes (default 200000). Truncated responses get a notice in the footer.',
      },
      timeout: {
        type: 'number',
        description: 'Request timeout in ms (default 30000, max 300000).',
      },
    },
    required: ['url'],
  },
  // Network calls are not concurrency-safe — see header note.
  isConcurrencySafe: () => false,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as {
      url?: string;
      headers?: Record<string, string>;
      maxBytes?: number;
      timeout?: number;
      cacheTtlMs?: number;
    };
    if (!a?.url || typeof a.url !== 'string') {
      return { content: [{ type: 'text', text: 'Missing url' }], isError: true };
    }
    let parsed: URL;
    try {
      parsed = new URL(a.url);
    } catch {
      return { content: [{ type: 'text', text: `Invalid URL: ${a.url}` }], isError: true };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        content: [{ type: 'text', text: `Refusing non-http(s) URL: ${parsed.protocol}` }],
        isError: true,
      };
    }
    // v3.6: cache check. Key includes URL + maxBytes (different cap → different cached body).
    const cache = ctx.harness?.cache as ToolCache | undefined;
    const maxBytes = Math.min(Math.max(a.maxBytes ?? MAX_BYTES, 1024), 2_000_000);
    const cacheTtl = a.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cacheKey = cache ? hashKey(['webFetch', parsed.toString(), maxBytes]) : null;
    if (cache && cacheKey) {
      const hit = cache.get(cacheKey);
      if (hit) {
        return {
          content: [{ type: 'text', text: hit }],
          details: { cached: true },
        };
      }
    }
    const timeout = Math.min(Math.max(a.timeout ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        method: 'GET',
        headers: {
          'user-agent': 'deqi/2.2 (desktop; +https://github.com/local/deqi)',
          accept: 'text/html,application/json,text/plain,*/*;q=0.5',
          ...(a.headers ?? {}),
        },
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(timer);
      const cause = (err as Error & { cause?: { code?: string } }).cause;
      const where = cause?.code ? ` (${cause.code})` : '';
      return {
        content: [{ type: 'text', text: `fetch failed${where}: ${(err as Error).message}` }],
        isError: true,
      };
    }
    clearTimeout(timer);
    const elapsedMs = Date.now() - started;
    const statusLine = `HTTP ${res.status} ${res.statusText} (${elapsedMs}ms, ${res.url})`;
    // Read the body as text, capped at maxBytes.
    let body = '';
    let truncated = false;
    try {
      const text = await res.text();
      if (text.length > maxBytes) {
        body = text.slice(0, maxBytes);
        truncated = true;
      } else {
        body = text;
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `${statusLine}\n\nbody read failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
    const footer = truncated
      ? `\n\n[truncated to ${maxBytes} bytes; response was longer]`
      : `\n\n(${body.length} bytes)`;
    const headers = Array.from(res.headers.entries())
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    const out = body.length > 0
      ? `${statusLine}\n${headers}\n\n${body}${footer}`
      : `${statusLine}\n${headers}\n\n(empty body)${footer}`;
    if (cache && cacheKey) {
      cache.set(cacheKey, out, { ttlMs: cacheTtl });
    }
    return {
      content: [{ type: 'text', text: out }],
      details: { cached: false },
    };
  },
};
