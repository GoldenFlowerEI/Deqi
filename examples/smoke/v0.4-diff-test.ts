/**
 * v0.4-diff-test.ts — the line diff behind "see what the agent changed".
 *
 * A diff has an unusually bad failure profile: it does not crash, it
 * quietly shows you the wrong lines. Every case below is a shape that
 * a naive implementation gets wrong — and the file this is for is
 * often the one the user was about to trust.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry } from '../../packages/ai/dist/index.js';
import { SessionManager, diffLines, makeFileDiff, type DiffLine, type FileDiff } from '../../packages/coding-agent/dist/src/index.js';
import { AgentRunner } from '../../packages/server/dist/agent-runner.js';

let passCount = 0;
let failCount = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passCount += 1;
    console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

/** Reassemble a file from a diff. The strongest possible check: if
 *  this equals the input, the diff did not lose or invent a line. */
function applyOld(lines: DiffLine[]): string {
  return lines.filter((l) => l.op !== 'add').map((l) => l.text).join('\n');
}
function applyNew(lines: DiffLine[]): string {
  return lines.filter((l) => l.op !== 'del').map((l) => l.text).join('\n');
}
/** Drop the synthetic "… N unchanged" placeholders first. */
function real(lines: DiffLine[]): DiffLine[] {
  return lines.filter((l) => !l.text.startsWith('… '));
}

function main(): void {  // ─── the empty and trivial cases ─────────────────────────────
  section('identical and empty input');
  {
    ok('identical text produces no lines', diffLines('a\nb', 'a\nb').lines.length === 0);
    ok('identical text has no counts',
      diffLines('a\nb', 'a\nb').added === 0 && diffLines('a\nb', 'a\nb').removed === 0);
    ok('empty to empty', diffLines('', '').lines.length === 0);
    ok('empty to one line is one add', diffLines('', 'a').added === 1);
    ok('one line to empty is one del', diffLines('a', '').removed === 1);
  }

  // ─── a single changed line ───────────────────────────────────
  section('a single line replaced');
  {
    const d = diffLines('one\ntwo\nthree', 'one\nTWO\nthree');
    ok('one line added', d.added === 1, String(d.added));
    ok('one line removed', d.removed === 1, String(d.removed));
    const dels = d.lines.filter((l) => l.op === 'del');
    const adds = d.lines.filter((l) => l.op === 'add');
    ok('the removed line is the old one', dels[0]?.text === 'two', dels[0]?.text);
    ok('the added line is the new one', adds[0]?.text === 'TWO', adds[0]?.text);
  }

  // ─── round-trip: the diff must not lose content ──────────────
  // This is the property that actually matters. A diff that renders
  // beautifully and drops a line is worse than no diff at all.
  //
  // Only for inputs small enough that no context was elided. Once the
  // two-line context window kicks in the output is deliberately a
  // window, not a file, and reconstructing from it would be asserting
  // the wrong thing. That case has its own section below.
  section('round-trip (the property that matters)');
  {
    const cases: Array<[string, string, string]> = [
      ['single replace', 'one\ntwo\nthree', 'one\nTWO\nthree'],
      ['pure insert', 'a\nb', 'a\nnew\nb'],
      ['pure delete', 'a\ngone\nb', 'a\nb'],
      ['append', 'a', 'a\nb\nc'],
      ['prepend', 'b', 'a\nb'],
      ['all new', '', 'x\ny\nz'],
      ['all removed', 'x\ny\nz', ''],
      ['reorder', 'a\nb\nc\nd', 'd\nc\nb\na'],
      ['duplicate lines', 'x\nx\nx', 'x\nx'],
      ['blank lines', 'a\n\n\nb', 'a\n\nb'],
      ['whitespace only', 'a\n  b  \nc', 'a\n\tb\nc'],
      // CRLF vs LF normalises to LF, so the round trip is against the
      // normalised form. This is the right behaviour — otherwise a
      // checkout with different line endings shows every line of the
      // file as changed, which is a diff nobody reads.
      ['CRLF vs LF', 'a\r\nb', 'a\nb'],
    ];
    const norm = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\n$/, '');
    for (const [name, before, after] of cases) {
      const d = diffLines(before, after);
      const r = real(d.lines);
      ok(`${name}: old file reconstructs`, applyOld(r) === norm(before),
        `got ${JSON.stringify(applyOld(r).slice(0, 40))}`);
      ok(`${name}: new file reconstructs`, applyNew(r) === norm(after),
        `got ${JSON.stringify(applyNew(r).slice(0, 40))}`);
    }
  }

  // ─── context elision ─────────────────────────────────────────
  // A long file with one edit in the middle is the common case, and
  // the diff shows two lines of context plus a marker saying how much
  // was skipped. The marker is what makes that honest rather than
  // broken: a consumer can see the view is partial.
  section('a long file shows a window, and says so');
  {
    const before = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l100', 'CHANGED');
    const d = diffLines(before, after);
    const r = real(d.lines);
    ok('it finds the one change', d.added === 1 && d.removed === 1, `+${d.added} -${d.removed}`);
    ok('it marks the head it skipped', d.lines.some((l) => l.text.startsWith('… ') && /unchanged/.test(l.text)),
      d.lines.filter((l) => l.op === 'ctx').map((l) => l.text).join(' | ').slice(0, 80));
    ok('the elision marker is a context line, not a change',
      d.lines.filter((l) => l.text.startsWith('… ')).every((l) => l.op === 'ctx'));
    ok('the output is much smaller than the file', d.lines.length < 20, `${d.lines.length} lines`);
    // Round-trip does NOT hold here, by design. Assert that we know it.
    ok('the window deliberately does not reconstruct the file', applyOld(r) !== before);
  }

  // ─── trailing newline is a terminator ────────────────────────
  section('a trailing newline is not a line');
  {
    // Counting the terminator as a blank line makes every "added a
    // final newline" edit show as a spurious `+` on an empty line.
    const d = diffLines('a\nb\n', 'a\nb\n');
    ok('adding a trailing newline changes nothing', d.added === 0 && d.removed === 0,
      `+${d.added} -${d.removed}`);
    const d2 = diffLines('a\nb', 'a\nb\n');
    ok('and a file that differs only by it, likewise', d2.added === 0 && d2.removed === 0,
      `+${d2.added} -${d2.removed}`);
  }

  // ─── large file performance ──────────────────────────────────
  section('a 3,000-line file with one edit does not stall');
  {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 1500', 'line 1500 CHANGED');
    const t0 = Date.now();
    const d = diffLines(before, after);
    const ms = Date.now() - t0;
    ok('it completes', true, `${ms}ms`);
    // Without the prefix/suffix trim this is 9,000,000 DP cells.
    ok('it is fast', ms < 1000, `${ms}ms`);
    ok('it finds exactly one change', d.added === 1 && d.removed === 1,
      `+${d.added} -${d.removed}`);
    ok('it did not give up as too large', d.tooLarge !== true);
  }

  section('an overwhelming change is reported, not faked');
  {
    const before = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
    const d = diffLines(before, after);
    // Honesty over cleverness: a wrong diff is worse than a count.
    ok('it declines to line-diff it', d.tooLarge === true);
    ok('it still reports the counts', d.added > 0 && d.removed > 0, `+${d.added} -${d.removed}`);
    ok('it emits no misleading lines', d.lines.filter((l) => l.op !== 'ctx').length === 0);
  }

  // ─── bounded output ──────────────────────────────────────────
  section('output stays bounded');
  {
    const before = Array.from({ length: 900 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 900 }, (_, i) => `b${i}`).join('\n');
    const d = diffLines(before, after);
    ok('a 900-line rewrite is capped', d.lines.length <= 400, `${d.lines.length} lines`);
    ok('and it says it was capped', d.truncated === true);
  }

  // ─── line numbers ────────────────────────────────────────────
  section('line numbers point at the right place');
  {
    const d = diffLines('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne');
    const ctx = real(d.lines).filter((l) => l.op === 'ctx');
    ok('the first context line is line 1', ctx[0]?.oldNo === 1 && ctx[0]?.newNo === 1,
      `${ctx[0]?.oldNo}/${ctx[0]?.newNo}`);
    const del = real(d.lines).find((l) => l.op === 'del');
    const add = real(d.lines).find((l) => l.op === 'add');
    ok('the removed line was line 3', del?.oldNo === 3, String(del?.oldNo));
    ok('the added line is now line 3', add?.newNo === 3, String(add?.newNo));
  }

  // ─── the file-level wrapper ──────────────────────────────────
  section('makeFileDiff');
  {
    const created = makeFileDiff('a.ts', null, 'one\ntwo');
    ok('a new file is reported as created', created.change === 'created');
    ok('every line of it is an add',
      created.lines.every((l) => l.op === 'add'), created.lines.map((l) => l.op).join(','));
    ok('the count matches', created.added === 2, String(created.added));

    const modified = makeFileDiff('a.ts', 'one\ntwo', 'one\nTWO');
    ok('an existing file is reported as modified', modified.change === 'modified');
    ok('it keeps the path', modified.path === 'a.ts');

    const huge = makeFileDiff('big.txt', Array.from({ length: 2000 }, (_, i) => `a${i}`).join('\n'),
      Array.from({ length: 2000 }, (_, i) => `b${i}`).join('\n'));
    ok('a huge rewrite is flagged tooLarge', huge.tooLarge === true);
    ok('and is still bounded', huge.lines.length <= 400, `${huge.lines.length}`);
  }
}

// ─── the seam ─────────────────────────────────────────────────────
// Everything above proves the diff algorithm. None of it proves the
// diff is produced. `makeFileDiff` is a pure function that would pass
// identically if no tool ever called it and the wire never carried
// it — the same gap the permission gate and the moral layer both had.
// This drives a real turn and reads the event off the wire.

function toolCallTurn(name: string, input: Record<string, unknown>): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'start' };
    yield { type: 'toolcall_start', id: 'tc_1', name };
    yield { type: 'toolcall_delta', id: 'tc_1', inputDelta: JSON.stringify(input) };
    yield { type: 'toolcall_end', id: 'tc_1', name, input };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0 };
    yield { type: 'done', stopReason: 'tool_use' };
  })();
}

function textTurn(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'start' };
    yield { type: 'text_delta', delta: text };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0 };
    yield { type: 'done', stopReason: 'end_turn' };
  })();
}

function scriptedRegistry(script: AsyncIterable<unknown>[]): ModelRegistry {
  let i = 0;
  return new ModelRegistry({ mock: { model: 'mock' } }, [], (() =>
    (async function* gen() {
      yield* (script[i] ?? script[script.length - 1]) as AsyncIterable<never>;
      i += 1;
    }) as never) as never);
}

async function seam(): Promise<void> {
  section('the diff actually reaches the wire');
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v04-diffhome-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const work = mkdtempSync(join(tmpdir(), 'deqi-v04-diffwork-'));

  try {
    writeFileSync(join(work, 'hello.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

    const registry = scriptedRegistry([
      toolCallTurn('edit', { path: 'hello.txt', oldText: 'beta', newText: 'BETA' }),
      textTurn('done'),
    ]);
    const session = await SessionManager.create(work, 'mock', 'mock');
    const runner = new AgentRunner(registry, session.sessionId, work, {
      cwd: work,
      model_id: 'mock',
      permission_mode: 'bypass-permissions',
      show_surprise: false,
      enable_reflection: false,
    });
    await runner.init();

    const events: Array<Record<string, unknown>> = [];
    runner.runTurn('rename beta', (ev) => { events.push(ev as unknown as Record<string, unknown>); });
    await runner.waitForCurrentTurn();

    const end = events.find((e) => e.type === 'tool_end');
    ok('the tool_end event exists', end !== undefined);
    const diff = end?.diff as FileDiff | undefined;
    ok('it carries a diff', diff !== undefined && diff !== null);
    ok('the diff names the file', diff?.path === 'hello.txt', String(diff?.path));
    ok('one line added', diff?.added === 1, String(diff?.added));
    ok('one line removed', diff?.removed === 1, String(diff?.removed));
    const del = diff?.lines.find((l) => l.op === 'del');
    const add = diff?.lines.find((l) => l.op === 'add');
    ok('the removed line is the old text', del?.text === 'beta', del?.text);
    ok('the added line is the new text', add?.text === 'BETA', add?.text);
    ok('the edit really happened on disk',
      readFileSync(join(work, 'hello.txt'), 'utf8').includes('BETA'));
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function run(): Promise<void> {
  main();
  await seam();
  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[31mv0.4-diff-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mv0.4-diff-test PASSED\x1b[0m');
}

run().catch((err) => {
  console.error('v0.4-diff-test crashed:', err);
  process.exit(1);
});
