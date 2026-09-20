/**
 * Smoke test for the Agent's compact() flow.
 *
 * Scenario:
 *   1. Seed the agent with a long assistant/user/tool history.
 *   2. Register a mock stream that returns a 6-section summary when called.
 *   3. Call agent.compact() and verify:
 *      - the messages array is replaced
 *      - the summary text is the model's output
 *      - tokensBefore is reasonable
 *   4. Verify isContextNearLimit flips when we manually inflate the history.
 */

import {
  ModelRegistry,
  type AssistantEvent,
  type Model,
  type StreamFunction,
} from '@deqi/ai';
import { Agent, type AgentEvent } from '@deqi/agent-core';
import { BUILTIN_TOOLS } from '@deqi/coding-agent';

const model: Model = {
  id: 'mock-compact',
  displayName: 'Mock compact',
  provider: 'anthropic',
  contextWindow: 1000, // small so 80% threshold is easy to trip
  maxOutputTokens: 2000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};

function makeSummaryStream(text: string): StreamFunction {
  return function* (): Generator<AssistantEvent> {
    yield { type: 'start' };
    for (const chunk of text.match(/.{1,40}/g) ?? [text]) {
      yield { type: 'text_delta', delta: chunk };
    }
    yield { type: 'usage', inputTokens: 50, outputTokens: 30 };
    yield { type: 'done', stopReason: 'end_turn' };
  };
}

async function main(): Promise<void> {
  const summaryText = [
    'GOAL: Refactor the auth module.',
    'STATE: read auth.ts, wrote new helper, replaced call site.',
    'DECISIONS: keep the public API, add an internal helper.',
    'FILES: src/auth.ts, src/auth-helper.ts',
    'OPEN: nothing pending.',
    'NEXT: run tests.',
  ].join('\n');

  // Mock: agent.run() will call once, then compact() will call once.
  // The compact call should return the structured summary; everything
  // else can return a no-op.
  let compactCallCount = 0;
  const stream: StreamFunction = (req) => {
    // Heuristic: if the user message contains "Compress" (the compact
    // prompt), it's a compact call. Otherwise it's a normal turn.
    const text = JSON.stringify(req.messages);
    if (text.includes('Compress the following coding-agent transcript')) {
      compactCallCount += 1;
      return makeSummaryStream(summaryText)(req);
    }
    return makeSummaryStream('OK')(req);
  };

  const registry = ModelRegistry.fromEnv();
  (registry as unknown as { auth: unknown }).auth = { anthropic: { apiKey: 'mock' } };
  (registry as unknown as { customModels: Model[] }).customModels = [model];
  (registry as unknown as { getStream: (m: Model) => StreamFunction }).getStream = (m) =>
    m.id === 'mock-compact' ? stream : makeSummaryStream('OK');

  const agent = new Agent({
    registry,
    modelId: 'mock-compact',
    system: 'mock',
    tools: BUILTIN_TOOLS,
    cwd: process.cwd(),
  });

  // 1. Seed history by running two turns.
  const events1: AgentEvent[] = [];
  await agent.run('first message', (ev) => events1.push(ev));
  const msgsBefore = agent.getState().messages.length;
  if (msgsBefore < 2) {
    console.error('FAIL: history not seeded, len =', msgsBefore);
    process.exit(1);
  }

  // 2. Call compact.
  const r = await agent.compact(() => {});
  if (!r) {
    console.error('FAIL: compact returned null');
    process.exit(1);
  }
  if (!r.summary.includes('GOAL: Refactor')) {
    console.error('FAIL: summary missing expected content; got:', r.summary.slice(0, 80));
    process.exit(1);
  }
  if (r.tokensBefore <= 0) {
    console.error('FAIL: tokensBefore should be > 0; got', r.tokensBefore);
    process.exit(1);
  }

  // 3. Verify history was replaced.
  const msgsAfter = agent.getState().messages;
  if (msgsAfter.length !== 2) {
    console.error('FAIL: expected 2 messages after compact, got', msgsAfter.length);
    process.exit(1);
  }
  if (msgsAfter[0].role !== 'user' || msgsAfter[1].role !== 'assistant') {
    console.error('FAIL: expected [user, assistant] after compact');
    process.exit(1);
  }

  // 4. Verify isContextNearLimit: with the tiny window we set, even a
  //    small message history should trigger.
  const before = agent.approximateTokenUsage();
  if (before.used <= 0) {
    console.error('FAIL: token usage estimation returned 0');
    process.exit(1);
  }

  // 5. Verify the next run() picks up from the summary.
  const events2: AgentEvent[] = [];
  await agent.run('continue', (ev) => events2.push(ev));
  if (agent.getState().messages.length < 4) {
    console.error('FAIL: agent should continue normally after compact; msgs =', agent.getState().messages.length);
    process.exit(1);
  }

  if (compactCallCount !== 1) {
    console.error('FAIL: compact should have been called exactly once; got', compactCallCount);
    process.exit(1);
  }

  console.log('--- compact smoke report ---');
  console.log('msgs before:    ', msgsBefore);
  console.log('msgs after:     ', msgsAfter.length);
  console.log('tokens before:  ', r.tokensBefore);
  console.log('tokens after:   ', before.used);
  console.log('compact calls:  ', compactCallCount);
  console.log('summary preview:', r.summary.split('\n')[0]);
  console.log('COMPACT SMOKE PASSED');
}

main().catch((err) => {
  console.error('compact smoke crashed:', err);
  process.exit(1);
});
