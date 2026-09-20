/**
 * v0.7 smoke test: predictive UserModel.
 *
 * v1.1.7 update: the prior is no longer uniform. Chitchat starts
 * at ~40% (we expect a lot of chitchat in a coding agent session),
 * the other 10 topics share the remaining ~60%. This means
 * greetings ("how are you") no longer trigger the 90% false
 * positive surprise banner. Tests below are updated to reflect
 * the new prior.
 *
 * Verifies:
 *   1. UserModel starts with chitchat-heavy distribution.
 *   2. Observing an "auth" prompt bumps the auth probability.
 *   3. Observing a "docs" prompt is a surprise (high surprise score).
 *   4. The model settles: a stream of "auth" prompts converges.
 *   5. isRecentSurprise() flips correctly.
 *   6. userModelTool returns the model state via harness.
 *   7. userModelTool returns isError without harness.
 *   8. v1.1.7: chitchat prompt has low surprise (no false positive).
 */

import {
  UserModel,
  userModelTool,
  USER_MODEL_TOPICS,
} from '@deqi/coding-agent';
import type { ToolExecutionContext } from '@deqi/agent-core';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

function makeCtx(userModel: UserModel | null): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    messages: [],
    log: () => {},
    harness: userModel ? { userModel } : undefined,
  };
}

async function main(): Promise<void> {
  // -- Test 1: chitchat-heavy prior (v1.1.7).
  {
    const m = new UserModel();
    const d = m.getDistribution();
    // Chitchat starts at ~55% so greetings don't produce
    // 90% surprise (banner would always fire on the first
    // chitchat prompt). With 55% prior, surprise = 0.45
    // which is below the 0.5 banner threshold.
    ok('chitchat prior > 0.50 (chitchat-heavy)', d['chitchat'] > 0.50, `chitchat=${(d['chitchat'] * 100).toFixed(1)}%`);
    ok('chitchat prior < 0.65 (not too dominant)', d['chitchat'] < 0.65, `chitchat=${(d['chitchat'] * 100).toFixed(1)}%`);
    // Distribution still sums to 1.
    const total = USER_MODEL_TOPICS.reduce((s, t) => s + d[t], 0);
    ok('distribution sums to 1', Math.abs(total - 1) < 1e-6, `total=${total}`);
    ok('size() starts at 0', m.size() === 0);
  }

  // -- Test 2: auth prompt bumps auth probability.
  {
    const m = new UserModel();
    const before = m.getDistribution()['auth'];
    const obs = m.observe('please check the auth token validation');
    const after = m.getDistribution()['auth'];
    // v1.1.7: chitchat now starts at 55% prior, so a single
    // auth observation doesn't immediately flip the dominant
    // topic — but auth probability must increase significantly.
    ok('auth probability > 3x its prior after 1 observation', after > before * 3, `before=${before.toFixed(3)} after=${after.toFixed(3)}`);
    // After 2 more auth observations, auth becomes dominant.
    m.observe('add auth tests');
    m.observe('document the auth flow');
    ok('after 3 auth prompts, auth topic is dominant', m.dominantTopic() === 'auth', `got=${m.dominantTopic()}`);
  }

  // -- Test 3: a docs prompt after auth is a surprise.
  {
    const m = new UserModel();
    m.observe('check the auth token');
    m.observe('add auth tests');
    const beforeSurprise = m.surprise();
    // Two more surprise observations amplify the EMA.
    m.observe('write a tutorial for the database schema');
    m.observe('compile a deployment guide for production');
    const afterSurprise = m.surprise();
    ok('surprise EMA increased', afterSurprise > beforeSurprise);
    ok('recent surprise flag set', m.isRecentSurprise());
  }

  // -- Test 4: stream of auth prompts converges.
  {
    const m = new UserModel();
    for (let i = 0; i < 10; i++) m.observe('check the auth token');
    const d = m.getDistribution();
    ok('auth probability > 60% after 10 auth prompts', d['auth'] > 0.6, `${(d['auth'] * 100).toFixed(0)}%`);
  }

  // -- Test 5: empty prompt is a no-op.
  {
    const m = new UserModel();
    const before = m.size();
    m.observe('');
    m.observe('   ');
    ok('empty prompt is a no-op', m.size() === before);
  }

  // -- Test 5b (v1.1.7): chitchat prompt has LOW surprise.
  // Pre-v1.1.7, "how are you" produced 90% surprise because the
  // prior was uniform and no keyword matched, so the fallback
  // topic ('explore') had only 1/N ≈ 9% prior. With the
  // chitchat-heavy prior (55%), "how are you" classifies as
  // chitchat → surprise = 1 - 0.55 = 0.45, which is BELOW the
  // banner threshold (0.5). After 2-3 chitchat observations
  // the prior drifts up and surprise drops further.
  {
    const m = new UserModel();
    const obs1 = m.observe('how are you');
    ok('first chitchat: chitchat topic dominant', obs1.dominantTopic === 'chitchat', `got=${obs1.dominantTopic}`);
    ok(
      'first chitchat: surprise < 0.5 (banner stays silent)',
      obs1.surprise < 0.5,
      `surprise=${obs1.surprise.toFixed(3)}`,
    );
    // After a couple chitchat observations, surprise drops further.
    m.observe('thanks');
    m.observe('okay');
    const obs4 = m.observe('hello');
    ok(
      'after 3 chitchat prompts, surprise < 0.4',
      obs4.surprise < 0.4,
      `surprise=${obs4.surprise.toFixed(3)}`,
    );
  }

  // -- Test 5c (v1.1.7): unrecognized prompt (no keywords) is chitchat.
  {
    const m = new UserModel();
    const obs = m.observe('asdf qwerty lorem');
    ok('unrecognized prompt classifies as chitchat', obs.dominantTopic === 'chitchat', `got=${obs.dominantTopic}`);
  }

  // -- Test 6: history records each observation.
  {
    const m = new UserModel();
    m.observe('check auth token');
    m.observe('add tests');
    m.observe('document the API');
    const hist = m.history_();
    ok('history has 3 entries', hist.length === 3);
    ok('history records surprise scores', hist[0].surprise >= 0 && hist[0].surprise <= 1);
  }

  // -- Test 7: userModelTool returns the model state.
  {
    const m = new UserModel();
    m.observe('check the auth token');
    m.observe('add auth tests');
    const r = await userModelTool.execute({}, makeCtx(m));
    ok('tool returns isError=false', r.isError !== true);
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('output names the dominant topic', text.includes('Topic: auth'));
    ok('output lists all topics', text.includes('Distribution:'));
  }

  // -- Test 8: userModelTool full detail.
  {
    const m = new UserModel();
    m.observe('check the auth token');
    m.observe('document the API');
    const r = await userModelTool.execute({ detail: 'full' }, makeCtx(m));
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('full detail includes Recent history', text.includes('Recent history'));
  }

  // -- Test 9: userModelTool without harness returns error.
  {
    const r = await userModelTool.execute({}, makeCtx(null));
    ok('tool without harness returns isError', r.isError === true);
    const text = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    ok('error message mentions UserModel', text.includes('UserModel'));
  }

  // -- Test 10: dominant topic extraction.
  {
    const m = new UserModel();
    m.observe('refactor the auth module');
    m.observe('rename the function');
    m.observe('simplify the code');
    ok('three refactor prompts -> refactor topic', m.dominantTopic() === 'refactor');
  }

  console.log(process.exitCode === 1 ? 'USER-MODEL SMOKE FAILED' : 'USER-MODEL SMOKE PASSED');
}

main().catch((err) => {
  console.error('user-model smoke crashed:', err);
  process.exit(1);
});
