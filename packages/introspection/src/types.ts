/**
 * Introspection — the goal/self-observation layer of Deqi.
 *
 * In v0.1 this module is API-only: it exposes the shape that higher
 * layers (the agent runtime, the coding-agent CLI) will use to:
 *
 *   1. Register the user's overall intent (the "goal layer")
 *   2. Observe the agent's own behavior in real time
 *   3. Reflect on past behavior to refine future behavior
 *   4. Eventually: have the agent propose emergent sub-goals on its own
 *
 * v0.3+ will provide concrete implementations (LLM-driven self-reflection,
 * persistent goal journal, alignment-check heuristics). For now,
 * NoOpIntrospectionLayer is the default.
 *
 * The naming is deliberately philosophical:
 *   - "Emergent intelligence" — the system grows capabilities over time
 *   - "Golden flower" — a metaphor for the unfolding of awareness
 *   - "Introspection" — the system watches itself working
 *   - "Transcendence" — alignment with the user's deeper goals
 */

export type GoalPriority = 'core' | 'supporting' | 'exploratory';

export interface Goal {
  /** Stable identifier. */
  id: string;
  /** The user's overall intent for this session. */
  description: string;
  /** Why this goal exists (the user's motivation). */
  rationale?: string;
  priority: GoalPriority;
  /** Whether the agent should surface this goal into its decisions. */
  propagateToAgent: boolean;
  /** ISO-8601 timestamp when the goal was registered. */
  createdAt: string;
  /** v0.5: a goal proposed by the TranscendenceLayer can be dismissed
   *  by the user. Once dismissed, it is hidden from the TUI and
   *  removed from the introspection journal. */
  dismissed?: boolean;
}

export interface BehaviorSnapshot {
  timestamp: string;
  /** Tool names invoked and their outcomes. */
  toolUsage: Array<{ name: string; isError: boolean; durationMs: number }>;
  /** Files modified in this slice of work. */
  filesTouched: string[];
  /** Free-form notes the agent gives itself. */
  notes: string[];
}

export interface ReflectionReport {
  timestamp: string;
  /** What the agent did well. */
  aligned: string[];
  /** What the agent could have done better, given the user's goal. */
  misaligned: string[];
  /** Concrete next-step suggestions. */
  nextSteps: string[];
}

export interface IntrospectionEvent {
  type: 'goal_registered' | 'goal_completed' | 'behavior_observed' | 'reflection_emitted';
  payload: Goal | { goalId: string } | BehaviorSnapshot | ReflectionReport;
  timestamp: string;
}

/**
 * The introspection layer receives events from the agent runtime and
 * may, asynchronously, emit follow-up events back (e.g. a soft "consider
 * re-asking the user about X" hint). v0.1 only provides the surface.
 *
 * v0.4 adds `getGuidance()` so the agent's system prompt can be
 * prepended with a self-critique derived from recent observations.
 */
export interface IntrospectionLayer {
  /** Register or replace the user's overall goal. */
  registerGoal(goal: Goal): Promise<void>;
  /** Mark a goal as completed. */
  completeGoal(goalId: string): Promise<void>;
  /** List currently-active goals. */
  listGoals(): Promise<Goal[]>;
  /** Observe a behavior slice. */
  observe(snapshot: BehaviorSnapshot): Promise<void>;
  /**
   * Run reflection on the buffered observations. Implementations that
   * have an LLM (DefaultIntrospectionLayer) will produce a structured
   * ReflectionReport. The NoOp layer returns null.
   */
  reflect?(windowMs?: number): Promise<ReflectionReport | null>;
  /**
   * v0.4: Return a short guidance string to be prepended to the agent's
   * system prompt. Empty string if no reflection has been produced yet.
   */
  getGuidance?(): Promise<string>;
  /** Subscribe to events emitted by the layer. */
  subscribe?(handler: (event: IntrospectionEvent) => void): () => void;
}

/** No-op default for v0.1. */
export class NoOpIntrospectionLayer implements IntrospectionLayer {
  private goals: Goal[] = [];

  async registerGoal(goal: Goal): Promise<void> {
    this.goals = [...this.goals.filter((g) => g.id !== goal.id), goal];
  }
  async completeGoal(goalId: string): Promise<void> {
    this.goals = this.goals.filter((g) => g.id !== goalId);
  }
  async listGoals(): Promise<Goal[]> {
    return this.goals;
  }
  async observe(_snapshot: BehaviorSnapshot): Promise<void> {
    // no-op
  }
}
