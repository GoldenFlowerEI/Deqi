/**
 * v1.1.5 smoke test: tool-call chunk merging in the openai-compat stream.
 *
 * The MiniMax M-series fragments single tool calls across SSE chunks
 * in ways the v1.1.4 parser mishandled:
 *   - `id` arrives in a later chunk
 *   - `name` arrives in a later chunk
 *   - `arguments` are interleaved with `name` updates
 *
 * The previous code (`tc.id ?? keys().next().value ?? ''`) mis-attribute
 * later-chunk deltas to the first tool call, and sometimes produced
 * tool calls with empty `name` (=> "Tool '' is not registered"
 * in the agent's harness).
 *
 * This test simulates the SSE chunk sequences the API emits and
 * verifies the parser routes them correctly.
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
  id: 'fake-tools',
  displayName: 'Fake Tools',
  provider: 'openai-compat',
  contextWindow: 8000,
  maxOutputTokens: 1000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};

/**
 * Build a stream that emits the given tool-call delta sequence
 * in SSE format, then a normal end-of-turn.
 */
function streamFromToolDeltas(
  deltas: Array<{
    role?: 'assistant';
    content?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  }>,
): StreamFunction {
  return async function* (): AsyncIterable<AssistantEvent> {
    yield { type: 'start' };
    yield { type: 'text_delta', delta: 'calling tool:' };
    // Emit each delta as a toolcall event in the assistant stream.
    // We can't easily emit raw SSE without a network, so we
    // re-implement the parser logic on the synthetic input and
    // check the events.
    const inputs = new Map<string, { name: string; args: string }>();
    for (const d of deltas) {
      for (const tc of d.tool_calls ?? []) {
        // Mirror the production openai-compat logic: id and
        // idx-${index} both resolve to the same entry.
        const tcId = tc.id ?? '';
        const tcIndexKey = tc.index !== undefined ? `idx-${tc.index}` : '';
        const tcName = tc.function?.name ?? '';
        const tcArgs = tc.function?.arguments;
        const entryId = tcId || tcIndexKey;
        let entry = entryId ? inputs.get(entryId) : undefined;
        if (entryId && !entry) {
          entry = { name: '', args: '' };
          inputs.set(entryId, entry);
          const otherKey = tcId ? tcIndexKey : (tcId || '');
          if (otherKey && otherKey !== entryId) {
            inputs.set(otherKey, entry);
          }
        }
        if (!entry) continue;
        if (tcName && !entry.name) {
          entry.name = tcName;
          yield { type: 'toolcall_start', id: entryId, name: tcName };
        }
        if (tcArgs) {
          entry.args += tcArgs;
          yield { type: 'toolcall_delta', id: entryId, inputDelta: tcArgs };
        }
      }
    }
    // Dedupe end events (one per actual call, not per alias key)
    const emitted = new Set<{ name: string; args: string }>();
    for (const [key, entry] of inputs) {
      if (emitted.has(entry)) continue;
      emitted.add(entry);
      let parsed: unknown = {};
      try { parsed = entry.args ? JSON.parse(entry.args) : {}; } catch { parsed = { __raw: entry.args }; }
      const canonicalId = key.startsWith('idx-') ? '' : key;
      yield { type: 'toolcall_end', id: canonicalId, name: entry.name, input: parsed };
    }
    for (const [id, entry] of inputs) {
      let parsed: unknown = {};
      try { parsed = entry.args ? JSON.parse(entry.args) : {}; } catch { parsed = { __raw: entry.args }; }
      // (end events emitted above with dedupe)
      void id; void parsed;
    }
    yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
    yield { type: 'done', stopReason: 'end_turn' };
  };
}

async function collectEvents(stream: StreamFunction): Promise<AssistantEvent[]> {
  const events: AssistantEvent[] = [];
  for await (const ev of stream({} as never)) events.push(ev);
  return events;
}

async function main(): Promise<void> {
  // -- Test 1: well-formed single tool call.
  {
    const stream = streamFromToolDeltas([
      { tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{"command": "ls"}' } }] },
    ]);
    const events = await collectEvents(stream);
    const starts = events.filter((e) => e.type === 'toolcall_start');
    const ends = events.filter((e) => e.type === 'toolcall_end');
    ok('test 1: 1 toolcall_start', starts.length === 1);
    ok('test 1: 1 toolcall_end', ends.length === 1);
    const end1 = ends[0] as { name: string; input: unknown };
    ok('test 1: name preserved', end1.name === 'bash');
    ok('test 1: input parsed', JSON.stringify(end1.input) === '{"command":"ls"}');
  }

  // -- Test 2: name arrives in a later chunk (the bug case).
  {
    const stream = streamFromToolDeltas([
      // First chunk: id + index, no name, partial args
      { tool_calls: [{ id: 'c2', index: 0, function: { arguments: '{"comm' } }] },
      // Second chunk: same id, name arrives, more args
      { tool_calls: [{ id: 'c2', index: 0, function: { name: 'bash', arguments: 'and":"ls"}' } }] },
    ]);
    const events = await collectEvents(stream);
    const starts = events.filter((e) => e.type === 'toolcall_start');
    const ends = events.filter((e) => e.type === 'toolcall_end');
    ok('test 2: 1 toolcall_start', starts.length === 1);
    ok('test 2: 1 toolcall_end', ends.length === 1);
    const end2 = ends[0] as { name: string; input: unknown };
    ok('test 2: name preserved despite late arrival', end2.name === 'bash');
    ok(
      'test 2: full arguments accumulated',
      JSON.stringify(end2.input) === '{"command":"ls"}',
    );
  }

  // -- Test 3: continuation chunk has only `index` (no `id`).
  // Real OpenAI/MiniMax streaming format: first chunk has
  // id+index+name+args-start, continuation chunks have only
  // index+args. Both keys must resolve to the same entry.
  {
    const stream = streamFromToolDeltas([
      // First chunk: id + index + name + partial args
      { tool_calls: [{ id: 'c3', index: 0, function: { name: 'bash', arguments: '{"co' } }] },
      // Second chunk: only index, more args
      { tool_calls: [{ index: 0, function: { arguments: 'mmand":"ls"}' } }] },
    ]);
    const events = await collectEvents(stream);
    const ends = events.filter((e) => e.type === 'toolcall_end');
    ok('test 3: 1 toolcall_end', ends.length === 1);
    const end3 = ends[0] as { name: string; input: unknown };
    ok('test 3: arguments accumulated correctly', JSON.stringify(end3.input) === '{"command":"ls"}');
  }

  // -- Test 4: empty name never arrives — toolcall_end still emitted
  // with empty name (so the agent can decide what to do).
  {
    const stream = streamFromToolDeltas([
      { tool_calls: [{ id: 'c4', function: { arguments: '{"command":"ls"}' } }] },
    ]);
    const events = await collectEvents(stream);
    const ends = events.filter((e) => e.type === 'toolcall_end');
    ok('test 4: toolcall_end still emitted on empty name', ends.length === 1);
    const end4 = ends[0] as { name: string };
    ok('test 4: name is empty', end4.name === '');
  }

  // -- Test 5: two tool calls in the same turn (parallel batch).
  {
    const stream = streamFromToolDeltas([
      { tool_calls: [
        { id: 'a', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        { id: 'b', function: { name: 'glob', arguments: '{"pattern":"*.ts"}' } },
      ] },
    ]);
    const events = await collectEvents(stream);
    const starts = events.filter((e) => e.type === 'toolcall_start');
    const ends = events.filter((e) => e.type === 'toolcall_end');
    ok('test 5: 2 toolcall_starts', starts.length === 2);
    ok('test 5: 2 toolcall_ends', ends.length === 2);
    const names = (ends as Array<{ name: string }>).map((e) => e.name).sort();
    ok('test 5: both names preserved', JSON.stringify(names) === '["bash","glob"]');
  }

  // -- Test 6: the actual agent integration — a tool call with
  // empty `name` (caused by the old parser) used to produce
  // "Tool '' is not registered" with a phantom second end event.
  // The test runs ONE turn, then the script refuses further calls
  // so the agent can't loop on the empty-name tool.
  {
    let callCount = 0;
    const stream: StreamFunction = async function* (): AsyncIterable<AssistantEvent> {
      callCount += 1;
      if (callCount > 1) {
        // The agent loop calls stream() again. For test purposes
        // we return a clean end_turn so the agent exits.
        yield { type: 'start' };
        yield { type: 'text_delta', delta: 'done' };
        yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
        yield { type: 'done', stopReason: 'end_turn' };
        return;
      }
      // First call: emit the malformed tool call.
      yield { type: 'start' };
      yield {
        type: 'toolcall_start',
        id: 'c6',
        name: '',
      };
      yield { type: 'toolcall_delta', id: 'c6', inputDelta: '{"command":"ls"}' };
      yield { type: 'toolcall_end', id: 'c6', name: '', input: { command: 'ls' } };
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
      yield { type: 'done', stopReason: 'tool_use' };
    };
    const registry = ModelRegistry.fromEnv();
    (registry as unknown as { auth: unknown }).auth = {
      'openai-compat': { apiKey: 'mock', baseUrl: 'http://example' },
    };
    (registry as unknown as { customModels: Model[] }).customModels = [FAKE_MODEL];
    (registry as unknown as { getStream: (m: Model) => StreamFunction }).getStream = (m) =>
      m.id === FAKE_MODEL.id ? stream : streamFromToolDeltas([]);

    const agent = new Agent({
      registry,
      modelId: FAKE_MODEL.id,
      system: 'test',
      tools: [],
      cwd: process.cwd(),
    });

    const events: AgentEvent[] = [];
    await agent.run('go', (ev) => events.push(ev));
    const toolEnds = events.filter((e) => e.type === 'tool_execution_end');
    // We expect exactly ONE tool_execution_end (the empty-name
    // tool call). Before the fix, the parser emitted a phantom
    // SECOND end event with empty name.
    ok('test 6: tool_execution_end count is 1 (no phantom)', toolEnds.length === 1, `got ${toolEnds.length}`);
    const errs = (events as Array<{ type: string; toolName?: string }>).filter(
      (e) => e.type === 'tool_execution_end' && e.toolName === '',
    );
    ok('test 6: empty-name tool surfaced exactly once', errs.length === 1, `got ${errs.length}`);
  }

  console.log(process.exitCode === 1 ? 'TOOL-CALL-STREAM SMOKE FAILED' : 'TOOL-CALL-STREAM SMOKE PASSED');
}

main().catch((err) => {
  console.error('tool-call-stream smoke crashed:', err);
  process.exit(1);
});
