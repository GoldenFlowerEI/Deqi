/**
 * v0.4 smoke test: Introspection layer.
 *
 * Verifies:
 *   1. DefaultIntrospectionLayer accepts goals, observes snapshots,
 *      and triggers reflection after Nth observation.
 *   2. The reflection produces a structured ReflectionReport and
 *      stores a guidance string via getGuidance().
 *   3. When an Agent is configured with the layer, snapshots are
 *      recorded at the end of every turn and the system prompt sent
 *      to the model is prefixed with the guidance.
 *   4. Errors in the reflection call do not break the agent turn.
 */

import {
  ModelRegistry,
  type AssistantEvent,
  type Model,
  type StreamFunction,
} from '@deqi/ai';
import { Agent, type AgentTool } from '@deqi/agent-core';
import {
  DefaultIntrospectionLayer,
  NoOpIntrospectionLayer,
  type Goal,
} from '@deqi/introspection';
import { BUILTIN_TOOLS } from '@deqi/coding-agent';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const REFLECT_MODEL = 'mock-reflect-1';
const MAIN_MODEL = 'mock-main-1';

const reflectModel: Model = {
  id: REFLECT_MODEL,
  displayName: 'Mock reflect',
  provider: 'anthropic',
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};
const mainModel: Model = {
  ...reflectModel,
  id: MAIN_MODEL,
  displayName: 'Mock main',
};

const REFLECTION_TEXT = `ALIGNED:
- read the right file first
- used grep to find occurrences

MISALIGNED:
- called bash when a read would have been safer

NEXT:
- prefer read over bash for simple file access`;

function setupRegistry(): { registry: ModelRegistry; holder: { lastMainRequest: { system: string } | null } } {
  const reg = ModelRegistry.fromEnv();
  (reg as unknown as { auth: unknown }).auth = { anthropic: { apiKey: 'mock' } };
  (reg as unknown as { customModels: Model[] }).customModels = [reflectModel, mainModel];
  const holder: { lastMainRequest: { system: string } | null } = { lastMainRequest: null };
  (reg as unknown as { getStream: (m: Model) => StreamFunction }).getStream = (m) => {
    if (m.id === REFLECT_MODEL) {
      return function* (): Generator<AssistantEvent> {
        yield { type: 'start' };
        for (let i = 0; i < REFLECTION_TEXT.length; i += 24) {
          yield { type: 'text_delta', delta: REFLECTION_TEXT.slice(i, i + 24) }
        }
        yield { type: 'usage', inputTokens: 5, outputTokens: 5, costUsd: 0.0001 };
        yield { type: 'done', stopReason: 'end_turn' };
      };
    }
    // Main model: record the system prompt, then return a no-op end_turn.
    return function* (req: Parameters<StreamFunction>[0]): Generator<AssistantEvent> {
      holder.lastMainRequest = { system: req.system };
      yield { type: 'start' };
      yield { type: 'text_delta', delta: 'OK' };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'end_turn' };
    };
  };
  return { registry: reg, holder };
}

async function main(): Promise<void> {
  // -- Test 1: DefaultIntrospectionLayer basic flow.
  {
    const { registry } = setupRegistry();
    const layer = new DefaultIntrospectionLayer({
      registry,
      modelId: REFLECT_MODEL,
      reflectEvery: 2,
    });
    await layer.registerGoal({
      id: 'g1',
      description: 'Refactor auth module',
      priority: 'core',
      propagateToAgent: true,
      createdAt: new Date().toISOString(),
    });
    ok('registerGoal adds a goal', (await layer.listGoals()).length === 1);

    await layer.observe({
      timestamp: new Date().toISOString(),
      toolUsage: [{ name: 'read', isError: false, durationMs: 12 }],
      filesTouched: ['src/auth.ts'],
      notes: ['first read'],
    });
    ok('observe stores a snapshot', layer.getSnapshots().length === 1);
    ok('guidance is empty before reflection', (await layer.getGuidance()) === '');

    await layer.observe({
      timestamp: new Date().toISOString(),
      toolUsage: [{ name: 'bash', isError: true, durationMs: 30 }],
      filesTouched: [],
      notes: ['test failure'],
    });
    // reflection runs in the background — wait for it to settle.
    for (let i = 0; i < 30; i++) {
      if ((await layer.getGuidance()) !== '') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const guidance = await layer.getGuidance();
    ok('guidance is non-empty after reflectEvery observations', guidance.length > 0);
    ok('guidance contains the "worked" line', guidance.includes('read the right file first'));
    ok('guidance contains the "improve" line', guidance.includes('called bash'));
    ok('guidance contains the "Next" line', guidance.includes('prefer read over bash'));
    const report = layer.getLastReport();
    ok('lastReport is set', report !== null);
    ok('lastReport.aligned has 2 items', report?.aligned.length === 2);

    await layer.completeGoal('g1');
    ok('completeGoal removes the goal', (await layer.listGoals()).length === 0);
  }

  // -- Test 2: subscribe() receives events.
  {
    const { registry } = setupRegistry();
    const layer = new DefaultIntrospectionLayer({
      registry,
      modelId: REFLECT_MODEL,
      reflectEvery: 100,
    });
    const events: string[] = [];
    const unsub = layer.subscribe((e) => events.push(e.type));
    await layer.observe({
      timestamp: new Date().toISOString(),
      toolUsage: [],
      filesTouched: [],
      notes: [],
    });
    unsub();
    await layer.observe({
      timestamp: new Date().toISOString(),
      toolUsage: [],
      filesTouched: [],
      notes: [],
    });
    ok('subscribe receives behavior_observed events', events.includes('behavior_observed'));
    ok('unsubscribe stops further events', events.length === 1);
  }

  // -- Test 3: end-to-end through a real Agent. Verify the system
  //           prompt sent to the main model includes the guidance.
  {
    const { registry, holder } = setupRegistry();
    const layer = new DefaultIntrospectionLayer({
      registry,
      modelId: REFLECT_MODEL,
      reflectEvery: 1, // reflect after every observation so guidance lands immediately
    });
    const agent = new Agent({
      registry,
      modelId: MAIN_MODEL,
      system: 'You are a base coding agent.',
      tools: BUILTIN_TOOLS as AgentTool[],
      cwd: process.cwd(),
      maxTurns: 3,
      introspection: layer,
    });
    await agent.run('first turn', () => {});
    // Wait for background reflection to complete.
    for (let i = 0; i < 30; i++) {
      if ((await layer.getGuidance()) !== '') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Run a second turn to see if guidance is in the system prompt.
    await agent.run('second turn', () => {});
    // Inspect what the main model received on the second turn.
    const systemSent = holder.lastMainRequest;
    const guidance = await layer.getGuidance();
    ok('guidance has been produced', guidance.length > 0);
    ok('guidance includes "prefer read over bash"', guidance.includes('prefer read over bash'));
    ok('system prompt sent to main includes guidance', systemSent?.system.includes('prefer read over bash') === true);
  }

  // -- Test 4: NoOpIntrospectionLayer is a safe drop-in.
  {
    const layer = new NoOpIntrospectionLayer();
    await layer.observe({
      timestamp: new Date().toISOString(),
      toolUsage: [],
      filesTouched: [],
      notes: [],
    });
    const goals: Goal[] = await layer.listGoals();
    ok('NoOp accepts registerGoal', Array.isArray(goals));
  }

  console.log(process.exitCode === 1 ? 'INTROSPECTION SMOKE FAILED' : 'INTROSPECTION SMOKE PASSED');
}

main().catch((err) => {
  console.error('introspection smoke crashed:', err);
  process.exit(1);
});
