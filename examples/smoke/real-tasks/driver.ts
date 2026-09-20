/**
 * Scripted mock driver for real-task smoke tests.
 *
 * A test defines a `Script` — an ordered list of `ScriptStep` entries,
 * one per *stream call* (i.e. one per LLM turn). Each step is either
 * a `text` reply (ends the loop) or a `tool` call (the agent executes
 * the tool, then calls the next step).
 *
 * To start a fresh user-message-driven loop, the test calls
 * `runScript.startUserMessage('...')`. The first stream call after that
 * uses the next pending step.
 *
 * The script is deterministic and self-checking: a test simply verifies
 * the file system state after the script finishes.
 */

import {
  ModelRegistry,
  type AssistantEvent,
  type Model,
  type StreamFunction,
} from '@deqi/ai';
import { Agent, type AgentEvent, type AgentTool } from '@deqi/agent-core';

export type ScriptStep =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> };

export interface Script {
  tools: AgentTool[];
  model: Model;
  steps: ScriptStep[];
}

export interface ScriptResult {
  totalUsage: { input: number; output: number; costUsd: number };
  finalText: string;
  events: AgentEvent[];
  stepsExecuted: number;
}

export class ScriptedSession {
  private registry: ModelRegistry;
  private script: Script;
  private stepIndex = 0;
  private agent: Agent;
  private allEvents: AgentEvent[] = [];
  private lastText = '';

  constructor(script: Script, cwd: string) {
    this.script = script;
    this.registry = ModelRegistry.fromEnv();
    (this.registry as unknown as { auth: unknown }).auth = { anthropic: { apiKey: 'mock' } };
    (this.registry as unknown as { customModels: Model[] }).customModels = [script.model];
    (this.registry as unknown as { getStream: (m: Model) => StreamFunction }).getStream = (
      _m: Model,
    ) => {
      const step = this.script.steps[this.stepIndex] ?? {
        type: 'text' as const,
        text: '(script end)',
      };
      this.stepIndex += 1;
      return makeStream(step);
    };
    this.agent = new Agent({
      registry: this.registry,
      modelId: script.model.id,
      system: 'You are a scripted smoke-test agent. Follow the script.',
      tools: script.tools,
      cwd,
      maxTurns: script.steps.length + 5,
    });
  }

  async send(message: string): Promise<void> {
    const events: AgentEvent[] = [];
    await this.agent.run(message, (ev) => {
      events.push(ev);
      this.allEvents.push(ev);
    });
    const textDeltas = events
      .filter((e) => e.type === 'message_update' && e.event.type === 'text_delta')
      .map((e) => (e.event as { delta: string }).delta);
    if (textDeltas.length > 0) this.lastText = textDeltas.join('');
  }

  result(): ScriptResult {
    return {
      totalUsage: this.agent.getState().totalUsage,
      finalText: this.lastText,
      events: this.allEvents,
      stepsExecuted: this.stepIndex,
    };
  }
}

export async function runScript(
  script: Script,
  cwd: string,
  userMessages: string[],
): Promise<ScriptResult> {
  const session = new ScriptedSession(script, cwd);
  for (const msg of userMessages) {
    await session.send(msg);
  }
  return session.result();
}

function makeStream(step: ScriptStep): StreamFunction {
  return function* (): Generator<AssistantEvent> {
    yield { type: 'start' };
    if (step.type === 'tool') {
      const id = `toolu_${Math.random().toString(36).slice(2, 10)}`;
      yield { type: 'toolcall_start', id, name: step.name };
      yield { type: 'toolcall_delta', id, inputDelta: JSON.stringify(step.input) };
      yield { type: 'toolcall_end', id, name: step.name, input: step.input };
      yield { type: 'usage', inputTokens: 100, outputTokens: 50, costUsd: 0.001 };
      yield { type: 'done', stopReason: 'tool_use' };
    } else {
      for (let i = 0; i < step.text.length; i += 24) {
        yield { type: 'text_delta', delta: step.text.slice(i, i + 24) };
      }
      yield { type: 'usage', inputTokens: 100, outputTokens: 30, costUsd: 0.0005 };
      yield { type: 'done', stopReason: 'end_turn' };
    }
  };
}

