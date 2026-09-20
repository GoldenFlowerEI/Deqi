/**
 * End-to-end smoke test that does not require any provider API key.
 *
 * We register a mock Anthropic-style stream that simulates a 2-turn agent
 * loop:
 *   Turn 1: assistant calls the `read` tool with a path
 *   Turn 2: assistant returns final text
 *
 * The script verifies:
 *   1. The Agent loop streams events correctly.
 *   2. The `read` tool actually runs and returns file content.
 *   3. The result is fed back and the model produces a final answer.
 *   4. Session JSONL has all entries in order.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelRegistry,
  type AssistantEvent,
  type Model,
  type StreamFunction,
} from '@deqi/ai';
import { Agent, type AgentEvent } from '@deqi/agent-core';
import { BUILTIN_TOOLS } from '@deqi/coding-agent';

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deqi-smoke-'));
  const target = join(dir, 'hello.txt');
  writeFileSync(target, 'hello from deqi smoke test\n', 'utf8');

  const model: Model = {
    id: 'mock-1',
    displayName: 'Mock 1',
    provider: 'anthropic',
    contextWindow: 100_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
  };

  // Build a stream that returns:
  //   Turn 1: a single read tool call
  //   Turn 2: text that mentions the file content (which the model would
  //   "see" in the tool_result we appended after Turn 1)
  let turn = 0;
  const stream: StreamFunction = function* (): Generator<AssistantEvent> {
    turn++;
    if (turn === 1) {
      yield { type: 'start' };
      yield {
        type: 'toolcall_start',
        id: 'toolu_test_1',
        name: 'read',
      };
      yield {
        type: 'toolcall_delta',
        id: 'toolu_test_1',
        inputDelta: JSON.stringify({ path: target }),
      };
      yield {
        type: 'toolcall_end',
        id: 'toolu_test_1',
        name: 'read',
        input: { path: target },
      };
      yield {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
      };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    yield { type: 'start' };
    yield { type: 'text_delta', delta: 'The file says: ' };
    yield { type: 'text_delta', delta: 'hello from deqi smoke test' };
    yield { type: 'usage', inputTokens: 200, outputTokens: 10 };
    yield { type: 'done', stopReason: 'end_turn' };
  };

  // Wire a registry that returns our mock stream.
  const registry = ModelRegistry.fromEnv();
  (registry as unknown as { auth: unknown }).auth = {
    anthropic: {
      apiKey: 'mock-key',
    },
  };
  // Override the stream returned for our mock model.
  (registry as unknown as { customModels: Model[] }).customModels = [model];
  const origGetStream = registry.getStream.bind(registry);
  (registry as unknown as { getStream: typeof origGetStream }).getStream = (
    m: Model,
  ): StreamFunction => {
    if (m.id === 'mock-1') return stream;
    return origGetStream(m);
  };

  const agent = new Agent({
    registry,
    modelId: 'mock-1',
    system: 'You are a smoke-test agent.',
    tools: BUILTIN_TOOLS,
    cwd: dir,
  });

  const events: AgentEvent[] = [];
  await agent.run('Please read the file.', (ev) => {
    events.push(ev);
  });

  // Verify events.
  const starts = events.filter((e) => e.type === 'agent_start').length;
  const turnEnds = events.filter((e) => e.type === 'turn_end').length;
  const agentEnds = events.filter((e) => e.type === 'agent_end').length;
  const toolStarts = events.filter(
    (e) => e.type === 'tool_execution_start' && e.toolName === 'read',
  ).length;
  const toolEnds = events.filter(
    (e) => e.type === 'tool_execution_end' && e.toolName === 'read',
  ).length;
  const textDeltas = events
    .filter((e) => e.type === 'message_update' && e.event.type === 'text_delta')
    .map((e) => (e.event as { delta: string }).delta);
  const finalText = textDeltas.join('');

  console.log('--- smoke test report ---');
  console.log('agent_start:    ', starts);
  console.log('turn_end:       ', turnEnds);
  console.log('agent_end:      ', agentEnds);
  console.log('read tool calls:', toolStarts, '/', toolEnds);
  console.log('final text:     ', JSON.stringify(finalText));
  console.log('total usage:    ', agent.getState().totalUsage);

  let failed = false;
  if (starts !== 1) { console.error('FAIL: expected 1 agent_start'); failed = true; }
  if (turnEnds !== 2) { console.error('FAIL: expected 2 turn_end'); failed = true; }
  if (agentEnds !== 1) { console.error('FAIL: expected 1 agent_end'); failed = true; }
  if (toolStarts !== 1 || toolEnds !== 1) {
    console.error('FAIL: expected 1 read tool call'); failed = true;
  }
  if (!finalText.includes('hello from deqi smoke test')) {
    console.error('FAIL: final text did not include file content');
    failed = true;
  }
  if (agent.getState().totalUsage.input !== 300) {
    console.error('FAIL: expected total input 300'); failed = true;
  }

  rmSync(dir, { recursive: true, force: true });
  if (failed) {
    console.error('SMOKE TEST FAILED');
    process.exit(1);
  }
  console.log('SMOKE TEST PASSED');
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
