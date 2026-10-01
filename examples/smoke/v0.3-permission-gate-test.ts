/**
 * v0.3-permission-gate-test.ts — proves the permission gate is WIRED,
 * not just implemented.
 *
 * Why this file exists
 * --------------------
 * `evaluatePermission()`, `modeAllows()`, `GrantStore` and the
 * `permission_request` / `permission_response` wire events all existed
 * and all worked. None of them were connected: `evaluatePermission`
 * had zero call sites and no tool declared `checkPermissions`, so every
 * one of the 22 tools executed without approval in every mode,
 * including `plan`. The permission mode dropdown in the desktop was
 * decorative.
 *
 * A unit test of `modeAllows()` would not have caught that — it passed
 * the whole time. What catches it is asserting the wiring: that the
 * agent-core sees a `checkPermissions` hook on its tools, and that a
 * real turn under a gating mode actually stops and asks.
 *
 * What this asserts
 * -----------------
 *   PART 1 — classification. Every built-in tool has a class, and the
 *            verdicts are the ones the mode names promise.
 *   PART 2 — the gate is installed on the tools the agent receives.
 *   PART 3 — a real turn under `default` mode issues a `bash` call,
 *            the server emits `permission_request`, the tool does NOT
 *            run, and `deny` produces a visible refusal the model sees.
 *   PART 4 — `bypass-permissions` really does skip the prompt.
 *
 * PART 3/4 need a model that emits tool calls. The bundled mock never
 * does (it is a playground that echoes text), so this test installs a
 * scripted stream over the registry's mock factory. That is the same
 * seam `createMockStream` occupies, used deliberately.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry } from '../../packages/ai/dist/index.js';
import {
  BUILTIN_TOOLS,
  SessionManager,
} from '../../packages/coding-agent/dist/src/index.js';
import { modeAllows, toolClass, knownToolNames } from '../../packages/server/dist/permission-modes.js';
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

/** Poll until `pred` is true or the budget runs out. */
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
}

/**
 * A scripted model: turn 1 asks for a tool, turn 2 reports back.
 * `script` is consumed one entry per model call so the test can drive
 * the whole ReAct loop deterministically.
 */
function scriptedStream(script: AsyncIterable<unknown>[]): (auth: { model?: string }) => never {
  let i = 0;
  return () => {
    return (async function* gen() {
      const turn = script[i] ?? script[script.length - 1];
      i += 1;
      yield* turn as AsyncIterable<never>;
    }) as never;
  };
}

function toolCallTurn(name: string, input: Record<string, unknown>): AsyncIterable<unknown> {
  // Returns a single generator, NOT an array containing one. The
  // script is a list of turns and `scriptedStream` does `yield*` on
  // the selected entry; an array there would be spread into the
  // generator OBJECT rather than its events, so the model would emit
  // exactly one unrecognised event and the turn would end immediately
  // with no tool call. That is why the first version of this test
  // reported "0 permission_request" while the gate was working
  // perfectly.
  return (async function* () {
    yield { type: 'start' };
    // The provider protocol is a three-event tool call, not a single
    // `tool_use` block: toolcall_start → toolcall_delta → toolcall_end.
    // (`tool_use` is the message BLOCK shape, not the stream EVENT
    // shape — agent-core ignores it and the tool never runs.)
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
  return new ModelRegistry({ mock: { model: 'mock' } }, [], scriptedStream(script) as never);
}

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v03-perm-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const work = mkdtempSync(join(tmpdir(), 'deqi-v03-permwork-'));
  writeFileSync(join(work, 'README.md'), '# gate test\n', 'utf8');
  mkdirSync(join(work, 'src'), { recursive: true });
  // Relative, not absolute. The bash tool runs through a shell with
  // cwd = the agent working directory; a Windows absolute path like
  // C:\Users\...\canary.txt does not survive that shell's own escaping
  // rules, so the redirect silently wrote nothing and the test read
  // the failure as "the tool never ran".
  const canary = 'canary.txt';
  const canaryPath = join(work, canary);

  try {
    // ─── PART 1 — classification ────────────────────────────────
    section('PART 1 — every built-in tool is classified');
    const unclassified = knownToolNames(BUILTIN_TOOLS.map((t) => t.name));
    ok(
      'no built-in tool is missing a class',
      unclassified.length === 0,
      unclassified.length ? `unclassified: ${unclassified.join(',')}` : `${BUILTIN_TOOLS.length} tools classified`,
    );
    for (const t of BUILTIN_TOOLS) {
      if (!toolClass(t.name)) ok(`tool "${t.name}" has a class`, false);
    }
    ok('all built-in tools have a class', BUILTIN_TOOLS.every((t) => toolClass(t.name) !== undefined));

    section('PART 1b — the classifications that were previously missing');
    // These are the ones the old table omitted. `accept-edits` used to
    // return 'allow' for anything it did not recognise, so all of them
    // were silently authorised in the mode users pick when they mean
    // "auto-approve edits, but let me see the risky ones".
    ok('mcp is classified as escalation', toolClass('mcp') === 'escalate');
    ok('delegate_remote is classified as escalation', toolClass('delegate_remote') === 'escalate');
    ok('subagent is classified as escalation', toolClass('subagent') === 'escalate');
    ok('webFetch is classified as network', toolClass('webFetch') === 'network');
    ok('browser is classified as network', toolClass('browser') === 'network');
    ok('eval is classified as mutation (it writes the ledger)', toolClass('eval') === 'mutate');
    // And the three names the old table listed that do not exist.
    ok('the phantom tool skill_suggest is not in any set',
      ['skill_suggest', 'git_status', 'git_log'].every((n) => toolClass(n) === undefined));

    section('PART 1c — verdicts per mode');
    ok('default: read allows', modeAllows('default', 'read') === 'allow');
    ok('default: bash asks', modeAllows('default', 'bash') === 'ask');
    ok('default: edit asks', modeAllows('default', 'edit') === 'ask');
    ok('default: webFetch asks', modeAllows('default', 'webFetch') === 'ask');
    ok('plan: read allows', modeAllows('plan', 'read') === 'allow');
    ok('plan: plan allows', modeAllows('plan', 'plan') === 'allow');
    ok('plan: bash asks', modeAllows('plan', 'bash') === 'ask');
    ok('plan: write asks', modeAllows('plan', 'write') === 'ask');
    ok('accept-edits: edit allows', modeAllows('accept-edits', 'edit') === 'allow');
    ok('accept-edits: bash asks', modeAllows('accept-edits', 'bash') === 'ask');
    ok('accept-edits: mcp asks  (was allow)', modeAllows('accept-edits', 'mcp') === 'ask');
    ok('accept-edits: subagent asks  (was allow)', modeAllows('accept-edits', 'subagent') === 'ask');
    ok('bypass: bash allows', modeAllows('bypass-permissions', 'bash') === 'allow');
    ok('chat_only: bash denies', modeAllows('chat_only', 'bash') === 'deny');
    ok('chat_only: read denies', modeAllows('chat_only', 'read') === 'deny');

    section('PART 1d — the gate fails closed');
    ok('an unknown tool asks under default', modeAllows('default', 'not_a_real_tool') === 'ask');
    ok('an unknown tool asks under accept-edits', modeAllows('accept-edits', 'not_a_real_tool') === 'ask');
    ok('an unknown tool asks under plan', modeAllows('plan', 'not_a_real_tool') === 'ask');
    ok('bypass still allows unknown tools (explicit opt-out)', modeAllows('bypass-permissions', 'not_a_real_tool') === 'allow');

    // ─── PART 2 — the gate is installed ─────────────────────────
    section('PART 2 — the agent receives gated tools');
    {
      const registry = scriptedRegistry([
        toolCallTurn('read', { path: 'README.md' }),
        textTurn('done'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = new AgentRunner(registry, session.sessionId, work, {
        cwd: work,
        model_id: 'mock',
        permission_mode: 'default',
        show_surprise: false,
        enable_reflection: false,
      });
      await runner.init();

      const agent = (runner as unknown as { agent: { getState: () => unknown } }).agent;
      void agent;
      // Reach the tools the runner handed to the Agent.
      const h = (runner.harness ?? {}) as Record<string, unknown>;
      ok('harness is built', h !== null);
      const tools = (runner as unknown as { agent: { tools?: Array<{ name: string; checkPermissions?: unknown }> } }).agent.tools;
      ok('the agent has a tool list', Array.isArray(tools) && tools.length >= BUILTIN_TOOLS.length,
        `${tools?.length} tools`);
      const ungated = (tools ?? []).filter((t) => typeof t.checkPermissions !== 'function');
      ok('every tool the agent holds has a checkPermissions hook',
        ungated.length === 0,
        ungated.length ? `ungated: ${ungated.map((t) => t.name).join(',')}` : `${tools?.length}/${tools?.length} gated`);
    }

    // ─── PART 3 — a real turn stops and asks ────────────────────
    section('PART 3 — a real turn under `default` mode asks before running bash');
    {
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: `echo pwned > ${canary}` }),
        textTurn('I was not allowed to run that.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = new AgentRunner(registry, session.sessionId, work, {
        cwd: work,
        model_id: 'mock',
        permission_mode: 'default',
        show_surprise: false,
        enable_reflection: false,
      });
      await runner.init();

      const events: Array<Record<string, unknown>> = [];
      runner.runTurn('delete everything', (ev) => { events.push(ev as unknown as Record<string, unknown>); });
      if (process.env.V03_DEBUG) {
        console.log('[v03-debug] PART 3 events:', JSON.stringify(events, null, 1).slice(0, 2000));
      }
      // Do NOT await the turn yet — it is suspended inside
      // checkPermissions() waiting for a decision that only this test
      // can supply. Wait for the prompt to appear, assert the shell
      // has NOT run, then answer it.
      const got = await waitFor(() => events.some((e) => e.type === 'permission_request'), 5000);
      ok('the turn blocks and emits permission_request', got);

      const reqs = events.filter((e) => e.type === 'permission_request');
      ok('exactly one permission_request was emitted', reqs.length === 1, `got ${reqs.length}`);
      ok('the request names the bash tool', reqs[0]?.tool_name === 'bash', String(reqs[0]?.tool_name));
      ok('the request carries a request_id', typeof reqs[0]?.request_id === 'string' && (reqs[0]?.request_id as string).length > 0);
      ok('the request carries the tool input', (reqs[0]?.tool_input as { command?: string })?.command?.includes('echo pwned') === true);

      // The critical assertion: the shell never ran while the prompt
      // was on screen.
      ok('the bash command did NOT execute while prompting (no canary file)', !existsSync(canaryPath));
      ok('the runner still reports busy', runner.isBusy());

      // Now deny it, as the UI would, and confirm the turn completes.
      runner.resolvePermission(reqs[0]?.request_id as string, 'deny');
      await runner.waitForCurrentTurn();
      ok('the bash command still did not execute after deny', !existsSync(canaryPath));
      ok('the runner is no longer busy', !runner.isBusy());
      const resolved = events.filter((e) => e.type === 'permission_resolved');
      ok('a permission_resolved ack was emitted', resolved.length === 1, `got ${resolved.length}`);
    }

    // ─── PART 4 — allow path works too ──────────────────────────
    section('PART 4 — approving the request lets the tool run');
    {
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: `echo ok > ${canary}` }),
        textTurn('ran it.'),
      ]);
      const session = await SessionManager.create(work, 'mock', 'mock');
      const runner = new AgentRunner(registry, session.sessionId, work, {
        cwd: work,
        model_id: 'mock',
        permission_mode: 'default',
        show_surprise: false,
        enable_reflection: false,
      });
      await runner.init();

      const events: Array<Record<string, unknown>> = [];
      runner.runTurn('write the canary', (ev) => { events.push(ev as unknown as Record<string, unknown>); });

      // Wait for the prompt, then approve it.
      const appeared = await waitFor(() => events.some((e) => e.type === 'permission_request'), 5000);
      const req = events.find((e) => e.type === 'permission_request');
      ok('permission_request appeared', appeared && req !== undefined);
      runner.resolvePermission(req?.request_id as string, 'allow');
      await runner.waitForCurrentTurn();
      ok('after allow, the bash command DID execute', existsSync(canaryPath));
    }

    // ─── PART 5 — bypass really skips the prompt ────────────────
    section('PART 5 — bypass-permissions never prompts');
    {
      const registry = scriptedRegistry([
        toolCallTurn('bash', { command: `echo ok > ${canary}` }),
        textTurn('ran it.'),
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
      runner.runTurn('write the canary', (ev) => { events.push(ev as unknown as Record<string, unknown>); });
      await runner.waitForCurrentTurn();
      ok('no permission_request under bypass', !events.some((e) => e.type === 'permission_request'));
      ok('the command ran without a prompt', existsSync(canaryPath));
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[31mv0.3-permission-gate-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mv0.3-permission-gate-test PASSED\x1b[0m');
}

main().catch((err) => {
  console.error('v0.3-permission-gate-test crashed:', err);
  process.exit(1);
});
