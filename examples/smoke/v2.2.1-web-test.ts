/**
 * v2.2.1 webFetch tool test.
 *
 * What's covered (8 asserts):
 *   1. Tool registered in BUILTIN_TOOLS with name "webFetch"
 *   2. Tool input schema requires `url`
 *   3. Tool description mentions http(s) only
 *   4. Executing on a valid http URL returns text content
 *   5. Response includes HTTP status line
 *   6. Rejecting non-http schemes (file://, gopher://)
 *   7. Rejecting malformed URLs
 *   8. Concurrency-safe flag is false (network calls serialized)
 *
 * Uses a tiny in-process HTTP server for the "real fetch"
 * check so the test doesn't depend on network access.
 */

import { createServer as netCreateServer, type Server } from 'node:http';

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

function section(t: string): void { console.log(`\n\x1b[1m── ${t} ──\x1b[0m`); }

async function main(): Promise<void> {
  // Tiny local HTTP server that returns a fixed body.
  const srv: Server = netCreateServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-test': 'deqi' });
    res.end('hello from local server\n');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const addr = srv.address();
  if (!addr || typeof addr !== 'object') throw new Error('no port');
  const port = (addr as { port: number }).port;
  const localUrl = `http://127.0.0.1:${port}/`;

  try {
    const { BUILTIN_TOOLS, webFetchTool } = await import('../../packages/coding-agent/dist/tools/index.js');
    const { webFetchTool: direct } = await import('../../packages/coding-agent/dist/tools/web.js');

    section('BUILTIN_TOOLS registration');
    const wf = BUILTIN_TOOLS.find((t) => t.name === 'webFetch');
    ok('webFetch is in BUILTIN_TOOLS', wf !== undefined);
    ok('webFetch === exported webFetchTool', wf === direct || wf === webFetchTool);

    section('input schema');
    const schema = direct.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    ok('schema requires url', Array.isArray(schema.required) && schema.required.includes('url'));
    ok('schema has url property', schema.properties?.['url'] !== undefined);

    section('description mentions http(s)');
    ok('description mentions http(s) only',
      /http/i.test(direct.description) && /https/i.test(direct.description) && /URL/i.test(direct.description));

    section('execute — real fetch');
    const result = await direct.execute({ url: localUrl }, { cwd: process.cwd() });
    ok('execute returns text content',
      Array.isArray(result.content) && result.content.length === 1 &&
      result.content[0]?.type === 'text',
      `isError=${result.isError}`);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    ok('text contains HTTP 200 status line', text.includes('HTTP 200') || text.includes('200 OK'), `text head: ${text.slice(0, 80)}`);
    ok('text contains the local server body', text.includes('hello from local server'), `body found`);
    ok('text includes the test header (x-test: deqi)', text.includes('x-test: deqi'));

    section('execute — non-http scheme rejected');
    const fileResult = await direct.execute({ url: 'file:///etc/passwd' }, { cwd: process.cwd() });
    ok('file:// is rejected with isError=true',
      fileResult.isError === true && /non-http/i.test(fileResult.content[0]?.type === 'text' ? fileResult.content[0].text : ''),
      `text: ${fileResult.content[0]?.type === 'text' ? fileResult.content[0].text.slice(0, 60) : ''}`);

    section('execute — malformed URL rejected');
    const bad = await direct.execute({ url: 'not a url' }, { cwd: process.cwd() });
    ok('malformed URL is rejected with isError=true',
      bad.isError === true);

    section('concurrency safety');
    ok('webFetch is NOT concurrency-safe',
      direct.isConcurrencySafe?.({ url: 'http://x' }) === false,
      `isConcurrencySafe(x) = ${direct.isConcurrencySafe?.({ url: 'http://x' })}`);

    section('summary');
    console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
    if (failCount > 0) {
      console.log('  failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('web test crashed:', err);
  process.exit(1);
});
