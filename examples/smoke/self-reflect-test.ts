/**
 * v0.8 smoke test: strange-loop tools (session_history, self_reflect).
 *
 * Verifies:
 *   1. sessionHistoryTool returns the last N messages as a transcript.
 *   2. sessionHistoryTool filters by role.
 *   3. selfReflectTool returns the last N reflection entries.
 *   4. Both tools return isError when no SessionManager is in the harness.
 *   5. Tools work with a real SessionManager loaded from disk.
 *   6. self_reflect surfaces the tried/learned/nextHint fields.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sessionHistoryTool,
  selfReflectTool,
  SessionManager,
} from '@deqi/coding-agent';
import type { ToolExecutionContext } from '@deqi/agent-core';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

function makeCtx(session: SessionManager | null): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    messages: [],
    log: () => {},
    harness: session ? { session } : undefined,
  };
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deqi-self-'));

  // -- Test 1: tools return isError without SessionManager.
  {
    const r1 = await sessionHistoryTool.execute({}, makeCtx(null));
    const r2 = await selfReflectTool.execute({}, makeCtx(null));
    ok('session_history without session is isError', r1.isError === true);
    ok('self_reflect without session is isError', r2.isError === true);
  }

  // -- Test 2: session_history with a real SessionManager.
  {
    const sm = await SessionManager.create(dir, 'test-model', 'test');
    await sm.appendUserMessage('read the seed file');
    await sm.appendAssistantMessage([{ type: 'text', text: 'reading now' }]);
    await sm.appendUserMessage('now write a fix');
    await sm.appendAssistantMessage([{ type: 'text', text: 'fixing' }]);
    const r = await sessionHistoryTool.execute({ limit: 10 }, makeCtx(sm));
    ok('session_history returns isError=false', r.isError !== true);
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('transcript includes first user message', text.includes('read the seed'));
    ok('transcript includes both roles', text.includes('[user]') && text.includes('[assistant]'));
  }

  // -- Test 3: session_history role filter.
  {
    const sm = await SessionManager.create(dir, 'test-model', 'test');
    await sm.appendUserMessage('a user message');
    await sm.appendAssistantMessage([{ type: 'text', text: 'an assistant message' }]);
    const r = await sessionHistoryTool.execute({ role: 'user' }, makeCtx(sm));
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('role filter excludes assistant', text.includes('a user message') && !text.includes('an assistant message'));
  }

  // -- Test 4: session_history limit.
  {
    const sm = await SessionManager.create(dir, 'test-model', 'test');
    for (let i = 0; i < 30; i++) {
      await sm.appendUserMessage(`msg ${i}`);
    }
    const r = await sessionHistoryTool.execute({ limit: 5 }, makeCtx(sm));
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    ok('limit=5 returns 5 lines', lines.length === 5);
  }

  // -- Test 5: self_reflect with no reflections returns empty.
  {
    const sm = await SessionManager.create(dir, 'test-model', 'test');
    const r = await selfReflectTool.execute({}, makeCtx(sm));
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('self_reflect with no reflections returns empty', text.includes('no reflections'));
  }

  // -- Test 6: self_reflect with reflections surfaces all 4 fields.
  {
    const sm = await SessionManager.create(dir, 'test-model', 'test');
    await sm.appendReflection({
      note: 't=1; tools=2; errs=0',
      tried: 'called read, edit',
      learned: 'tools worked: read, edit',
      nextHint: 'assistant produced 50 chars of text',
      toolCallCount: 2,
      hadErrors: false,
    });
    await sm.appendReflection({
      note: 't=2; tools=1; errs=1',
      tried: 'called bash',
      learned: '1 tool error(s): bash: command not found',
      nextHint: 'check the path',
      toolCallCount: 1,
      hadErrors: true,
    });
    const r = await selfReflectTool.execute({ limit: 5 }, makeCtx(sm));
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('self_reflect includes tried field', text.includes('tried:'));
    ok('self_reflect includes learned field', text.includes('learned:'));
    ok('self_reflect includes next field', text.includes('next:'));
    ok('self_reflect includes tools field', text.includes('tools:'));
    ok('self_reflect includes the bash error', text.includes('command not found'));
    ok('self_reflect includes the previous read', text.includes('read, edit'));
  }

  // -- Test 7: persistence — write a reflection, save, reload, read it.
  {
    const sm = await SessionManager.create(dir, 'test-model', 'test');
    await sm.appendUserMessage('first');
    await sm.appendAssistantMessage([{ type: 'text', text: 'reply 1' }]);
    await sm.appendReflection({
      note: 't=1; tools=0; errs=0',
      tried: 'no tools called',
      learned: 'pure reasoning turn',
      nextHint: 'no assistant text — turn ended early',
      toolCallCount: 0,
      hadErrors: false,
    });
    // Re-read the file to confirm reflection was written.
    const text = readFileSync(sm.filePath, 'utf8');
    ok('reflection is persisted to disk', text.includes('"type":"reflection"'));

    // Reload and verify the tool can read it back.
    const reloaded = await SessionManager.load(sm.filePath);
    const r = await selfReflectTool.execute({ limit: 1 }, makeCtx(reloaded));
    const out = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('reloaded session has the reflection', out.includes('pure reasoning turn'));
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(process.exitCode === 1 ? 'SELF-REFLECT SMOKE FAILED' : 'SELF-REFLECT SMOKE PASSED');
}

main().catch((err) => {
  console.error('self-reflect smoke crashed:', err);
  process.exit(1);
});
