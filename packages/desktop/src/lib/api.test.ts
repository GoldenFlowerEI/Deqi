/**
 * api.test.ts — DeqiApi REST client. Pure unit tests with a
 * stub global.fetch, so no live server is needed.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DeqiApi } from './api';

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * Inspect what fetch was called with.  Fetch may be called as
 * `fetch(url)` (no init) or `fetch(url, init)`; we tolerate both.
 */
function lastCall(): { url: string; method: string; body?: unknown; headers?: Record<string, string> } {
  const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
  expect(calls.length).toBeGreaterThanOrEqual(1);
  const [url, init] = calls[calls.length - 1];
  return {
    url: String(url),
    method: (init?.method as string) ?? 'GET',
    body: init?.body ? JSON.parse(init.body) : undefined,
    headers: init?.headers,
  };
}

describe('DeqiApi', () => {
  const api = new DeqiApi('http://127.0.0.1:7700');

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /health', async () => {
    (fetch as any).mockResolvedValue(okResponse({ ok: true, version: '0.1.0' }));
    const res = await api.health();
    expect(res).toEqual({ ok: true, version: '0.1.0' });
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/health');
    expect(c.method).toBe('GET');
  });

  it('listSessions encodes the cwd', async () => {
    (fetch as any).mockResolvedValue(okResponse({ sessions: [] }));
    await api.listSessions('/path/with spaces');
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/sessions?cwd=%2Fpath%2Fwith%20spaces');
  });

  it('listSessions without cwd omits the query', async () => {
    (fetch as any).mockResolvedValue(okResponse({ sessions: [] }));
    await api.listSessions();
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/sessions');
  });

  it('createSession POSTs /v1/sessions', async () => {
    (fetch as any).mockResolvedValue(okResponse({ session: { id: 's1' } }));
    await api.createSession();
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/sessions');
    expect(c.method).toBe('POST');
  });

  it('search encodes the query and limit', async () => {
    (fetch as any).mockResolvedValue(okResponse({ query: 'q', results: [] }));
    await api.search('hello world', 25);
    // encodeURIComponent uses %20, not +
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/search?q=hello%20world&limit=25');
  });

  it('patchConfig PATCHes /v1/config with body', async () => {
    (fetch as any).mockResolvedValue(okResponse({ config: {} }));
    await api.patchConfig({ default_model: 'MiniMax-M3' });
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/config');
    expect(c.method).toBe('PATCH');
    expect(c.body).toEqual({ default_model: 'MiniMax-M3' });
    expect(c.headers?.['Content-Type']).toBe('application/json');
  });

  it('putProvider PUTs /v1/config/providers/:name', async () => {
    (fetch as any).mockResolvedValue(okResponse({ config: {} }));
    await api.putProvider('anthropic', { apiKey: 'sk-new' });
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/config/providers/anthropic');
    expect(c.method).toBe('PUT');
    expect(c.body).toEqual({ apiKey: 'sk-new' });
  });

  it('runScheduleNow POSTs /v1/schedule/:id/run', async () => {
    (fetch as any).mockResolvedValue(okResponse({ ok: true }));
    await api.runScheduleNow('sch_abc');
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/schedule/sch_abc/run');
    expect(lastCall().method).toBe('POST');
  });

  it('deleteSchedule DELETEs /v1/schedule/:id', async () => {
    (fetch as any).mockResolvedValue(okResponse({ ok: true }));
    await api.deleteSchedule('sch_abc');
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/schedule/sch_abc');
    expect(lastCall().method).toBe('DELETE');
  });

  it('submitFeedback POSTs /v1/feedback', async () => {
    (fetch as any).mockResolvedValue(okResponse({ ok: true, id: 'fb_1' }));
    await api.submitFeedback({
      clientId: 'cli-1', kind: 'bug', message: 'test', surface: 'rail', appVersion: 'v0.1.0',
    });
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/feedback');
    expect(c.method).toBe('POST');
    expect(c.body).toEqual({
      clientId: 'cli-1', kind: 'bug', message: 'test', surface: 'rail', appVersion: 'v0.1.0',
    });
  });

  it('non-2xx throws Error with status code in the message', async () => {
    (fetch as any).mockResolvedValue(new Response('not found', { status: 404, statusText: 'Not Found' }));
    await expect(api.health()).rejects.toThrow(/404/);
  });

  it('listFiles encodes the path query', async () => {
    (fetch as any).mockResolvedValue(okResponse({ node: {} }));
    await api.listFiles('./src');
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/files?path=.%2Fsrc');
  });

  it('createPair POSTs with deviceName in body', async () => {
    (fetch as any).mockResolvedValue(okResponse({ item: { id: 'p1', code: 'AB-12' } }));
    await api.createPair('iPhone 16');
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/pair');
    expect(c.method).toBe('POST');
    expect(c.body).toEqual({ deviceName: 'iPhone 16' });
  });

  it('listTools is GET /v1/tools', async () => {
    (fetch as any).mockResolvedValue(okResponse({ tools: [] }));
    await api.listTools();
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/tools');
  });

  it('listModels is GET /v1/models', async () => {
    (fetch as any).mockResolvedValue(okResponse({ models: [] }));
    await api.listModels();
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/models');
  });

  it('getSession GETs /v1/sessions/:id', async () => {
    (fetch as any).mockResolvedValue(okResponse({ session: { id: 's1' } }));
    await api.getSession('s1');
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/sessions/s1');
  });

  it('getSessionMessages GETs /v1/sessions/:id/messages', async () => {
    (fetch as any).mockResolvedValue(okResponse({ messages: [] }));
    await api.getSessionMessages('s2');
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/sessions/s2/messages');
  });

  it('getConfig GETs /v1/config', async () => {
    (fetch as any).mockResolvedValue(okResponse({ default_model: 'm', version: 1 }));
    const cfg = await api.getConfig();
    expect(cfg).toEqual({ default_model: 'm', version: 1 });
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/config');
  });

  it('listSchedule GETs /v1/schedule', async () => {
    (fetch as any).mockResolvedValue(okResponse({ items: [] }));
    await api.listSchedule();
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/schedule');
  });

  it('createSchedule POSTs the full input', async () => {
    (fetch as any).mockResolvedValue(okResponse({ item: { id: 'sch_1' } }));
    await api.createSchedule({
      name: 'nightly', prompt: 'audit',
      cadence: 'daily',
      enabled: true,
    });
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/schedule');
    expect(c.method).toBe('POST');
    expect(c.body).toEqual({
      name: 'nightly', prompt: 'audit',
      cadence: 'daily',
      enabled: true,
    });
  });

  it('updateSchedule PATCHes /v1/schedule/:id', async () => {
    (fetch as any).mockResolvedValue(okResponse({ item: { id: 'sch_1' } }));
    await api.updateSchedule('sch_1', { enabled: false });
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/schedule/sch_1');
    expect(c.method).toBe('PATCH');
    expect(c.body).toEqual({ enabled: false });
  });

  it('listPairs GETs /v1/pair', async () => {
    (fetch as any).mockResolvedValue(okResponse({ items: [] }));
    await api.listPairs();
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/pair');
  });

  it('deletePair DELETEs /v1/pair/:id', async () => {
    (fetch as any).mockResolvedValue(okResponse({ ok: true, id: 'p1' }));
    await api.deletePair('p1');
    const c = lastCall();
    expect(c.url).toBe('http://127.0.0.1:7700/v1/pair/p1');
    expect(c.method).toBe('DELETE');
  });

  it('putProvider URL-encodes the provider name', async () => {
    (fetch as any).mockResolvedValue(okResponse({ config: {} }));
    await api.putProvider('openai compat', { baseUrl: 'https://x/v1' });
    expect(lastCall().url).toBe('http://127.0.0.1:7700/v1/config/providers/openai%20compat');
  });
});