/**
 * v0.5 smoke test: TranscendenceLayer (emergent goal generation).
 *
 * Verifies:
 *   1. TranscendenceLayer tracks recent prompts.
 *   2. After REFLECT_EVERY observations, the LLM is called and
 *      emergent goals are proposed into the introspection journal.
 *   3. dismissGoal removes the goal from active list and journal.
 *   4. subscribe() receives new emergent goals.
 *   5. The 'NONE' response is handled correctly (no goals proposed).
 *   6. End-to-end: when a prompt is observed, the new goals are
 *      available via listEmergentGoals() and registered in the
 *      DefaultIntrospectionLayer's goal list.
 */

import {
  ModelRegistry,
  type AssistantEvent,
  type Model,
  type StreamFunction,
} from '@deqi/ai';
import {
  DefaultIntrospectionLayer,
  TranscendenceLayer,
} from '@deqi/introspection';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const TRANSCEND_MODEL = 'mock-transcend-1';
const INTROSPECT_MODEL = 'mock-introspect-1';

const model: Model = {
  id: TRANSCEND_MODEL,
  displayName: 'Mock transcend',
  provider: 'anthropic',
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};
const introModel: Model = {
  ...model,
  id: INTROSPECT_MODEL,
  displayName: 'Mock introspect',
};

const EMERGENT_TEXT = `EMERGENT:
- Add unit tests for the auth flow || user keeps asking about auth || core
- Document the new API in README || user is shipping this || supporting`;

const NONE_TEXT = 'NONE';

function setupRegistry(text: string): ModelRegistry {
  const reg = ModelRegistry.fromEnv();
  (reg as unknown as { auth: unknown }).auth = { anthropic: { apiKey: 'mock' } };
  (reg as unknown as { customModels: Model[] }).customModels = [model, introModel];
  (reg as unknown as { getStream: (m: Model) => StreamFunction }).getStream = () =>
    function* (): Generator<AssistantEvent> {
      yield { type: 'start' };
      for (let i = 0; i < text.length; i += 24) {
        yield { type: 'text_delta', delta: text.slice(i, i + 24) };
      }
      yield { type: 'usage', inputTokens: 5, outputTokens: 5, costUsd: 0.0001 };
      yield { type: 'done', stopReason: 'end_turn' };
    };
  return reg;
}

async function main(): Promise<void> {
  // -- Test 1: basic flow with EMERGENT_TEXT.
  {
    const reg = setupRegistry(EMERGENT_TEXT);
    const intro = new DefaultIntrospectionLayer({ registry: reg, modelId: INTROSPECT_MODEL });
    const tr = new TranscendenceLayer({
      registry: reg,
      modelId: TRANSCEND_MODEL,
      introspection: intro,
      reflectEvery: 2,
    });

    const newGoals1 = await tr.observeUserPrompt('fix the auth login bug');
    ok('first prompt does not yet trigger reflection', newGoals1.length === 0);
    ok('no goals yet', tr.listEmergentGoals().length === 0);

    const newGoals2 = await tr.observeUserPrompt('also document the auth flow');
    ok('second prompt triggers reflection', newGoals2.length === 2);
    ok('goals are stored', tr.listEmergentGoals().length === 2);
    ok('priority "core" preserved', tr.listEmergentGoals().some((g) => g.priority === 'core'));
    ok('priority "supporting" preserved', tr.listEmergentGoals().some((g) => g.priority === 'supporting'));
    ok('rationale captured', tr.listEmergentGoals().some((g) => g.rationale?.includes('auth')));

    // Goals are registered in the introspection layer.
    const journal = await intro.listGoals();
    ok('introspection journal has the goals', journal.length === 2);

    // -- Test 2: dismissGoal removes from active list.
    const target = tr.listEmergentGoals()[0]!.id;
    const ok2 = await tr.dismissGoal(target);
    ok('dismissGoal returns true on success', ok2);
    ok('listEmergentGoals no longer shows it', tr.listEmergentGoals().length === 1);
    const after = await intro.listGoals();
    ok('introspection journal no longer has it', after.length === 1);

    // -- Test 3: subscribe() receives events.
    const events: string[] = [];
    const unsub = tr.onEmergentGoal((g) => events.push(g.description));
    // The 3rd prompt won't trigger because reflectEvery=2, but the 4th will.
    await tr.observeUserPrompt('third');
    await tr.observeUserPrompt('fourth');
    ok('subscribe received a new goal', events.length > 0);
    unsub();
  }

  // -- Test 4: NONE response yields no goals.
  {
    const reg = setupRegistry(NONE_TEXT);
    const intro = new DefaultIntrospectionLayer({ registry: reg, modelId: INTROSPECT_MODEL });
    const tr = new TranscendenceLayer({
      registry: reg,
      modelId: TRANSCEND_MODEL,
      introspection: intro,
      reflectEvery: 1,
    });
    await tr.observeUserPrompt('do a thing');
    await tr.observeUserPrompt('do another thing');
    ok('NONE yields no goals', tr.listEmergentGoals().length === 0);
  }

  // -- Test 5: dismissGoal on unknown id returns false.
  {
    const reg = setupRegistry(EMERGENT_TEXT);
    const intro = new DefaultIntrospectionLayer({ registry: reg, modelId: INTROSPECT_MODEL });
    const tr = new TranscendenceLayer({
      registry: reg,
      modelId: TRANSCEND_MODEL,
      introspection: intro,
      reflectEvery: 1,
    });
    await tr.observeUserPrompt('a');
    await tr.observeUserPrompt('b');
    const ok3 = await tr.dismissGoal('no-such-id');
    ok('dismissGoal returns false on unknown id', ok3 === false);
  }

  // -- Test 6: end-to-end through CLI-style wiring.
  {
    const reg = setupRegistry(EMERGENT_TEXT);
    const intro = new DefaultIntrospectionLayer({ registry: reg, modelId: INTROSPECT_MODEL });
    const tr = new TranscendenceLayer({
      registry: reg,
      modelId: TRANSCEND_MODEL,
      introspection: intro,
      reflectEvery: 3,
    });
    const newGoals = await tr.observeUserPrompt('fix auth');
    ok('no goals before reflectEvery', newGoals.length === 0);
    const g1 = await tr.observeUserPrompt('add auth tests');
    const g2 = await tr.observeUserPrompt('document auth flow');
    ok('after 3 prompts, goals proposed', g1.length + g2.length >= 2);
    const all = tr.listEmergentGoals();
    ok('listEmergentGoals has at least 2 active goals', all.length >= 2);
  }

  console.log(process.exitCode === 1 ? 'TRANSCENDENCE SMOKE FAILED' : 'TRANSCENDENCE SMOKE PASSED');
}

main().catch((err) => {
  console.error('transcendence smoke crashed:', err);
  process.exit(1);
});
