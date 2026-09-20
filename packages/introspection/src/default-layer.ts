/**
 * DefaultIntrospectionLayer — v0.4.
 *
 * Inspired by Maturana & Varela's autopoiesis: the system produces
 * structured observations of its own behavior, periodically reflects
 * on those observations via the LLM, and exposes a "guidance" string
 * that gets injected into the agent's next system prompt.
 *
 * Self-critique flow:
 *   1. observe(snapshot) — record a behavior slice
 *   2. After N observations (default: 3), reflect() is called
 *   3. reflect() calls the LLM with the recent snapshots and gets a
 *      structured ReflectionReport back
 *   4. The reflection is summarized into a "guidance" string
 *   5. getGuidance() returns the guidance, which the agent prepends
 *      to its system prompt on the next turn
 *
 * The LLM-based reflection is itself a behavior the layer produces,
 * so the autopoietic loop closes: the layer's output modifies the
 * agent's input, which modifies the next behavior, which the layer
 * observes, and so on.
 */

import type { Model, ModelRegistry } from '@deqi/ai';
import type {
  BehaviorSnapshot,
  Goal,
  IntrospectionEvent,
  IntrospectionLayer,
  ReflectionReport,
} from './types.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const REFLECT_EVERY = 3; // turns
const RING_SIZE = 20; // last 20 snapshots kept in memory

export interface DefaultLayerConfig {
  registry: ModelRegistry;
  /** Model to use for the reflection LLM call. Defaults to the registry's first available. */
  modelId?: string;
  /** How often to trigger reflect() (every Nth observe). */
  reflectEvery?: number;
  /**
   * v3.9.1: path to a JSONL file where each reflection report is
   * appended. When set, the report written here can be re-loaded
   * by `readRecentReflections()` on a future session so the agent
   * remembers what it learned. Failures are swallowed (we never
   * want a missing log dir to break reflection).
   */
  persistencePath?: string;
}

export class DefaultIntrospectionLayer implements IntrospectionLayer {
  private goals: Goal[] = [];
  private snapshots: BehaviorSnapshot[] = [];
  private sinceLastReflect = 0;
  private currentGuidance = '';
  private lastReport: ReflectionReport | null = null;
  private subscribers: Array<(e: IntrospectionEvent) => void> = [];
  private registry: ModelRegistry;
  private modelId: string | null;
  private reflectEvery: number;
  /** v3.9.1: optional JSONL path for persisting reports. */
  private persistencePath: string | null;

  constructor(cfg: DefaultLayerConfig) {
    this.registry = cfg.registry;
    this.modelId = cfg.modelId ?? null;
    this.reflectEvery = cfg.reflectEvery ?? REFLECT_EVERY;
    this.persistencePath = cfg.persistencePath ?? null;
  }

  async registerGoal(goal: Goal): Promise<void> {
    this.goals = [...this.goals.filter((g) => g.id !== goal.id), goal];
    this.emit({ type: 'goal_registered', payload: goal, timestamp: new Date().toISOString() });
  }

  async completeGoal(goalId: string): Promise<void> {
    const before = this.goals.length;
    this.goals = this.goals.filter((g) => g.id !== goalId);
    if (this.goals.length < before) {
      this.emit({
        type: 'goal_completed',
        payload: { goalId },
        timestamp: new Date().toISOString(),
      });
    }
  }

  async listGoals(): Promise<Goal[]> {
    return this.goals;
  }

  async observe(snapshot: BehaviorSnapshot): Promise<void> {
    this.snapshots.push(snapshot);
    if (this.snapshots.length > RING_SIZE) {
      this.snapshots = this.snapshots.slice(-RING_SIZE);
    }
    this.sinceLastReflect += 1;
    this.emit({
      type: 'behavior_observed',
      payload: snapshot,
      timestamp: snapshot.timestamp,
    });
    if (this.sinceLastReflect >= this.reflectEvery) {
      this.sinceLastReflect = 0;
      // Fire-and-forget: the agent doesn't wait for reflection to
      // complete its current turn. The next call to getGuidance()
      // will block on the in-flight promise.
      void this.reflect();
    }
  }

  async reflect(): Promise<ReflectionReport | null> {
    if (this.snapshots.length === 0) return null;
    const model = this.resolveModel();
    if (!model) return null;
    const transcript = this.snapshots
      .slice(-this.reflectEvery)
      .map((s, i) => `[turn ${i + 1}] tools=${s.toolUsage.length}, files=${s.filesTouched.length}, errors=${s.toolUsage.filter((t) => t.isError).length}, notes=${s.notes.join('; ')}`)
      .join('\n');
    const goalsContext = this.goals
      .map((g) => `- [${g.priority}] ${g.description}`)
      .join('\n');
    const prompt = `You are the introspection layer of a coding agent (Deqi). Look at the agent's recent behavior and the user's goals. Produce a structured reflection.

User goals:
${goalsContext || '(no goals registered)'}

Recent behavior (last ${Math.min(this.snapshots.length, this.reflectEvery)} turns):
${transcript}

Reply in EXACTLY this format, with no other prose:

ALIGNED:
- <one sentence per thing the agent did well>

MISALIGNED:
- <one sentence per thing the agent should improve>

NEXT:
- <one concrete actionable suggestion>`;

    try {
      const stream = this.registry.getStream(model);
      let text = '';
      for await (const ev of stream({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        system: 'You produce structured self-critique. Be concrete, short, actionable.',
        tools: [],
        maxTokens: Math.min(model.maxOutputTokens, 800),
      })) {
        if (ev.type === 'text_delta') text += ev.delta;
      }
      const report = parseReflection(text, new Date().toISOString());
      this.lastReport = report;
      this.currentGuidance = renderGuidance(report);
      this.emit({
        type: 'reflection_emitted',
        payload: report,
        timestamp: report.timestamp,
      });
      // v3.9.1: persist to JSONL so future sessions can re-read
      // past reflections. Failures are swallowed — a missing
      // directory or write error must never break reflection.
      if (this.persistencePath) {
        try {
          const dir = dirname(this.persistencePath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(
            this.persistencePath,
            JSON.stringify(report) + '\n',
            { flag: 'a', encoding: 'utf8' },
          );
        } catch { /* best-effort */ }
      }
      return report;
    } catch (err) {
      this.currentGuidance = `(reflection failed: ${(err as Error).message})`;
      return null;
    }
  }

  async getGuidance(): Promise<string> {
    return this.currentGuidance;
  }

  subscribe(handler: (e: IntrospectionEvent) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== handler);
    };
  }

  /** For tests. */
  getLastReport(): ReflectionReport | null {
    return this.lastReport;
  }

  /** For tests. */
  getSnapshots(): readonly BehaviorSnapshot[] {
    return this.snapshots;
  }

  private resolveModel(): Model | null {
    if (this.modelId) {
      try {
        return this.registry.resolveModel(this.modelId);
      } catch {
        // fall through
      }
    }
    const available = this.registry.listModels().filter((m) => this.registry.isProviderAvailable(m.provider));
    return available[0] ?? null;
  }

  private emit(event: IntrospectionEvent): void {
    for (const s of this.subscribers) s(event);
  }
}

/** Parse the LLM's response into a ReflectionReport. */
function parseReflection(text: string, ts: string): ReflectionReport {
  const lines = text.split('\n');
  const out: ReflectionReport = {
    timestamp: ts,
    aligned: [],
    misaligned: [],
    nextSteps: [],
  };
  let section: 'aligned' | 'misaligned' | 'next' | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (/^ALIGNED:/i.test(t)) {
      section = 'aligned';
      continue;
    }
    if (/^MISALIGNED:/i.test(t)) {
      section = 'misaligned';
      continue;
    }
    if (/^NEXT:/i.test(t)) {
      section = 'next';
      continue;
    }
    if (section && t.startsWith('-')) {
      const item = t.replace(/^-\s*/, '').trim();
      if (!item) continue;
      if (section === 'aligned') out.aligned.push(item);
      else if (section === 'misaligned') out.misaligned.push(item);
      else out.nextSteps.push(item);
    }
  }
  return out;
}

/** Render a ReflectionReport as a short guidance string for the system prompt. */
function renderGuidance(r: ReflectionReport): string {
  if (r.aligned.length === 0 && r.misaligned.length === 0 && r.nextSteps.length === 0) {
    return '';
  }
  const parts: string[] = ['[self-reflection from last few turns]'];
  if (r.aligned.length > 0) {
    parts.push(`What worked: ${r.aligned.slice(0, 3).join(' / ')}`);
  }
  if (r.misaligned.length > 0) {
    parts.push(`What to improve: ${r.misaligned.slice(0, 3).join(' / ')}`);
  }
  if (r.nextSteps.length > 0) {
    parts.push(`Next: ${r.nextSteps.slice(0, 2).join(' / ')}`);
  }
  return parts.join('\n');
}
