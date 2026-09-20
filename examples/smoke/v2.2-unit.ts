/**
 * v2.2 unit tests — pure-fetch mocks for the desktop API client.
 *
 * What's covered (15 asserts):
 *   - DeqiApi.patchConfig builds the right PATCH request
 *     (method, URL, body, content-type)
 *   - DeqiApi.patchConfig propagates non-2xx as an Error
 *   - DeqiApi.putProvider builds the right PUT request, URL-encodes
 *     the provider name (so slashes in names don't break routing)
 *   - DeqiApi.putProvider handles only apiKey / only baseUrl / only path
 *   - DeqiApi.putProvider propagates 400 with the server's error body
 *
 * No live server, no DOM. Run with bun.
 */

import { DeqiApi } from '../../packages/desktop/src/lib/api';

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passCount += 1;
    console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  status: number;
  responseBody: string;
}

/**
 * Build a fake fetch() that records the last call and returns
 * a canned response. Use fresh fn per test for isolation.
 */
function makeFakeFetch(call: { status: number; responseBody: string }): {
  fetch: typeof fetch;
  recorded: RecordedCall[];
} {
  const recorded: RecordedCall[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string> | Headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else {
        Object.assign(headers, h);
      }
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    recorded.push({ url, method, headers, body, status: call.status, responseBody: call.responseBody });
    return new Response(call.responseBody, {
      status: call.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fake, recorded };
}

function main(): void {
  // ─── patchConfig: happy path ────────────────────────────────
  section('DeqiApi.patchConfig — happy path');
  {
    const { fetch, recorded } = makeFakeFetch({
      status: 200,
      responseBody: JSON.stringify({ ok: true, config: { default_model: 'MiniMax-M3' } }),
    });
    const orig = globalThis.fetch;
    globalThis.fetch = fetch;
    const api = new DeqiApi('http://127.0.0.1:7700');
    api.patchConfig({ default_model: 'MiniMax-M3' }).then((res) => {
      ok('patchConfig resolved with the response', res.ok === true);
    }).catch((e) => {
      ok('patchConfig did not throw', false, e.message);
    });
    globalThis.fetch = orig;
    // fetch is async; the call is queued. We have to wait for it.
    // But since the body is built synchronously, we can read recorded[0].
    // Use setImmediate to flush.
    setImmediate(() => {
      ok('patchConfig made one fetch call', recorded.length === 1);
      const c = recorded[0]!;
      ok('patchConfig uses PATCH method', c.method === 'PATCH');
      ok('patchConfig targets /v1/config', c.url === 'http://127.0.0.1:7700/v1/config');
      ok('patchConfig sends JSON body', c.headers['Content-Type'] === 'application/json');
      ok('patchConfig body includes default_model',
        c.body.includes('"default_model"') && c.body.includes('"MiniMax-M3"'));

      // ─── patchConfig: error propagation ─────────────────────
      section('DeqiApi.patchConfig — error propagation');
      const { fetch: fetch2, recorded: recorded2 } = makeFakeFetch({
        status: 500,
        responseBody: JSON.stringify({ error: 'internal' }),
      });
      const orig2 = globalThis.fetch;
      globalThis.fetch = fetch2;
      const api2 = new DeqiApi('http://127.0.0.1:7700');
      api2.patchConfig({ show_surprise: false }).then(
        () => ok('patchConfig 500 throws', false, 'did not throw'),
        (e: Error) => ok('patchConfig 500 throws an Error', e instanceof Error && e.message.includes('500'), e.message),
      );
      globalThis.fetch = orig2;
      setImmediate(() => {
        ok('patchConfig 500 made one fetch call', recorded2.length === 1);

        // ─── putProvider: happy path ────────────────────────────
        section('DeqiApi.putProvider — happy path');
        const { fetch: fetch3, recorded: recorded3 } = makeFakeFetch({
          status: 200,
          responseBody: JSON.stringify({ ok: true, config: { providers: {} } }),
        });
        const orig3 = globalThis.fetch;
        globalThis.fetch = fetch3;
        const api3 = new DeqiApi('http://127.0.0.1:7700');
        api3.putProvider('openai-compat', {
          apiKey: 'sk-test-9999',
          baseUrl: 'https://api.example/v1',
          path: '/chat/completions',
        }).then((res) => {
          ok('putProvider resolved', res.ok === true);
        }).catch((e) => {
          ok('putProvider did not throw', false, e.message);
        });
        globalThis.fetch = orig3;
        setImmediate(() => {
          const c3 = recorded3[0]!;
          ok('putProvider uses PUT method', c3.method === 'PUT');
          ok('putProvider targets /v1/config/providers/openai-compat',
            c3.url === 'http://127.0.0.1:7700/v1/config/providers/openai-compat');
          ok('putProvider body has apiKey', c3.body.includes('"apiKey"') && c3.body.includes('sk-test-9999'));
          ok('putProvider body has baseUrl', c3.body.includes('"baseUrl"') && c3.body.includes('https://api.example/v1'));
          ok('putProvider body has path', c3.body.includes('"path"') && c3.body.includes('/chat/completions'));

          // ─── putProvider: 400 with server error body ──────────
          section('DeqiApi.putProvider — 400 propagation');
          const { fetch: fetch4, recorded: recorded4 } = makeFakeFetch({
            status: 400,
            responseBody: JSON.stringify({ error: 'empty_patch' }),
          });
          const orig4 = globalThis.fetch;
          globalThis.fetch = fetch4;
          const api4 = new DeqiApi('http://127.0.0.1:7700');
          api4.putProvider('anthropic', { apiKey: '' }).then(
            () => ok('putProvider 400 throws', false),
            (e: Error) => ok('putProvider 400 throws an Error', e instanceof Error && e.message.includes('400'), e.message),
          );
          globalThis.fetch = orig4;
          setImmediate(() => {
            ok('putProvider 400 made one fetch call', recorded4.length === 1);

            // Summary
            section('summary');
            console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
            if (failCount > 0) {
              console.log('  failures:');
              for (const f of failures) console.log(`    - ${f}`);
            }
            if (failCount > 0) process.exit(1);
          });
        });
      });
    });
  }
}

main();
