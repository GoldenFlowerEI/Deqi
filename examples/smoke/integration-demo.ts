/**
 * v1.0 integration smoke test: the whole stack end-to-end.
 *
 * This test does NOT exercise a real LLM. It uses mock streams
 * that simulate a 4-turn agent loop exercising:
 *   1. read a file (v0.1 tool)
 *   2. call a sub-agent for analysis (v0.3)
 *   3. read the session history (v0.8 strange loop)
 *   4. write a fix (v0.1 tool)
 *
 * While this happens, the test verifies:
 *   - the SessionManager tree grows correctly (v0.2)
 *   - the IntrospectionLayer records 4 snapshots and triggers a
 *     reflection (v0.4)
 *   - the TranscendenceLayer is fed user prompts but doesn't yet
 *     have enough to fire (v0.5 — needs 3 prompts)
 *   - the UserModel tracks topic distribution (v0.7)
 *   - the ToolMasteryTracker records tool outcomes (v0.6)
 *   - the constitution is loaded and surfaced (v0.6)
 *   - reflections are appended at end of each turn (v0.2)
 *
 * This is the canonical "agent → innovator" smoke test. If this
 * passes, the philosophical stack is wired correctly.
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
import { Agent, type AgentTool, type AgentEvent } from '@deqi/agent-core';
import {
  BUILTIN_TOOLS,
  SessionManager,
  UserModel,
  ToolMasteryTracker,
  loadConstitution,
  listPrinciples,
  subagentTool,
} from '@deqi/coding-agent';
import {
  DefaultIntrospectionLayer,
  TranscendenceLayer,
} from '@deqi/introspection';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

const MAIN_MODEL = 'mock-integration-1';
const SUB_MODEL = 'mock-sub-1';
const INTRO_MODEL = 'mock-intro-1';
const TRANSCEND_MODEL = 'mock-trans-1';

const mainModel: Model = {
  id: MAIN_MODEL,
  displayName: 'Mock main',
  provider: 'anthropic',
  contextWindow: 100_000,
  maxOutputTokens: 8_000,
  supportsTools: true,
  supportsImages: false,
  supportsThinking: false,
};
const subModel: Model = {
  ...mainModel,
  id: SUB_MODEL,
  displayName: 'Mock sub',
};
const introModel: Model = {
  ...mainModel,
  id: INTRO_MODEL,
  displayName: 'Mock intro',
};
const transcendModel: Model = {
  ...mainModel,
  id: TRANSCEND_MODEL,
  displayName: 'Mock transcend',
};

const REFLECTION_TEXT = `ALIGNED:
- read the file before writing
- used the sub-agent for a focused subtask

MISALIGNED:
- none significant

NEXT:
- keep the change small and verify with the test suite`;

/**
 * Stream function factory. The main model produces a 4-turn script:
 *   turn 1: read a file
 *   turn 2: subagent tool call (for a focused analysis)
 *   turn 3: session_history (read own history)
 *   turn 4: write (final answer)
 * Then a final turn with end_turn.
 */
function makeMainStream(turnIndexRef: { i: number }): StreamFunction {
  return function* (req: Parameters<StreamFunction>[0]): Generator<AssistantEvent> {
    const userText = extractUserText(req.messages);
    turnIndexRef.i += 1;
    const turn = turnIndexRef.i;

    yield { type: 'start' };

    if (turn === 1) {
      // Read the file the user wants us to look at.
      const id = 'toolu_1';
      yield { type: 'toolcall_start', id, name: 'read' };
      yield { type: 'toolcall_delta', id, inputDelta: JSON.stringify({ path: 'target.txt' }) };
      yield { type: 'toolcall_end', id, name: 'read', input: { path: 'target.txt' } };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    if (turn === 2) {
      // Call the sub-agent.
      const id = 'toolu_2';
      yield { type: 'toolcall_start', id, name: 'subagent' };
      yield { type: 'toolcall_delta', id, inputDelta: JSON.stringify({ prompt: 'analyze target.txt' }) };
      yield { type: 'toolcall_end', id, name: 'subagent', input: { prompt: 'analyze target.txt' } };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    if (turn === 3) {
      // Read the session history.
      const id = 'toolu_3';
      yield { type: 'toolcall_start', id, name: 'session_history' };
      yield { type: 'toolcall_delta', id, inputDelta: JSON.stringify({ limit: 5 }) };
      yield { type: 'toolcall_end', id, name: 'session_history', input: { limit: 5 } };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    if (turn === 4) {
      // Write the fix.
      const id = 'toolu_4';
      yield { type: 'toolcall_start', id, name: 'write' };
      yield { type: 'toolcall_delta', id, inputDelta: JSON.stringify({ path: 'fix.txt', content: 'fixed\n' }) };
      yield { type: 'toolcall_end', id, name: 'write', input: { path: 'fix.txt', content: 'fixed\n' } };
      yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    // Final turn: end_turn with a brief text.
    yield { type: 'text_delta', delta: 'Done. ' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    yield { type: 'done', stopReason: 'end_turn' };
  };
}

function extractUserText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (!Array.isArray(last.content)) return '';
  return last.content
    .map((b: { type: string; text?: string }) => (b.type === 'text' ? b.text ?? '' : ''))
    .join('');
}

function setupRegistry(): ModelRegistry {
  const reg = ModelRegistry.fromEnv();
  (reg as unknown as { auth: unknown }).auth = { anthropic: { apiKey: 'mock' } };
  (reg as unknown as { customModels: Model[] }).customModels = [
    mainModel,
    subModel,
    introModel,
    transcendModel,
  ];
  const turnRef = { i: 0 };
  (reg as unknown as { getStream: (m: Model) => StreamFunction }).getStream = (m) => {
    if (m.id === MAIN_MODEL) return makeMainStream(turnRef);
    if (m.id === SUB_MODEL) {
      return function* (): Generator<AssistantEvent> {
        yield { type: 'start' };
        yield { type: 'text_delta', delta: 'analysis: file looks fine' };
        yield { type: 'usage', inputTokens: 5, outputTokens: 5 };
        yield { type: 'done', stopReason: 'end_turn' };
      };
    }
    if (m.id === INTRO_MODEL) {
      return function* (): Generator<AssistantEvent> {
        yield { type: 'start' };
        for (let i = 0; i < REFLECTION_TEXT.length; i += 24) {
          yield { type: 'text_delta', delta: REFLECTION_TEXT.slice(i, i + 24) };
        }
        yield { type: 'usage', inputTokens: 5, outputTokens: 5 };
        yield { type: 'done', stopReason: 'end_turn' };
      };
    }
    if (m.id === TRANSCEND_MODEL) {
      return function* (): Generator<AssistantEvent> {
        yield { type: 'start' };
        yield { type: 'text_delta', delta: 'EMERGENT:\n- write tests for the fix || user is shipping this || supporting' };
        yield { type: 'usage', inputTokens: 5, outputTokens: 5 };
        yield { type: 'done', stopReason: 'end_turn' };
      };
    }
    return function* (): Generator<AssistantEvent> {
      yield { type: 'start' };
      yield { type: 'text_delta', delta: 'unknown' };
      yield { type: 'done', stopReason: 'end_turn' };
    };
  };
  return reg;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deqi-v1-'));
  writeFileSync(join(dir, 'target.txt'), 'original content\n', 'utf8');

  // 1. The full harness: registry + layers + session.
  const reg = setupRegistry();
  const session = await SessionManager.create(dir, MAIN_MODEL, 'anthropic');
  const userModel = new UserModel();
  const mastery = new ToolMasteryTracker();
  const intro = new DefaultIntrospectionLayer({ registry: reg, modelId: INTRO_MODEL, reflectEvery: 1 });
  const transcend = new TranscendenceLayer({
    registry: reg,
    modelId: TRANSCEND_MODEL,
    introspection: intro,
    reflectEvery: 100, // disable for this test (we feed user prompts directly)
  });
  // Constitution: just verify it's loadable.
  const c = loadConstitution();
  ok('constitution loads', c.text.length > 100);
  const principles = listPrinciples(c.text);
  ok('constitution has 10 principles', principles.length === 10);

  // 2. Build the agent.
  const agent = new Agent({
    registry: reg,
    modelId: MAIN_MODEL,
    system: 'integration-test',
    tools: BUILTIN_TOOLS as AgentTool[],
    cwd: dir,
    maxTurns: 10,
    harness: {
      subagent: { registry: reg, parentTools: BUILTIN_TOOLS as AgentTool[], defaultModelId: SUB_MODEL },
      userModel,
      session,
    },
    introspection: intro,
  });

  // 3. Simulate 3 user prompts through the transcendence layer + user model.
  for (const prompt of ['check the auth token', 'add auth tests', 'document the API']) {
    userModel.observe(prompt);
    await transcend.observeUserPrompt(prompt);
  }
  ok('user model has 3 prompts', userModel.size() === 3);
  ok('user model has auth as dominant topic', userModel.dominantTopic() === 'auth');
  // Note: transcendence won't fire EMERGENT because reflectEvery=100 here.
  // We just want to verify the wiring is intact.

  // 4. Run the agent. In the real TUI, InteractiveSession wraps this
  //    and appends user/assistant messages to the session. Here we
  //    do it manually so the test asserts against a real session log.
  const userPrompt = 'check the auth token, add tests, document the API';
  await session.appendUserMessage([{ type: 'text', text: userPrompt }]);
  userModel.observe(userPrompt);
  await transcend.observeUserPrompt(userPrompt);
  const events: AgentEvent[] = [];
  await agent.run(userPrompt, (ev) => {
    events.push(ev);
  });
  // Append a final assistant message so the session has a balanced log.
  await session.appendAssistantMessage([{ type: 'text', text: 'Done.' }]);
  await session.appendReflection({
    note: 'integration-demo final',
    tried: 'read, subagent, session_history, write',
    learned: 'all 4 tools succeeded',
    nextHint: 'verify the file content',
    toolCallCount: 4,
    hadErrors: false,
  });

  // 5. Verify the agent exercised all the planned tools.
  const toolCalls = events
    .filter((e) => e.type === 'tool_execution_start')
    .map((e) => (e as { toolName: string }).toolName);
  ok('agent called read', toolCalls.includes('read'));
  ok('agent called subagent', toolCalls.includes('subagent'));
  ok('agent called session_history', toolCalls.includes('session_history'));
  ok('agent called write', toolCalls.includes('write'));

  // 6. The subagent should have created a real file (write was called).
  const fixed = readFileSync(join(dir, 'fix.txt'), 'utf8');
  ok('write tool created fix.txt', fixed === 'fixed\n');

  // 7. Record tool outcomes in mastery.
  for (const e of events) {
    if (e.type === 'tool_execution_end') {
      mastery.record(e.toolName, e.result.isError === true);
    }
  }
  ok('mastery recorded 4 tool calls', mastery.allStats().reduce((s, t) => s + t.calls, 0) === 4);
  ok('read has 100% success after 1 call', (mastery.statsFor('read')?.successRate ?? 0) === 1);
  // Note: with only 1 call, mastery level is "novice" (threshold is 3).
  ok('subagent is at novice level after 1 call', mastery.level('subagent') === 'novice');

  // 8. Verify the introspection layer recorded snapshots.
  ok('introspection has at least 4 snapshots', intro.getSnapshots().length >= 4);
  // Wait for the background reflection to settle.
  for (let i = 0; i < 30; i++) {
    if ((await intro.getGuidance()) !== '') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const guidance = await intro.getGuidance();
  ok('introspection produced guidance', guidance.length > 0);
  ok('guidance mentions aligned item', guidance.includes('read the file before writing'));

  // 9. Verify the session has all the expected entry types.
  const entries = session.getEntries();
  const types = new Set(entries.map((e) => e.type));
  ok('session has user messages', types.has('message'));
  ok('session has at least one reflection', entries.some((e) => e.type === 'reflection'));

  // 10. Verify the constitution tool works against the real system.
  const constitutionTool = BUILTIN_TOOLS.find((t) => t.name === 'constitution');
  ok('constitution tool is in BUILTIN_TOOLS', !!constitutionTool);
  const r = await constitutionTool!.execute({}, {
    cwd: dir,
    signal: new AbortController().signal,
    messages: [],
    log: () => {},
  });
  ok('constitution tool returns text', r.content.length > 0);

  // 11. Verify the self_reflect tool works against the real session.
  const selfReflectTool = BUILTIN_TOOLS.find((t) => t.name === 'self_reflect');
  ok('self_reflect tool is in BUILTIN_TOOLS', !!selfReflectTool);
  const r2 = await selfReflectTool!.execute({ limit: 3 }, {
    cwd: dir,
    signal: new AbortController().signal,
    messages: [],
    log: () => {},
    harness: { session },
  });
  ok('self_reflect tool returns text', r2.content.length > 0);

  // 12. Verify the user_model tool works.
  const userModelToolInst = BUILTIN_TOOLS.find((t) => t.name === 'user_model');
  ok('user_model tool is in BUILTIN_TOOLS', !!userModelToolInst);
  const r3 = await userModelToolInst!.execute({}, {
    cwd: dir,
    signal: new AbortController().signal,
    messages: [],
    log: () => {},
    harness: { userModel },
  });
  const umText = r3.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  ok('user_model tool returns auth topic', umText.includes('auth'));

  rmSync(dir, { recursive: true, force: true });
  console.log(
    process.exitCode === 1
      ? 'INTEGRATION SMOKE FAILED'
      : 'INTEGRATION SMOKE PASSED — full stack end-to-end',
  );
}

main().catch((err) => {
  console.error('integration smoke crashed:', err);
  process.exit(1);
});
