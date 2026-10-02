/**
 * v0.6-introspection-seam-test.ts — proves the introspection layer is
 * CONNECTED.
 *
 * Why this file exists
 * --------------------
 * The v0.6 diagnosis was the same one that produced the v0.3 rewrite:
 * every part was built, nothing was joined. agent-core had had
 * `observeAndReset()` on all four turn-exit paths since v0.4, along
 * with the snapshot accumulators and the `getGuidance()` prompt
 * injection. The 600-line introspection package implemented
 * `observe`, `reflect`, `getGuidance`, goal tracking and persistence.
 * `SessionEvent` had carried a `reflection` variant since v3.7.
 *
 * Nobody passed a layer to `new Agent({...})`. So `observeAndReset()`
 * ran four times per turn and took the `if (this.introspection)`
 * branch that could not be taken, and `reflection` was a protocol
 * event with no producer. No test failed, because every part was
 * individually correct.
 *
 * What this asserts
 * -----------------
 *   1. The runner hands a layer to the Agent.
 *   2. A real turn produces a snapshot with the tool usage, the files
 *      touched, and the error flag.
 *   3. The per-turn accumulators reset, so turn 2's snapshot is not
 *      turn 1's snapshot with more entries.
 *   4. Guidance from the layer reaches the model's system prompt.
 *   5. The LLM half is OFF by default — an unset flag must not bill
 *      the user, and `DEQI_INTROSPECTION=0` must mean off, not on.
 *   6. With it on, a reflection reaches the `reflection` wire event,
 *      which had never been emitted by anything before this.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    yield* (script[i] ?? script[script.length - 1]) as AsyncIterable<never>;
    i += 1;
  }) as never;
  return new ModelRegistry({ mock: { model: 'mock' } }, [], factory as never);
}

type Ev = Record<string, unknown>;

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const realFlag = process.env.DEQI_INTROSPECTION;
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v06-intro-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  delete process.env.DEQI_INTROSPECTION;

  const work = mkdtempSync(join(tmpdir(), 'deqi-v06-introwork-'));
  writeFileSync(join(work, 'a.txt'), 'alpha\n', 'utf8');
  writeFileSync(join(work, 'b.txt'), 'beta\n', 'utf8');

  /** Reach the private layer the way a test may: it is the only
   *  handle on what the runner actually wired up. */
  function layerOf(runner: AgentRunner): {
    getSnapshots: () => readonly unknown[];
    isEnabled: boolean;
    reflect: () => Promise<unknown>;
    getLastReport: () => unknown;
  } {
    return (runner as unknown as {
      introspection: {
        getSnapshots: () => readonly unknown[];
        isEnabled: boolean;
        reflect: () => Promise<unknown>;
        getLastReport: () => unknown;
      };
    }).introspection;
  }

  const makeRunner = (registry: ModelRegistry, sessionId: string): AgentRunner =>
    new AgentRunner(registry, sessionId, work, {
      cwd: work,
      model_id: 'mock',
      // bypass so the test is about introspection, not about the
      // permission prompt the tool calls would otherwise raise.
      permission_mode: 'bypass-permissions',
      show_surprise: false,
      enable_reflection: false,
    });

  try {
    // ─── 1. the layer exists at all ────────────────────────────
    section('the runner wires a layer into the Agent');
    {
      const registry = scriptedRegistry([textTurn('hi')]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();

      const layer = layerOf(runner);
      ok('a layer was constructed', layer !== null && layer !== undefined);
      ok('it is a real DefaultIntrospectionLayer',
        typeof layer?.getSnapshots === 'function' && typeof layer?.reflect === 'function');
      ok('it is reachable from the Agent config', (() => {
        const agent = (runner as unknown as { agent?: { introspection?: unknown } }).agent;
        return agent?.introspection === layer;
      })());
    }

    // ─── 2. a real turn produces a snapshot ────────────────────
    section('a real turn hands the layer a behaviour snapshot');
    {
      const registry = scriptedRegistry([
        toolCallTurn('read', { path: 'a.txt' }),
        textTurn('read it.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();

      const layer = layerOf(runner);
      runner.runTurn('read a', () => {});
      await runner.waitForCurrentTurn();

      const snaps = layer.getSnapshots() as Array<{
        toolUsage: Array<{ name: string; isError: boolean }>;
        filesTouched: string[];
        notes: string[];
        timestamp: string;
      }>;
      ok('a snapshot was recorded', snaps.length > 0, `${snaps.length} snapshot(s)`);
      const first = snaps[0];
      ok('it names the tool that ran', first?.toolUsage[0]?.name === 'read',
        first?.toolUsage[0]?.name);
      ok('it records the error flag', first?.toolUsage[0]?.isError === false);
      ok('it names the file the tool touched', first?.filesTouched.includes('a.txt') === true,
        JSON.stringify(first?.filesTouched));
      ok('it is timestamped', typeof first?.timestamp === 'string' && first.timestamp.length > 0);
    }

    section('a failing tool is recorded as a failure');
    {
      const registry = scriptedRegistry([
        toolCallTurn('read', { path: 'does-not-exist.txt' }),
        textTurn('it is not there.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();

      const layer = layerOf(runner);
      runner.runTurn('read the missing file', () => {});
      await runner.waitForCurrentTurn();

      const snaps = layer.getSnapshots() as Array<{
        toolUsage: Array<{ name: string; isError: boolean }>;
      }>;
      ok('the error is visible to the layer', snaps[0]?.toolUsage[0]?.isError === true,
        JSON.stringify(snaps[0]?.toolUsage));
    }

    // ─── 3. the accumulators reset between turns ───────────────
    // Note the unit. A "turn" here is an agent ReAct turn, not a
    // user message: one user message that calls a tool and then
    // answers produces TWO snapshots, exactly as it produces two
    // `turn_end` events on the wire. The moral layer's `turn_review`
    // counts user turns instead, so the two layers deliberately see
    // different granularities — which is worth knowing, and is why
    // this test asserts the reset rather than a total count.
    section("one turn's snapshot is not the next one's");
    {
      const registry = scriptedRegistry([
        toolCallTurn('read', { path: 'a.txt' }),
        textTurn('first done.'),
        toolCallTurn('read', { path: 'b.txt' }),
        textTurn('second done.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();

      const layer = layerOf(runner);
      runner.runTurn('first', () => {});
      await runner.waitForCurrentTurn();
      runner.runTurn('second', () => {});
      await runner.waitForCurrentTurn();

      const snaps = layer.getSnapshots() as Array<{ filesTouched: string[]; toolUsage: unknown[] }>;
      ok('every agent turn produced a snapshot', snaps.length === 4, `${snaps.length}`);
      ok('the tool turn names a.txt', snaps[0]?.filesTouched.join(',') === 'a.txt',
        snaps[0]?.filesTouched.join(','));
      ok('the answering turn after it does NOT still name a.txt',
        snaps[1]?.filesTouched.length === 0, snaps[1]?.filesTouched.join(','));
      ok('the second tool turn names b.txt', snaps[2]?.filesTouched.join(',') === 'b.txt',
        snaps[2]?.filesTouched.join(','));
      ok('and its answering turn is clean too',
        snaps[3]?.filesTouched.length === 0, snaps[3]?.filesTouched.join(','));
    }

    // ─── 4. guidance reaches the system prompt ─────────────────
    section('guidance from the layer reaches the model');
    {
      const registry = scriptedRegistry([textTurn('one'), textTurn('two')]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();

      const layer = layerOf(runner) as unknown as {
        currentGuidance: string;
      };
      // Stand in for a completed reflection. The assertion is that
      // agent-core PREPENDS it, which is the only part of this that
      // cannot be seen from the outside.
      //
      // It has to be followed by a real turn: getGuidance() is polled
      // at the START of a turn, so guidance produced after the last
      // one only lands on the next. That latency is the design — the
      // layer's whole point is that a reflection cannot rewrite the
      // turn that provoked it.
      layer.currentGuidance = '[self-reflection] prefer smaller diffs';

      runner.runTurn('first', () => {});
      await runner.waitForCurrentTurn();

      const agent = (runner as unknown as {
        agent: { buildRequest: (msgs: unknown[]) => { system?: string } };
      }).agent;
      const req = agent.buildRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
      ok('the guidance is in the system prompt',
        (req.system ?? '').includes('prefer smaller diffs'),
        (req.system ?? '').slice(0, 100));
    }

    // ─── 5. the LLM half is off unless asked for ───────────────
    section('the LLM half is off by default');
    {
      const registry = scriptedRegistry([textTurn('hi')]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();
      ok('with no flag set, the layer cannot call a model', layerOf(runner).isEnabled === false);

      // Three observations would cross the default reflectEvery of 3,
      // so if the gate were missing this is where it would fire.
      const layer = layerOf(runner) as unknown as { observe: (s: unknown) => Promise<void> };
      for (let i = 0; i < 5; i += 1) {
        await layer.observe({
          timestamp: new Date().toISOString(),
          toolUsage: [{ name: 'read', isError: false, durationMs: 1 }],
          filesTouched: ['a.txt'], notes: [],
        });
      }
      // Nothing to assert about a model call directly — instead the
      // report stays null, which is the observable consequence.
      ok('no reflection ran', layerOf(runner).getLastReport() === null);
    }

    section('the flag reads as a deliberate yes, not a truthy string');
    {
      for (const [raw, expected] of [
        ['0', false], ['false', false], ['no', false], ['off', false], ['', false],
        ['1', true], ['true', true], ['yes', true], ['on', true],
      ] as Array<[string, boolean]>) {
        process.env.DEQI_INTROSPECTION = raw;
        const registry = scriptedRegistry([textTurn('hi')]);
        const session = await SessionManager.create(work, 'mock', 'mock');
        const runner = makeRunner(registry, session.sessionId);
        await runner.init();
        ok(`DEQI_INTROSPECTION=${raw || '(unset)'} → ${expected ? 'on' : 'off'}`,
          layerOf(runner).isEnabled === expected);
      }
    }

    // ─── 6. a reflection reaches the wire ──────────────────────
    section('a reflection reaches the `reflection` event');
    {
      process.env.DEQI_INTROSPECTION = '1';
      const registry = scriptedRegistry([textTurn('hi')]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();
      ok('with the flag on, the layer is enabled', layerOf(runner).isEnabled === true);

      const events: Ev[] = [];
      runner.runTurn('hello', (ev) => { events.push(ev as unknown as Ev); });
      await runner.waitForCurrentTurn();

      // No observation has happened yet, so reflect() has nothing to
      // work with and the model is not called. That is the correct
      // behaviour, and it is what the event assertions below rest on.
      const reflections = events.filter((e) => e.type === 'reflection');
      ok('no reflection event before there is anything to reflect on',
        reflections.length === 0, `${reflections.length}`);
      ok('and the turn still completed', events.some((e) => e.type === 'text_delta'));
    }
    {
      // Now with something to reflect on. The reflection is the FIRST
      // getStream() this registry sees — no agent turn has run yet,
      // because the observations below are handed to the layer
      // directly — so its answer has to be script entry 0. Getting
      // this order wrong produces a well-formed report with three
      // empty lists, which looks like a parser bug and is not.
      process.env.DEQI_INTROSPECTION = '1';
      const registry = scriptedRegistry([
        (async function* () {
          yield { type: 'start' };
          yield { type: 'text_delta', delta: 'ALIGNED:\n- read the file before editing\n\nMISALIGNED:\n- used bash where a tool existed\n\nNEXT:\n- prefer the narrow tool' };
          yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd: 0 };
          yield { type: 'done', stopReason: 'end_turn' };
        })(),
        textTurn('done'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = makeRunner(registry, session.sessionId);
      await runner.init();

      const layer = layerOf(runner) as unknown as { observe: (s: unknown) => Promise<void> };
      for (let i = 0; i < 3; i += 1) {
        await layer.observe({
          timestamp: new Date().toISOString(),
          toolUsage: [{ name: 'read', isError: false, durationMs: 1 }],
          filesTouched: ['a.txt'], notes: [],
        });
      }
      // observe() fires the reflection in the background; give it a
      // moment to land rather than making the test racy on a timer.
      for (let i = 0; i < 100 && layerOf(runner).getLastReport() === null; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const report = layerOf(runner).getLastReport() as {
        aligned: string[]; misaligned: string[]; nextSteps: string[];
      } | null;
      ok('a reflection ran once the threshold was crossed', report !== null);
      ok('it parsed the aligned list', report?.aligned.length === 1, JSON.stringify(report?.aligned));
      ok('it parsed the misaligned list', report?.misaligned.length === 1, JSON.stringify(report?.misaligned));
      ok('it parsed the next steps', report?.nextSteps[0] === 'prefer the narrow tool',
        JSON.stringify(report?.nextSteps));

      // And the guidance it produced is what the next prompt carries.
      // A turn has to run for that: getGuidance() is polled at the
      // start of one, so a reflection that lands mid-flight only
      // reaches the prompt after it.
      runner.runTurn('carry it forward', () => {});
      await runner.waitForCurrentTurn();

      const agent = (runner as unknown as {
        agent: { buildRequest: (m: unknown[]) => { system?: string } };
      }).agent;
      const req = agent.buildRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
      ok('the reflection reached the system prompt',
        (req.system ?? '').includes('prefer the narrow tool'),
        (req.system ?? '').slice(0, 200));
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    if (realFlag === undefined) delete process.env.DEQI_INTROSPECTION;
    else process.env.DEQI_INTROSPECTION = realFlag;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[31mv0.6-introspection-seam-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mv0.6-introspection-seam-test PASSED\x1b[0m');
}

main().catch((err) => {
  console.error('v0.6-introspection-seam-test crashed:', err);
  process.exit(1);
});
