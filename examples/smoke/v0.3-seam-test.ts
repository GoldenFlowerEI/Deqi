/**
 * v0.3-seam-test.ts — the first test that constructs a real AgentRunner.
 *
 * Why this file exists
 * --------------------
 * Every other harness test unit-tests objects in isolation. They build
 * their own stubs and hand them to a tool, so they cannot detect whether
 * the *runner* actually provides what the tool needs. That blind spot hid
 * three permanently-broken tools for an entire release cycle:
 *
 *   - session_history  → reads ctx.harness.session  → always errored
 *   - self_reflect     → reads ctx.harness.session  → always errored
 *   - user_model       → reads ctx.harness.userModel → always errored
 *
 * Meanwhile the system prompt explicitly instructs the model to call
 * self_reflect (on 3rd failure) and the tool descriptions are otherwise
 * ordinary. The agent was being told to use tools that could not work.
 *
 * What this asserts
 * -----------------
 *   1. The harness the runner builds contains every key the built-in
 *      tools read. This is the assertion that would have caught it.
 *   2. The three tools, driven with the runner's REAL harness, return
 *      success rather than the "requires X via the harness" error.
 *   3. The session manager in the harness is the same one the runner
 *      uses for persistence (not a copy).
 *   4. The UserModel accumulates observations across turns.
 *
 * Runs against dist/ like the other smoke tests, so `bun run build` must
 * have happened first.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRegistry } from '../../packages/ai/dist/index.js';
import {
  SessionManager,
  sessionHistoryTool,
  selfReflectTool,
  userModelTool,
} from '../../packages/coding-agent/dist/src/index.js';
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

function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.map((b) => (b.type === 'text' ? b.text ?? '' : '')).join('');
}

async function main(): Promise<void> {
  // Isolate HOME so the session JSONL and any ~/.deqi reads land in a
  // temp dir rather than the developer's real profile.
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v03-seam-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const work = mkdtempSync(join(tmpdir(), 'deqi-v03-work-'));
  writeFileSync(join(work, 'README.md'), '# seam test project\n', 'utf8');
  mkdirSync(join(work, 'src'), { recursive: true });

  try {
    section('construct a real AgentRunner');
    const registry = new ModelRegistry({ mock: { model: 'mock' } });
    const session = await SessionManager.create(work, 'mock', 'mock');

    const runner = new AgentRunner(registry, session.sessionId, work, {
      cwd: work,
      model_id: 'mock',
      permission_mode: 'bypass-permissions',
      show_surprise: false,
      enable_reflection: true,
    });
    await runner.init();

    ok('runner.init() completes', true);
    ok('runner.harness is populated after init', runner.harness !== null);

    // ─── 1. every key the built-in tools actually read ──────────────
    section('harness completeness — the assertion that would have caught it');
    const h = (runner.harness ?? {}) as Record<string, unknown>;
    ok('harness.subagent present', typeof h.subagent === 'object' && h.subagent !== null);
    ok('harness.orchestrator present', typeof h.orchestrator === 'object' && h.orchestrator !== null);
    ok('harness.cache present', typeof h.cache === 'object' && h.cache !== null);
    ok('harness.reflector present', typeof h.reflector === 'function');
    ok('harness.cluster present', typeof h.cluster === 'object' && h.cluster !== null);
    ok('harness.session present  (session_history, self_reflect)', h.session != null);
    ok('harness.userModel present (user_model)', h.userModel != null);

    // ─── 2. the three previously-broken tools, real harness ────────
    section('the three dead tools, driven with the runner\'s real harness');
    const ctx = {
      cwd: work,
      signal: new AbortController().signal,
      messages: [],
      log: () => {},
      harness: h,
    } as never;

    // Seed through the RUNNER's session, not the local `session` handle.
    // `AgentRunner.init()` re-resolves its own SessionManager from disk by
    // id (resolveSessionById), so the two objects are distinct instances
    // with independent in-memory `entries` arrays over one file. Appending
    // to the local handle writes the file but leaves the runner's copy
    // stale — which is exactly the trap this test exists to avoid.
    const runnerSession = (runner as unknown as { session: typeof session }).session;
    await runnerSession.appendUserMessage('what does this project do?');

    const hist = await sessionHistoryTool.execute({ limit: 5 }, ctx);
    const histText = textOf(hist);
    ok('session_history does NOT return the harness error',
      !histText.includes('requires a SessionManager'),
      histText.slice(0, 60));
    ok('session_history is not an error', hist.isError !== true);
    ok('session_history returns the seeded message',
      histText.includes('what does this project do'));

    const refl = await selfReflectTool.execute({ limit: 3 }, ctx);
    const reflText = textOf(refl);
    ok('self_reflect does NOT return the harness error',
      !reflText.includes('requires a SessionManager'),
      reflText.slice(0, 60));
    ok('self_reflect is not an error', refl.isError !== true);
    ok('self_reflect handles the empty case gracefully',
      reflText.includes('no reflections yet') || reflText.includes('reflection'));

    const um = await userModelTool.execute({}, ctx);
    const umText = textOf(um);
    ok('user_model does NOT return the harness error',
      !umText.includes('requires a UserModel'),
      umText.slice(0, 60));
    ok('user_model is not an error', um.isError !== true);
    ok('user_model reports a topic distribution', umText.includes('Distribution'));
    ok('user_model reports the observation count', /Prompts observed:\s*\d+/.test(umText));

    // ─── 3. identity of the session manager ────────────────────────
    section('the harness session IS the runner\'s session (not a copy)');
    ok('harness.session is a SessionManager', typeof (h.session as { getEntries?: unknown })?.getEntries === 'function');
    // Reference identity, not just id equality: the id is derived from the
    // filename so it matches trivially. What matters is that a write
    // through the runner's session is visible to the tools, which is why
    // the seeding above goes through `runnerSession`.
    ok('harness.session is reference-identical to runner.session',
      h.session === runnerSession);
    ok('harness.session and the created session share the leaf id',
      (h.session as { sessionId?: string })?.sessionId === session.sessionId,
      `${(h.session as { sessionId?: string })?.sessionId} vs ${session.sessionId}`);

    // ─── 4. UserModel accumulates ──────────────────────────────────
    section('UserModel accumulates observations across turns');
    const before = (h.userModel as { size(): number }).size();
    (h.userModel as { observe(t: string): unknown }).observe('refactor the auth module');
    (h.userModel as { observe(t: string): unknown }).observe('write a benchmark script');
    const after = (h.userModel as { size(): number }).size();
    ok('observation count increases', after === before + 2, `${before} -> ${after}`);

    // ─── 5. regression guard for the exact bug ─────────────────────
    section('regression guard');
    {
      // If someone removes session/userModel from the harness again, the
      // three tools above start failing — but assert the failure mode
      // explicitly so the message is self-explanatory in CI output.
      const missing = { ...h };
      delete missing.session;
      delete missing.userModel;
      const brokenCtx = { ...(ctx as object), harness: missing } as never;
      const brokenHist = textOf(await sessionHistoryTool.execute({}, brokenCtx));
      ok('without harness.session the tool DOES fail loudly',
        brokenHist.includes('requires a SessionManager'));
      const brokenUm = textOf(await userModelTool.execute({}, brokenCtx));
      ok('without harness.userModel the tool DOES fail loudly',
        brokenUm.includes('requires a UserModel'));
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n\x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('\x1b[1mv0.3-seam-test FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[1mv0.3-seam-test PASSED\x1b[0m');
}

main().catch((err) => {
  console.error('v0.3-seam-test crashed:', err);
  process.exit(1);
});
