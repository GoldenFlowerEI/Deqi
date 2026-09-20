/**
 * v3.7 test — tool reflection.
 *
 * What's covered (~15 asserts):
 *   - reflectOnTool returns null for successful small results
 *   - reflectOnTool returns null for non-empty small successes
 *   - reflectOnTool returns a hint for error results (generic)
 *   - reflectOnTool returns a specific hint for HTTP 4xx/5xx
 *   - reflectOnTool returns a specific hint for "File not found" (read)
 *   - reflectOnTool returns a specific hint for "no matches" (grep)
 *   - reflectOnTool returns a specific hint for "command not found" (bash)
 *   - reflectOnTool returns a "large result" hint for >10KB outputs
 *   - reflection.hint is a string
 *   - reflection.kind is 'error' | 'empty' | 'large' | null
 *   - reflection.isError mirrors the result.isError
 *   - reflection.toolName echoes the input
 *   - All patterns are tested
 *
 * No LLM, no real network.
 */

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1m── ${t} ──\x1b[0m`); }

function mkResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text }], isError };
}

async function main(): Promise<void> {
  const reflMod = await import('../../packages/coding-agent/dist/src/reflection.js') as unknown as {
    reflectOnTool: (name: string, input: unknown, result: { content: Array<{ type: string; text?: string }>; isError?: boolean }) => {
      hint: string | null;
      kind: 'error' | 'empty' | 'large' | null;
      toolName: string;
      isError: boolean;
    };
  };

  section('successful results → null hint');
  ok('read: small success → no hint', reflMod.reflectOnTool('read', {}, mkResult('line 1\nline 2\n\n(2 lines total)')).hint === null);
  ok('grep: matches found → no hint', reflMod.reflectOnTool('grep', {}, mkResult('src/foo.ts:1:hello world\nsrc/bar.ts:5:hello again')).hint === null);
  ok('bash: success → no hint', reflMod.reflectOnTool('bash', {}, mkResult('hello\n')).hint === null);
  ok('webFetch: success → no hint', reflMod.reflectOnTool('webFetch', {}, mkResult('HTTP 200 OK (45ms)\n...content...')).hint === null);

  section('error results → hint');
  {
    const r = reflMod.reflectOnTool('bash', {}, mkResult('ls: cannot access /no/such: No such file or directory', true));
    ok('bash: error → non-null hint', r.hint !== null);
    ok('bash: error kind = "error"', r.kind === 'error');
    ok('bash: error isError = true', r.isError === true);
  }
  {
    const r = reflMod.reflectOnTool('webFetch', {}, mkResult('HTTP 404 Not Found', true));
    ok('webFetch: HTTP 404 → specific hint', r.hint !== null && r.hint.includes('404'));
    ok('webFetch: HTTP 404 kind = "error"', r.kind === 'error');
  }
  {
    const r = reflMod.reflectOnTool('read', {}, mkResult('File not found: /x.ts', true));
    ok('read: File not found → specific hint', r.hint !== null && r.hint.includes('glob'));
    ok('read: File not found kind = "error"', r.kind === 'error');
  }
  {
    const r = reflMod.reflectOnTool('bash', {}, mkResult('command not found: foo', true));
    ok('bash: command not found → specific hint', r.hint !== null && r.hint.includes('PATH'));
  }
  {
    const r = reflMod.reflectOnTool('read', {}, mkResult('Tool "read" threw: bad path', true));
    ok('generic throw → hint', r.hint !== null);
    ok('generic throw kind = "error"', r.kind === 'error');
  }
  {
    const r = reflMod.reflectOnTool('bash', {}, mkResult('fetch failed: ENOTFOUND', true));
    ok('fetch failed → hint mentions network', r.hint !== null && r.hint.toLowerCase().includes('network'));
  }
  {
    const r = reflMod.reflectOnTool('bash', {}, mkResult('Operation timed out after 30s', true));
    ok('timeout → hint mentions timeout', r.hint !== null && r.hint.toLowerCase().includes('timeout'));
  }

  section('empty results → hint');
  {
    const r = reflMod.reflectOnTool('grep', {}, mkResult('no matches found for "foo"', false));
    ok('grep: no matches → "empty" hint', r.hint !== null && r.kind === 'empty');
  }
  {
    const r = reflMod.reflectOnTool('glob', {}, mkResult('no files matched', false));
    ok('glob: no files → "empty" hint', r.hint !== null && r.kind === 'empty');
  }
  {
    const r = reflMod.reflectOnTool('read', {}, mkResult('Refusing to read outside cwd: /etc/passwd', true));
    ok('read: outside cwd → hint', r.hint !== null && r.hint.includes('relative'));
  }

  section('large results → hint');
  {
    const big = 'x'.repeat(15_000);
    const r = reflMod.reflectOnTool('read', {}, mkResult(big, false));
    ok('read: 15KB → "large" hint', r.hint !== null && r.kind === 'large');
    ok('read: 15KB hint mentions offset/limit', r.hint!.includes('offset/limit'));
  }

  section('reflection shape');
  {
    const r = reflMod.reflectOnTool('bash', {}, mkResult('any', true));
    ok('reflection.toolName echoes input', r.toolName === 'bash');
    ok('reflection.isError mirrors result', r.isError === true);
  }

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => { console.error('v3.7-reflection-test crashed:', err); process.exit(1); });
