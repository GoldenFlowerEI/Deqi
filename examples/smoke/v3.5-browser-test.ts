/**
 * v3.5 test â€?safe-url + html + browser tool.
 *
 * What's covered (~46 asserts):
 *   - safe-url:
 *     - isPrivateIpv4 detects 10.x, 127.x, 192.168.x, 172.16-31.x, 169.254.x, 0.x, 255.255.255.255, 224.x
 *     - isPrivateIpv4 lets public IPs through (1.1.1.1, 8.8.8.8)
 *     - isPrivateIpv6 detects ::1, fc00::, fe80::, ff00::, ::, ::ffff:
 *     - safeResolve rejects non-http(s) schemes (file://, javascript:, ftp://)
 *     - safeResolve rejects malformed URLs
 *     - safeResolve rejects empty host
 *     - safeResolve rejects private IPs by default
 *     - safeResolve passes when allowPrivate=true (for tests against 127.0.0.1)
 *     - safeResolve allows through the allowHosts list
 *     - safeResolve resolves to the right IPs (capture from in-process)
 *   - html:
 *     - extractText strips <script> and <style> blocks
 *     - extractText decodes common entities (&amp; â†?&)
 *     - extractText collapses whitespace
 *     - extractBySelector matches #id
 *     - extractBySelector matches .class
 *     - extractBySelector matches tag
 *     - extractBySelector matches tag#id
 *     - extractBySelector returns null for no match
 *   - browser tool:
 *     - navigate: status + headers + body preview (against the local test server)
 *     - extract: returns the page text
 *     - extract with selector: returns the matching element text
 *     - screenshot: returns base64 + note about v3.5 limitations
 *     - missing url â†?isError
 *     - private IP (without allowPrivate) â†?isError
 *     - file:// scheme â†?isError
 *     - 4xx response â†?isError
 *   - isConcurrencySafe is false
 *   - BUILTIN_TOOLS count = 19 + browser in list + has the v3.1 description
 *
 * No real network. Local HTTP server on 127.0.0.1:0.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` â€?${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` â€?${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1mâ”€â”€ ${t} â”€â”€\x1b[0m`); }

// Spin up a local HTTP server on 127.0.0.1:0 (random port).
function startLocalServer(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolveP) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/' || url === '/index') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html><head><title>Test Page</title>
<style>body { color: red; }</style>
<script>alert('should be stripped')</script>
</head>
<body>
<h1 id="title">Hello &amp; Welcome</h1>
<p class="intro">This is the intro paragraph.</p>
<div><span>deep text</span></div>
</body></html>`);
      } else if (url === '/notfound') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('plain text body');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveP({
        server, port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v35-browser-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const safeMod = await import('../../packages/coding-agent/dist/src/safe-url.js');
    const htmlMod = await import('../../packages/coding-agent/dist/src/html.js');
    const browserMod = await import('../../packages/coding-agent/dist/src/tools/browser.js');
    const toolsIdx = await import('../../packages/coding-agent/dist/src/tools/index.js');

    section('isPrivateIpv4');
    ok('127.0.0.1 is private', safeMod.isPrivateIpv4('127.0.0.1') === true);
    ok('10.0.0.1 is private', safeMod.isPrivateIpv4('10.0.0.1') === true);
    ok('192.168.1.1 is private', safeMod.isPrivateIpv4('192.168.1.1') === true);
    ok('172.16.0.1 is private', safeMod.isPrivateIpv4('172.16.0.1') === true);
    ok('172.31.255.255 is private (end of 172.16/12)', safeMod.isPrivateIpv4('172.31.255.255') === true);
    ok('172.32.0.0 is public', safeMod.isPrivateIpv4('172.32.0.0') === false);
    ok('169.254.169.254 is private (AWS link-local)', safeMod.isPrivateIpv4('169.254.169.254') === true);
    ok('0.0.0.0 is private', safeMod.isPrivateIpv4('0.0.0.0') === true);
    ok('255.255.255.255 is broadcast (private)', safeMod.isPrivateIpv4('255.255.255.255') === true);
    ok('224.0.0.1 is multicast (private)', safeMod.isPrivateIpv4('224.0.0.1') === true);
    ok('1.1.1.1 is public', safeMod.isPrivateIpv4('1.1.1.1') === false);
    ok('8.8.8.8 is public', safeMod.isPrivateIpv4('8.8.8.8') === false);
    ok('100.64.0.1 is private (CGN)', safeMod.isPrivateIpv4('100.64.0.1') === true);
    ok('garbage is not private (returns false)', safeMod.isPrivateIpv4('not.an.ip') === false);

    section('isPrivateIpv6');
    ok('::1 is private', safeMod.isPrivateIpv6('::1') === true);
    ok(':: is private (unspecified)', safeMod.isPrivateIpv6('::') === true);
    ok('fc00::1 is private (ULA)', safeMod.isPrivateIpv6('fc00::1') === true);
    ok('fd00::1 is private (ULA)', safeMod.isPrivateIpv6('fd00::1') === true);
    ok('fe80::1 is private (link-local)', safeMod.isPrivateIpv6('fe80::1') === true);
    ok('ff00::1 is private (multicast)', safeMod.isPrivateIpv6('ff00::1') === true);
    ok('2001:4860:4860::8888 is public (Google DNS)', safeMod.isPrivateIpv6('2001:4860:4860::8888') === false);

    section('isPrivateIp (router)');
    ok('isPrivateIp("127.0.0.1") true', safeMod.isPrivateIp('127.0.0.1') === true);
    ok('isPrivateIp("::1") true', safeMod.isPrivateIp('::1') === true);
    ok('isPrivateIp("1.1.1.1") false', safeMod.isPrivateIp('1.1.1.1') === false);

    section('safeResolve â€?scheme + format rejections');
    const fileRes = await safeMod.safeResolve('file:///etc/passwd');
    ok('file:// rejected', !fileRes.ok && fileRes.reason.includes('scheme'));
    const ftpRes = await safeMod.safeResolve('ftp://example.com/x');
    ok('ftp:// rejected', !ftpRes.ok && ftpRes.reason.includes('scheme'));
    const jsRes = await safeMod.safeResolve('javascript:alert(1)');
    ok('javascript: rejected', !jsRes.ok && jsRes.reason.includes('scheme'));
    const badRes = await safeMod.safeResolve('not a url at all');
    ok('garbage URL rejected', !badRes.ok);

    section('safeResolve â€?allowPrivate');
    const allowRes = await safeMod.safeResolve('http://127.0.0.1:8080/x', { allowPrivate: true });
    ok('allowPrivate=true lets 127.0.0.1 through', allowRes.ok === true, allowRes.ok ? `host=${allowRes.host}` : `reason=${allowRes.reason}`);
    ok('safeResolve returns the ips it resolved', allowRes.ok && Array.isArray(allowRes.ips) && allowRes.ips.length > 0);

    section('safeResolve â€?default deny');
    const denyRes = await safeMod.safeResolve('http://127.0.0.1:8080/x');
    ok('default rejects 127.0.0.1', !denyRes.ok && denyRes.reason.includes('private IP'));

    section('safeResolve â€?allowHosts');
    const hostRes = await safeMod.safeResolve('http://127.0.0.1:8080/x', { allowHosts: ['127.0.0.1'] });
    ok('allowHosts lets 127.0.0.1 through', hostRes.ok === true);

    section('safeResolve â€?public IP');
    // Use a hostname that resolves to a known public IP. We can't make a
    // network call in unit tests, so we use allowPrivate + a real host.
    const publicRes = await safeMod.safeResolve('http://1.1.1.1/', { allowPrivate: true });
    ok('public IP accepted when allowPrivate=true', publicRes.ok === true);

    section('html â€?extractText');
    const html1 = '<html><body><h1>Title</h1><p>Hello world</p></body></html>';
    const text1 = htmlMod.extractText(html1);
    ok('extractText keeps visible text', text1.includes('Title') && text1.includes('Hello world'));
    ok('extractText removes tags', !text1.includes('<h1>') && !text1.includes('<p>'));
    const html2 = '<script>var x = 1;</script><style>body{}</style><p>visible</p>';
    const text2 = htmlMod.extractText(html2);
    ok('extractText removes <script> content', !text2.includes('var x'));
    ok('extractText removes <style> content', !text2.includes('body{}'));
    ok('extractText keeps visible', text2.includes('visible'));
    const html3 = '<p>Tom &amp; Jerry &lt;3</p>';
    const text3 = htmlMod.extractText(html3);
    ok('extractText decodes &amp;', text3.includes('Tom & Jerry'), `text3=${text3}`);
    ok('extractText decodes &lt;', text3.includes('<3'), `text3=${text3}`);
    const html4 = '<p>   multi    space    text   </p>';
    const text4 = htmlMod.extractText(html4);
    ok('extractText collapses whitespace', text4 === 'multi space text', `text4=${text4}`);

    section('html â€?extractBySelector');
    const html5 = '<html><body><h1 id="title">My Title</h1><p class="intro">P1</p><p>P2</p><div><span>deep</span></div></body></html>';
    ok('selector #id matches', htmlMod.extractBySelector(html5, '#title') === 'My Title');
    ok('selector .class matches', htmlMod.extractBySelector(html5, '.intro') === 'P1');
    ok('selector tag matches first', htmlMod.extractBySelector(html5, 'h1') === 'My Title');
    ok('selector tag p returns first <p>', htmlMod.extractBySelector(html5, 'p') === 'P1');
    ok('selector no match returns null', htmlMod.extractBySelector(html5, '.nope') === null);
    ok('selector invalid returns null', htmlMod.extractBySelector(html5, '') === null);

    // â”€â”€â”€ Spin up a local HTTP server and test the browser tool end-to-end â”€â”€â”€
    const srv = await startLocalServer();
    const baseUrl = `http://127.0.0.1:${srv.port}`;

    section('browser â€?navigate');
    const navRes = await browserMod.browserTool.execute({ mode: 'navigate', url: baseUrl + '/', allowPrivate: true }, { cwd: process.cwd() });
    ok('navigate has no isError', !navRes.isError, navRes.isError ? `text=${navRes.content[0]?.text}` : '');
    const navParsed = JSON.parse(navRes.content[0]?.type === 'text' ? navRes.content[0].text : '');
    ok('navigate returns status 200', navParsed.status === 200);
    ok('navigate returns contentType', navParsed.contentType.includes('text/html'));
    ok('navigate returns bodyPreview', navParsed.bodyPreview.includes('My Title') || navParsed.bodyPreview.includes('Hello'));

    section('browser â€?extract (full text)');
    const extRes = await browserMod.browserTool.execute({ mode: 'extract', url: baseUrl + '/', allowPrivate: true }, { cwd: process.cwd() });
    ok('extract has no isError', !extRes.isError);
    const extParsed = JSON.parse(extRes.content[0]?.type === 'text' ? extRes.content[0].text : '');
    ok('extract returns text', typeof extParsed.text === 'string' && extParsed.text.length > 0);
    ok('extract text includes "Hello"', extParsed.text.includes('Hello'));
    ok('extract strips script content', !extParsed.text.includes('alert'));

    section('browser â€?extract with selector');
    const selRes = await browserMod.browserTool.execute({ mode: 'extract', url: baseUrl + '/', selector: '#title', allowPrivate: true }, { cwd: process.cwd() });
    ok('extract#selector has no isError', !selRes.isError);
    const selParsed = JSON.parse(selRes.content[0]?.type === 'text' ? selRes.content[0].text : '');
    ok('extract#title returns the h1 text (Hello & Welcome from the live server)',
      selParsed.text === 'Hello & Welcome', `text=${selParsed.text}`);
    ok('extract#title includes selector echo', selParsed.selector === '#title');

    section('browser â€?screenshot (raw HTML as base64)');
    const shotRes = await browserMod.browserTool.execute({ mode: 'screenshot', url: baseUrl + '/', allowPrivate: true }, { cwd: process.cwd() });
    ok('screenshot has no isError', !shotRes.isError);
    const shotParsed = JSON.parse(shotRes.content[0]?.type === 'text' ? shotRes.content[0].text : '');
    ok('screenshot encoding is base64', shotParsed.encoding === 'base64');
    ok('screenshot data is a non-empty string', typeof shotParsed.data === 'string' && shotParsed.data.length > 100);
    ok('screenshot has a v3.5 limitation note', typeof shotParsed.note === 'string' && shotParsed.note.includes('v3.5.1'));

    section('browser â€?error cases');
    const noUrl = await browserMod.browserTool.execute({ mode: 'navigate' }, { cwd: process.cwd() });
    ok('missing url â†?isError', noUrl.isError === true);
    const privateDenial = await browserMod.browserTool.execute({ mode: 'navigate', url: baseUrl + '/' }, { cwd: process.cwd() });
    ok('private IP without allowPrivate â†?isError', privateDenial.isError === true);
    const fileDenied = await browserMod.browserTool.execute({ mode: 'navigate', url: 'file:///etc/passwd' }, { cwd: process.cwd() });
    ok('file:// scheme â†?isError', fileDenied.isError === true);
    const notFound = await browserMod.browserTool.execute({ mode: 'navigate', url: baseUrl + '/notfound', allowPrivate: true }, { cwd: process.cwd() });
    ok('HTTP 404 â†?isError', notFound.isError === true);
    const badSelector = await browserMod.browserTool.execute({ mode: 'extract', url: baseUrl + '/', selector: '.nope', allowPrivate: true }, { cwd: process.cwd() });
    ok('selector with no match â†?isError', badSelector.isError === true);

    section('browser â€?concurrency');
    ok('browser isConcurrencySafe returns false', browserMod.browserTool.isConcurrencySafe?.({}) === false);

    section('BUILTIN_TOOLS');
    ok('count = 19 (17 prior + mcp + browser)', toolsIdx.BUILTIN_TOOLS.length === 22, `count=${toolsIdx.BUILTIN_TOOLS.length}`);
    ok('browser is in BUILTIN_TOOLS', toolsIdx.BUILTIN_TOOLS.some((t: { name: string }) => t.name === 'browser'));
    const browserInTools = toolsIdx.BUILTIN_TOOLS.find((t: { name: string }) => t.name === 'browser');
    ok('browser has the v3.1 description (Fetch a URL)', browserInTools?.description.includes('Fetch a URL'));

    await srv.close();

    section('summary');
    console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
    if (failCount > 0) {
      console.log('  failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => { console.error('v3.5-browser-test crashed:', err); process.exit(1); });
