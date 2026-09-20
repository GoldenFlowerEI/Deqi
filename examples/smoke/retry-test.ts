/**
 * v1.1.2 smoke test: agent-level retry on retryable LLM errors.
 *
 * The 429 / 5xx / network-failure case is the single biggest source of
 * "deqi 崩了" user-facing failures. The agent loop now wraps each
 * stream call in `runWithRetry` (exponential backoff, honors Retry-After,
 * gives up after 3 retries).
 *
 * This test verifies:
 *   1. A stream that yields a retryable error then succeeds — agent
 *      emits "retry 1/3 ..." events and then completes normally.
 *   2. A stream that yields retryable errors forever — agent emits the
 *      final error with "(after 3 retries)" suffix.
 *   3. A non-retryable error is NOT retried.
 *   4. Success on first try — no retry events.
 */

import {
  ModelRegistry,
  type AssistantEvent,
  type Model,
  type StreamFunction,
} from '@deqi/ai';
import { Agent, type AgentEvent } from '@deqi/agent-core';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const FAKE_MODEL: Model = {
  id: 'fake-retry',
  displayName: 'Fake Retry',
  provider: 'openai-compat',
  contextWindow: 8000,
  maxOutputTokens: 1000,
  supportsTools: false,
  supportsImages: false,
  supportsThinking: false,
};

/**
 * Make a stream that:
 *  - First `failures` calls: yield a retryable error event and stop
 *  - On the (failures+1)th call: yield a normal completion
 */
function makeFlakyStream(failures: number, retryable: boolean): StreamFunction {
  let callIdx = 0;
  return async function* (): AsyncIterable<AssistantEvent> {
    callIdx += 1;
    if (callIdx <= failures) {
      yield { type: 'start' };
      yield {
        type: 'error',
        message: `simulated 429 attempt ${callIdx}`,
        retryable,
      };
      return;
    }
    yield { type: 'start' };
    yield { type: 'text_delta', delta: 'recovered' };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
    yield { type: 'done', stopReason: 'end_turn' };
  };
}

function makeAlwaysFailingStream(retryable: boolean): StreamFunction {
  return async function* (): AsyncIterable<AssistantEvent> {
    yield { type: 'start' };
    yield { type: 'error', message: 'perma-fail', retryable };
  };
}

async function runAgent(stream: StreamFunction): Promise<{
  events: AgentEvent[];
  retryMessages: string[];
  finalError: string | null;
}> {
  const registry = ModelRegistry.fromEnv();
  (registry as unknown as { auth: unknown }).auth = {
    'openai-compat': { apiKey: 'mock', baseUrl: 'http://example' },
  };
  (registry as unknown as { customModels: Model[] }).customModels = [FAKE_MODEL];
  (registry as unknown as { getStream: (m: Model) => StreamFunction }).getStream = (m) =>
    m.id === FAKE_MODEL.id ? stream : makeAlwaysFailingStream(false);

  const agent = new Agent({
    registry,
    modelId: FAKE_MODEL.id,
    system: 'You are a test agent.',
    tools: [],
    cwd: process.cwd(),
  });

  const events: AgentEvent[] = [];
  const retryMessages: string[] = [];
  let finalError: string | null = null;
  await agent.run('hi', (ev) => {
    events.push(ev);
    if (ev.type === 'message_update' && ev.event.type === 'error') {
      if (ev.event.message.includes('retry')) {
        retryMessages.push(ev.event.message);
      }
    } else if (ev.type === 'error') {
      finalError = (ev as { message: string }).message;
    }
  });

  return { events, retryMessages, finalError };
}

async function main(): Promise<void> {
  // -- Test 1: 2 failures then success — must retry twice and recover.
  {
    const { retryMessages, finalError } = await runAgent(makeFlakyStream(2, true));
    ok('recovers after 2 retries', !finalError, `error=${finalError}`);
    ok('emits exactly 2 retry events', retryMessages.length === 2, `got ${retryMessages.length}`);
  }

  // -- Test 2: 99 failures (more than max=3) — must give up with "after 3 retries".
  {
    const { retryMessages, finalError } = await runAgent(makeFlakyStream(99, true));
    ok(
      'gives up after 3 retries',
      finalError !== null && finalError.includes('after 3 retries'),
      `error=${finalError}`,
    );
    ok('emits exactly 3 retry events', retryMessages.length === 3, `got ${retryMessages.length}`);
  }

  // -- Test 3: non-retryable error — must NOT retry, must surface immediately.
  {
    const { retryMessages, finalError } = await runAgent(makeAlwaysFailingStream(false));
    ok(
      'non-retryable error does not retry',
      retryMessages.length === 0,
      `got ${retryMessages.length}`,
    );
    ok(
      'surfaces the original error',
      finalError?.includes('perma-fail') ?? false,
      `error=${finalError}`,
    );
  }

  // -- Test 4: success on first try — no retry events.
  {
    const { retryMessages, finalError } = await runAgent(makeFlakyStream(0, true));
    ok('no retries when stream succeeds first try', retryMessages.length === 0);
    ok('no error', !finalError);
  }

  console.log(process.exitCode === 1 ? 'RETRY SMOKE FAILED' : 'RETRY SMOKE PASSED');
}

main().catch((err) => {
  console.error('retry smoke crashed:', err);
  process.exit(1);
});
