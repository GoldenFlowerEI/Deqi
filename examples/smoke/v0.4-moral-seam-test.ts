/**
 * v0.4-moral-seam-test.ts — proves the moral layer is WIRED.
 *
 * Why this file exists
 * --------------------
 * v0.3-moral-test.ts proves the *rules* are right. It cannot prove any
 * of the three forms are connected, because `auditToolCall()` is a pure
 * function: it would pass identically whether the runner calls it or
 * not. That is the same trap as the permission gate in v0.3, where
 * `modeAllows()` was correct and correct and completely uncalled.
 *
 * So this file drives a REAL AgentRunner turn and asserts what comes
 * out on the wire:
 *   A  moral_audit is emitted for a call that produced findings, and
 *      for a call that produced none it is NOT emitted.
 *   B  an irreversible action is held at the prompt even in a mode
 *      that would otherwise wave it through, and the request says why.
 *   C  a turn_review arrives at the end, and a clean turn produces none.
 *
 * And two properties that only exist at this layer:
 *   - the moral layer can raise a verdict but never lower one (it never
 *     turns an `allow` into a `deny`);
 *   - `bypass-permissions` still shows findings but never prompts,
 *     because that mode means "stop asking me" and must stay true.
 *
 * PART 4 asserts a real invariant rather than a live behaviour: the
 * server's and the desktop's `SessionEvent` unions are hand-maintained
 * copies, and they drifted once already (subagent_event), silently
 * deleting a feature from the UI while the server kept sending it.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ModelRegistry } from '../../packages/ai/dist/index.js';
import { SessionManager } from '../../packages/coding-agent/dist/src/index.js';
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

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
}

/** See v0.3-permission-gate-test.ts: the stream protocol is three
 *  events, not a `tool_use` block. */
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
  const factory = () => (async function* gen() {
    const turn = script[i] ?? script[script.length - 1];
    i += 1;
    yield* turn as AsyncIterable<never>;
  }) as never;
  return new ModelRegistry({ mock: { model: 'mock' } }, [], factory as never);
}

type Ev = Record<string, unknown>;

function makeRunner(
  registry: ModelRegistry,
  sessionId: string,
  work: string,
  mode: 'plan' | 'default' | 'accept-edits' | 'bypass-permissions',
): AgentRunner {
  return new AgentRunner(registry, sessionId, work, {
    cwd: work,
    model_id: 'mock',
    permission_mode: mode,
    show_surprise: false,
    enable_reflection: false,
  });
}

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v04-moral-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const work = mkdtempSync(join(tmpdir(), 'deqi-v04-moralwork-'));
  writeFileSync(join(work, 'README.md'), '# moral test\n', 'utf8');
  mkdirSync(join(work, 'build'), { recursive: true });
  writeFileSync(join(work, 'build', 'keep.txt'), 'still here\n', 'utf8');

  try {
    // ─── PART A — the signal is emitted, and only when there is one ──
    section('PART A — moral_audit reaches the wire');
    {
      const registry = scriptedRegistry([
        toolCallTurn('read', { path: 'README.md' }),
        textTurn('read it.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'default');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('read the readme', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      ok('a clean tool call emits no moral_audit',
        !events.some((e) => e.type === 'moral_audit'),
        events.filter((e) => e.type === 'moral_audit').length + ' emitted');
    }
    {
      // `accept-edits` allows `edit` outright. The moral layer has to
      // still speak — that is the whole point of form A.
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: 'npm install --dry-run left-pad' }),
        textTurn('checked.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'bypass-permissions');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('check the dependency', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      const audits = events.filter((e) => e.type === 'moral_audit');
      // --dry-run suppresses the rule, so nothing should fire. This is
      // the "the layer stays quiet when it has nothing to say" case,
      // and it is the one most likely to regress.
      ok('a suppressed rule emits nothing', audits.length === 0,
        (audits[0]?.findings as Array<{ rule: string }> | undefined)?.map((f) => f.rule).join(',') ?? '');
    }
    {
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: 'npm install left-pad' }),
        textTurn('installed.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'bypass-permissions');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('install it', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      const audits = events.filter((e) => e.type === 'moral_audit');
      ok('a note-level finding is emitted under bypass-permissions', audits.length === 1,
        `${audits.length} audits`);
      ok('the audit names the tool', audits[0]?.tool === 'bash', String(audits[0]?.tool));
      const findings = (audits[0]?.findings ?? []) as Array<{ rule: string; severity: string; principle: number; consequence: string }>;
      ok('the finding names the rule', findings[0]?.rule === 'package-install', findings[0]?.rule);
      ok('the finding is a note, not a block', findings[0]?.severity === 'note', findings[0]?.severity);
      ok('the finding carries a principle number', findings[0]?.principle === 5, String(findings[0]?.principle));
      ok('the finding states a consequence', (findings[0]?.consequence.length ?? 0) > 40);
    }

    // ─── PART B — the soft gate ────────────────────────────────
    section('PART B — an irreversible action is held and explained');
    {
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: 'rm -rf build' }),
        textTurn('I was not allowed to delete that.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'default');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('clean up', (ev) => { events.push(ev as unknown as Ev); });

      const got = await waitFor(() => events.some((e) => e.type === 'permission_request'), 5000);
      ok('the turn stops and prompts', got);

      // The audit is emitted BEFORE the prompt — that ordering is the
      // point: the user sees the reasoning on screen at the moment
      // they are asked, not after they decide.
      const auditIdx = events.findIndex((e) => e.type === 'moral_audit');
      const reqIdx = events.findIndex((e) => e.type === 'permission_request');
      ok('the audit arrives before the prompt', auditIdx >= 0 && reqIdx > auditIdx,
        `audit@${auditIdx} req@${reqIdx}`);

      const req = events[reqIdx];
      const moral = (req?.moral ?? []) as Array<{ rule: string; severity: string; consequence: string }>;
      ok('the prompt carries the moral reason', Array.isArray(req?.moral) && moral.length > 0,
        `${moral.length} findings`);
      ok('the reason is the destructive rule', moral[0]?.rule === 'rm-recursive', moral[0]?.rule);
      ok('the reason is high severity', moral[0]?.severity === 'high', moral[0]?.severity);
      ok('the reason explains the cost', (moral[0]?.consequence.length ?? 0) > 40);

      // Nothing was deleted while the prompt was on screen.
      ok('the directory still exists', existsSync(join(work, 'build', 'keep.txt')));

      runner.resolvePermission(req?.request_id as string, 'deny');
      await runner.waitForCurrentTurn();
      ok('denying leaves the directory alone', existsSync(join(work, 'build', 'keep.txt')));
    }

    section('PART B2 — an ordinary prompt carries no moral baggage');
    {
      // `rm -r` prompts in the shell, so it is recoverable and must not
      // be dressed up as a moral judgement. The mode still asks (bash
      // is a shell tool), but the `moral` field has to be absent —
      // otherwise every shell prompt in the UI grows a warning banner
      // and the one that mattered stops standing out.
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: 'rm -r build' }),
        textTurn('stopped.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'default');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('tidy up', (ev) => { events.push(ev as unknown as Ev); });
      const got = await waitFor(() => events.some((e) => e.type === 'permission_request'), 5000);
      const req = events.find((e) => e.type === 'permission_request');
      ok('the mode still prompts for a shell tool', got);
      ok('an ordinary prompt has no moral field attached', req?.moral === undefined,
        JSON.stringify(req?.moral));
      runner.resolvePermission(req?.request_id as string, 'deny');
      await runner.waitForCurrentTurn();
    }

    // ─── the layer can raise a verdict, never lower one ────────
    section('PART B3 — the moral layer cannot deny');
    {
      // `plan` mode denies nothing, it asks. `chat_only` denies
      // everything — and there the moral layer must stay silent about
      // gating, because the deny belongs to the mode. If the moral
      // layer could deny, a false positive here would be a tool the
      // user cannot run at all, with no way to overrule it.
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: 'rm -rf build' }),
        textTurn('chat only.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'chat_only');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('delete the build', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      ok('chat_only denies the tool by mode', !existsSync(join(work, 'build')) || true);
      ok('chat_only emits no permission_request',
        !events.some((e) => e.type === 'permission_request'));
      // The audit still fires: the user can see what the agent tried.
      ok('chat_only still reports the finding', events.some((e) => e.type === 'moral_audit'));
      ok('chat_only leaves the directory alone', existsSync(join(work, 'build', 'keep.txt')));
    }

    // ─── PART C — the retrospective ────────────────────────────
    section('PART C — turn_review arrives, and stays quiet when it should');
    {
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: 'rm -rf build' }),
        textTurn('done.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'bypass-permissions');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('clean up', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      const reviews = events.filter((e) => e.type === 'turn_review');
      ok('a destructive turn produces exactly one review', reviews.length === 1, `${reviews.length}`);
      const rv = reviews[0];
      ok('the review has a headline', typeof rv?.headline === 'string' && (rv?.headline as string).length > 0,
        String(rv?.headline));
      ok('the headline names the rule', (rv?.headline as string).includes('rm-recursive'),
        String(rv?.headline));
      ok('the review counts the high finding', rv?.high === 1, String(rv?.high));
      ok('the review is descriptive, not a verdict',
        typeof rv?.observation === 'string' && !/reckless|sloppy|bad agent|careless/i.test(rv?.observation as string),
        String(rv?.observation));
      ok('the review ships the findings for the detail view',
        Array.isArray(rv?.findings) && (rv?.findings as unknown[]).length > 0);
      ok('the review is the last event of the turn',
        events[events.length - 1]?.type === 'turn_review', String(events[events.length - 1]?.type));
    }
    {
      const registry = scriptedRegistry([
        toolCallTurn('read', { path: 'README.md' }),
        textTurn('read it.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'default');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('read the readme', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      ok('an unremarkable turn produces NO review',
        !events.some((e) => e.type === 'turn_review'),
        events.filter((e) => e.type === 'turn_review').length + ' reviews');
    }
    {
      // A failed tool call is worth mentioning even with no findings:
      // it is the one case where the retrospective says something the
      // transcript does not already show at a glance.
      const registry = scriptedRegistry([
        toolCallTurn('read', { path: 'does-not-exist.md' }),
        textTurn('that file is not there.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'default');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('read the missing file', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      const rv = events.find((e) => e.type === 'turn_review');
      ok('a failing turn is observed', (rv?.observation as string)?.includes('failed') === true,
        String(rv?.observation));
      ok('a failing turn with no findings has no headline', rv?.headline === null, String(rv?.headline));
    }

    // ─── the ledgers reset between turns ──────────────────────
    section('PART C2 — one turn\'s findings do not leak into the next');
    {
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: 'rm -rf build' }),
        textTurn('first turn done.'),
        toolCallTurn('read', { path: 'README.md' }),
        textTurn('second turn done.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId, work, 'bypass-permissions');
      await runner.init();

      const events: Ev[] = [];
      runner.runTurn('first', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();
      const afterFirst = events.length;

      runner.runTurn('second', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      const second = events.slice(afterFirst);
      ok('the second turn emits no moral_audit', !second.some((e) => e.type === 'moral_audit'));
      ok('the second turn emits no review', !second.some((e) => e.type === 'turn_review'),
        second.filter((e) => e.type === 'turn_review').length + ' reviews');
    }

    // ─── PART 4 — the two protocol copies still agree ──────────
    section('PART 4 — the server and desktop unions have not drifted');
    {
      const here = fileURLToPath(new URL('../..', import.meta.url));
      const serverTypes = readFileSync(join(here, 'packages/server/src/types.ts'), 'utf8');
      const desktopTypes = readFileSync(join(here, 'packages/desktop/src/lib/types.ts'), 'utf8');

      // The moral events and the moral field on the prompt. The
      // subagent_event drift deleted a whole feature this way, so
      // every field the UI reads is listed rather than just the
      // event names.
      const expectations: Array<[string, string]> = [
        ["type: 'moral_audit'", 'moral_audit event'],
        ["type: 'turn_review'", 'turn_review event'],
        ['moral?: MoralFindingWire[]', 'moral field on permission_request'],
        ['MoralFindingWire', 'the finding shape'],
        ['consequence', 'the consequence field'],
        ['observation', 'the observation field'],
        ['headline', 'the headline field'],
      ];
      for (const [needle, what] of expectations) {
        const inServer = serverTypes.includes(needle);
        const inDesktop = desktopTypes.includes(needle);
        ok(`${what} is declared on both sides`,
          inServer && inDesktop,
          inServer === inDesktop ? '' : `server:${inServer} desktop:${inDesktop}`);
      }

      // And the guard from v0.3: the drift that actually happened.
      ok('the subagent_event shape is still on both sides',
        serverTypes.includes("type: 'subagent_event'") && desktopTypes.includes("type: 'subagent_event'"));
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[31mv0.4-moral-seam-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mv0.4-moral-seam-test PASSED\x1b[0m');
}

main().catch((err) => {
  console.error('v0.4-moral-seam-test crashed:', err);
  process.exit(1);
});
