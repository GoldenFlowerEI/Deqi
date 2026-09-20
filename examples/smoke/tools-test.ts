/**
 * Smoke test for the 6 built-in tools.
 *
 * Each tool is exercised against a real temp directory; the test asserts
 * that each one produces the expected kind of result.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
} from '@deqi/coding-agent/tools';
import type { ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';

const ctx: ToolExecutionContext = {
  cwd: '',
  signal: new AbortController().signal,
  messages: [],
  log: () => {},
};

function check(name: string, ok: boolean, detail?: string): void {
  const tag = ok ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

function unwrap(r: ToolExecutionResult): string {
  return r.content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deqi-tools-'));
  ctx.cwd = dir;
  console.log(`tools smoke test — cwd: ${dir}`);

  // Setup.
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(
    join(dir, 'b.ts'),
    'export const b = 2;\nexport const c = 3;\n',
    'utf8',
  );
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'c.txt'), 'hello world\n', 'utf8');

  // 1. read
  {
    const r = await readTool.execute({ path: 'a.ts' }, ctx);
    const text = unwrap(r);
    check('read returns file content', text.includes('export const a'));
    check('read is not error', r.isError !== true);
  }

  // 2. read with offset
  {
    const r = await readTool.execute({ path: 'b.ts', offset: 2, limit: 1 }, ctx);
    const text = unwrap(r);
    check('read with offset', text.includes('export const c'));
  }

  // 3. write (create new file)
  {
    const r = await writeTool.execute(
      { path: 'new.txt', content: 'fresh\n' },
      ctx,
    );
    check('write creates file', readFileSync(join(dir, 'new.txt'), 'utf8') === 'fresh\n');
    check('write returns no error', r.isError !== true);
  }

  // 4. write (overwrite)
  {
    await writeTool.execute({ path: 'a.ts', content: 'overwritten\n' }, ctx);
    check(
      'write overwrites',
      readFileSync(join(dir, 'a.ts'), 'utf8') === 'overwritten\n',
    );
  }

  // 5. edit (single match)
  {
    const r = await editTool.execute(
      {
        path: 'b.ts',
        oldText: 'export const c = 3;',
        newText: 'export const c = 99;',
      },
      ctx,
    );
    check(
      'edit replaces single match',
      readFileSync(join(dir, 'b.ts'), 'utf8').includes('export const c = 99'),
    );
    check('edit returns no error', r.isError !== true);
  }

  // 6. edit (zero matches -> error)
  {
    const r = await editTool.execute(
      { path: 'b.ts', oldText: 'NOT_FOUND', newText: 'whatever' },
      ctx,
    );
    check('edit reports zero match', r.isError === true);
  }

  // 7. edit (multiple matches -> error)
  {
    const r = await editTool.execute(
      { path: 'b.ts', oldText: 'export', newText: 'EXPORT' },
      ctx,
    );
    check('edit reports multiple match', r.isError === true);
  }

  // 8. bash (read-only)
  {
    const r = await bashTool.execute(
      { command: 'ls', description: 'list files' },
      ctx,
    );
    const text = unwrap(r);
    check('bash runs and lists files', text.includes('a.ts'));
    check('bash is concurrency-safe for ls', bashTool.isConcurrencySafe?.({ command: 'ls' }) === true);
  }

  // 9. bash (write command is NOT concurrency-safe)
  {
    check(
      'bash write command is sequential',
      bashTool.isConcurrencySafe?.({ command: 'rm something' }) === false,
    );
  }

  // 10. bash timeout works
  {
    const r = await bashTool.execute(
      { command: 'echo done' },
      ctx,
    );
    check('bash echo ok', r.isError !== true);
  }

  // 11. grep with rg fallback
  {
    const r = await grepTool.execute(
      { pattern: 'hello', path: dir },
      ctx,
    );
    const text = unwrap(r);
    check('grep finds hello', text.includes('hello world'));
  }

  // 12. grep no match
  {
    const r = await grepTool.execute(
      { pattern: 'NEVER_MATCHES_12345', path: dir },
      ctx,
    );
    const text = unwrap(r);
    check('grep reports no match', text.includes('no matches') || text === '');
  }

  // 13. grep with include glob
  {
    const r = await grepTool.execute(
      { pattern: 'export', path: dir, include: '*.ts' },
      ctx,
    );
    const text = unwrap(r);
    check('grep with include glob', text.includes('export'));
  }

  // 14. glob
  {
    const r = await globTool.execute({ pattern: '**/*.ts', path: dir }, ctx);
    const text = unwrap(r);
    const lines = text.split('\n').filter(Boolean);
    check('glob finds .ts files', lines.length >= 2);
  }

  // 15. glob no match
  {
    const r = await globTool.execute(
      { pattern: '**/*.NEVER', path: dir },
      ctx,
    );
    const text = unwrap(r);
    check('glob no match', text.includes('no matches') || text === '');
  }

  // 16. path-safety: ref uses to read outside cwd
  {
    const r = await readTool.execute({ path: '..' + sep + '..' + sep + 'etc' + sep + 'passwd' }, ctx);
    check('read refuses outside cwd', r.isError === true);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(process.exitCode === 1 ? 'TOOLS SMOKE FAILED' : 'TOOLS SMOKE PASSED');
}

main().catch((err) => {
  console.error('tools smoke crashed:', err);
  process.exit(1);
});
