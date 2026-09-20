/**
 * TranscendenceLayer v1 — emergent goal generation.
 *
 * Inspired by the Secret of the Golden Flower's huiguang (回光,
 * "returning the light"): the agent periodically turns its
 * attention inward, surveys the user's recent prompts, and asks
 * "what does the user actually want?" — not what they literally
 * said, but the deeper pattern. It then proposes 1-3 emergent
 * goals that align with that pattern.
 *
 * The transcendent function (Jung's reading of the alchemical
 * opus) is the operationalization: from the surface tension of
 * the user's stated requests, the layer extracts a deeper
 * intention and surfaces it as a goal the agent can act on.
 *
 * Wu-wei compliance: the layer never *pushes* a goal. It only
 * *makes available* the goal via the introspection's registerGoal
 * (priority: exploratory). The TUI surfaces it as a one-line
 * "💡" suggestion; the user can /dismiss it.
 */

import type { Model, ModelRegistry } from '@deqi/ai';
import type {
  DefaultIntrospectionLayer,
} from './default-layer.js';
import type { Goal, GoalPriority } from './types.js';

const RECENT_PROMPTS_SIZE = 12;
const REFLECT_EVERY = 3; // runs after this many new prompts
const MAX_EMERGENT_GOALS = 3;

export interface TranscendenceConfig {
  registry: ModelRegistry;
  modelId?: string;
  /** The introspection layer whose goal journal we write into. */
  introspection: DefaultIntrospectionLayer;
  reflectEvery?: number;
}

interface RawEmergentGoal {
  description: string;
  rationale: string;
  priority: GoalPriority;
}

export class TranscendenceLayer {
  private recentPrompts: string[] = [];
  private newSinceLastReflect = 0;
  private registry: ModelRegistry;
  private modelId: string | null;
  private introspection: DefaultIntrospectionLayer;
  private reflectEvery: number;
  private emergentGoals: Goal[] = [];
  private subscribers: Array<(g: Goal) => void> = [];

  constructor(cfg: TranscendenceConfig) {
    this.registry = cfg.registry;
    this.modelId = cfg.modelId ?? null;
    this.introspection = cfg.introspection;
    this.reflectEvery = cfg.reflectEvery ?? REFLECT_EVERY;
  }

  /**
   * Record a user prompt. Called from the agent runtime at the
   * start of each turn. Returns a list of any *new* emergent goals
   * proposed this observation.
   */
  async observeUserPrompt(prompt: string): Promise<Goal[]> {
    if (!prompt || prompt.trim().length === 0) return [];
    this.recentPrompts.push(prompt);
    if (this.recentPrompts.length > RECENT_PROMPTS_SIZE) {
      this.recentPrompts = this.recentPrompts.slice(-RECENT_PROMPTS_SIZE);
    }
    this.newSinceLastReflect += 1;
    if (this.newSinceLastReflect < this.reflectEvery) return [];
    if (this.recentPrompts.length < 2) return [];
    this.newSinceLastReflect = 0;
    return await this.proposeEmergentGoals();
  }

  /**
   * List goals this layer has proposed that are still active
   * (not dismissed by the user).
   */
  listEmergentGoals(): Goal[] {
    return this.emergentGoals.filter((g) => !g.dismissed);
  }

  /**
   * Mark one of our emergent goals as dismissed. Returns true on success.
   */
  async dismissGoal(goalId: string): Promise<boolean> {
    const g = this.emergentGoals.find((x) => x.id === goalId);
    if (!g) return false;
    g.dismissed = true;
    await this.introspection.completeGoal(goalId);
    return true;
  }

  /**
   * Subscribe to "new emergent goal" events. Useful for the TUI
   * to show a one-line 💡 hint.
   */
  onEmergentGoal(handler: (g: Goal) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== handler);
    };
  }

  private async proposeEmergentGoals(): Promise<Goal[]> {
    const model = this.resolveModel();
    if (!model) return [];
    const prompt = `You are the transcendence layer of a coding agent. Look at the user's recent prompts and identify the deeper, longer-term pattern of what they're trying to accomplish. Then propose 1-3 emergent goals that the user probably *also* wants but hasn't said.

Recent user prompts (most recent last):
${this.recentPrompts.map((p, i) => `${i + 1}. ${p.slice(0, 200)}`).join('\n')}

Reply in EXACTLY this format, with no other prose:

EMERGENT:
- <one-sentence goal> || <one-sentence rationale> || <core|supporting|exploratory>

If you cannot identify a deeper pattern, reply with a single line: NONE`;

    let text = '';
    try {
      const stream = this.registry.getStream(model);
      for await (const ev of stream({
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        system:
          'You identify user intent. Be conservative: propose only goals the user is very likely to want, given the pattern. Quality over quantity.',
        tools: [],
        maxTokens: Math.min(model.maxOutputTokens, 500),
      })) {
        if (ev.type === 'text_delta') text += ev.delta;
      }
    } catch {
      return [];
    }
    if (text.trim() === 'NONE' || !text.includes('EMERGENT:')) return [];
    const raws = parseEmergentGoals(text);
    if (raws.length === 0) return [];
    const newGoals: Goal[] = [];
    for (const r of raws.slice(0, MAX_EMERGENT_GOALS)) {
      const goal: Goal = {
        id: `emergent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: r.description,
        rationale: r.rationale,
        priority: r.priority,
        propagateToAgent: true,
        createdAt: new Date().toISOString(),
        dismissed: false,
      };
      this.emergentGoals.push(goal);
      newGoals.push(goal);
      // Register into the journal so other layers see it.
      await this.introspection.registerGoal(goal);
      for (const s of this.subscribers) s(goal);
    }
    return newGoals;
  }

  private resolveModel(): Model | null {
    if (this.modelId) {
      try {
        return this.registry.resolveModel(this.modelId);
      } catch {
        // fall through
      }
    }
    const available = this.registry
      .listModels()
      .filter((m) => this.registry.isProviderAvailable(m.provider));
    return available[0] ?? null;
  }
}

function parseEmergentGoals(text: string): RawEmergentGoal[] {
  const out: RawEmergentGoal[] = [];
  const lines = text.split('\n');
  let inSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^EMERGENT:/i.test(t)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (!t.startsWith('-')) continue;
    const body = t.replace(/^-\s*/, '').trim();
    const parts = body.split('||').map((s) => s.trim());
    if (parts.length < 2) continue;
    const [description, rationale, priorityRaw] = parts;
    const priority: GoalPriority =
      priorityRaw === 'core' || priorityRaw === 'supporting' || priorityRaw === 'exploratory'
        ? priorityRaw
        : 'exploratory';
    out.push({ description, rationale, priority });
  }
  return out;
}
