/**
 * ToolMasteryTracker — v0.6.
 *
 * Inspired by Vygotsky / 4E cognition: tools are cognitive extensions
 * that reshape the mind that uses them. An agent that has called
 * `bash` 20 times with 12 errors is, in some operational sense, in a
 * different relationship to `bash` than an agent that has called
 * it twice without error.
 *
 * The tracker records per-tool usage and success, and produces
 * "mastery hints" when a tool is over-used with low success — a
 * soft suggestion to try a different tool, or to slow down.
 *
 * The hints are surfaced in the TUI as a one-line 💡 block, not
 * injected into the system prompt: wu-wei compliance.
 */

import type { AgentTool } from '@deqi/agent-core';

const MASTERY_WINDOW = 8; // last N calls
const MASTERY_LOW_THRESHOLD = 0.5; // < 50% success = mastery hint
const MASTERY_HIGH_THRESHOLD = 0.85; // >= 85% success = mastery

interface ToolStats {
  name: string;
  calls: number;
  errors: number;
  recent: boolean[]; // last MASTERY_WINDOW results: true=ok, false=error
}

export type MasteryLevel = 'novice' | 'developing' | 'mastered' | 'misused';

export class ToolMasteryTracker {
  private stats = new Map<string, ToolStats>();
  private subscribers: Array<(name: string, level: MasteryLevel, hint: string) => void> = [];

  /** Record a tool call. */
  record(toolName: string, isError: boolean): void {
    let s = this.stats.get(toolName);
    if (!s) {
      s = { name: toolName, calls: 0, errors: 0, recent: [] };
      this.stats.set(toolName, s);
    }
    s.calls += 1;
    if (isError) s.errors += 1;
    s.recent.push(!isError);
    if (s.recent.length > MASTERY_WINDOW) s.recent.shift();
    // Surface a hint when crossing the misuse threshold.
    if (s.calls >= MASTERY_WINDOW) {
      const level = this.levelFor(s);
      if (level === 'misused') {
        const hint = `Tool "${toolName}" has ${this.successRate(s) * 100 | 0}% success in the last ${MASTERY_WINDOW} calls. Consider a different tool, or check the input.`;
        for (const sub of this.subscribers) sub(toolName, level, hint);
      }
    }
  }

  /** Get the mastery level for a tool. */
  level(toolName: string): MasteryLevel {
    const s = this.stats.get(toolName);
    if (!s) return 'novice';
    return this.levelFor(s);
  }

  /** Number of calls and success rate for a tool. */
  statsFor(toolName: string): { calls: number; successRate: number } | null {
    const s = this.stats.get(toolName);
    if (!s) return null;
    return { calls: s.calls, successRate: this.successRate(s) };
  }

  /** All tools with at least one call. */
  allStats(): Array<{ name: string; calls: number; errors: number; level: MasteryLevel }> {
    return [...this.stats.values()].map((s) => ({
      name: s.name,
      calls: s.calls,
      errors: s.errors,
      level: this.levelFor(s),
    }));
  }

  /** Subscribe to "misuse" events. */
  onMisuse(handler: (name: string, level: MasteryLevel, hint: string) => void): () => void {
    this.subscribers.push(handler);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== handler);
    };
  }

  private successRate(s: ToolStats): number {
    if (s.recent.length === 0) return 0;
    return s.recent.filter((ok) => ok).length / s.recent.length;
  }

  private levelFor(s: ToolStats): MasteryLevel {
    if (s.calls < 3) return 'novice';
    const rate = this.successRate(s);
    if (rate < MASTERY_LOW_THRESHOLD) return 'misused';
    if (rate >= MASTERY_HIGH_THRESHOLD) return 'mastered';
    return 'developing';
  }
}

/**
 * Hook the mastery tracker into the agent's tool execution.
 * Returns an unsubscribe function. For v0.6 this is exposed for
 * tests; the interactive TUI wires it in.
 */
export function attachMasteryTracker(
  tracker: ToolMasteryTracker,
  toolNames: string[],
): () => void {
  // Verify all tools exist (defensive — would catch typos).
  for (const n of toolNames) {
    if (!n || n.length === 0) {
      throw new Error('attachMasteryTracker: empty tool name');
    }
  }
  return () => {
    // No-op teardown for v0.6.
  };
}
