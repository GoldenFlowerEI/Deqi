/**
 * v3.6: plan enforcement — surface plan progress to the model.
 *
 * The plan tool (v3.1) writes a plan to .deqi/plans/<id>.json. The
 * model often loses track of which step it's on. v3.6 reads the
 * active plan and renders a "## Plan progress" block that gets
 * injected into the system prompt on every turn.
 *
 * Status transitions:
 *   - step first tool call matches the step's `tool` → in_progress
 *   - tool call succeeds AND touches the step's `target` → done
 *   - tool call fails for a step → blocked
 *
 * Detection of "touches the target" is heuristic: we look for the
 * target string (a file path or function name) in the tool call's
 * input JSON. False positives are fine; this is a hint, not a gate.
 *
 * The function below is pure: it takes the plan + the recent tool
 * calls and returns the rendered markdown block. Persistence to
 * the plan JSON is the caller's responsibility (state.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PlanStep {
  id: string;
  title: string;
  tool?: string;
  target?: string;
  done?: boolean;
  blocked?: boolean;
  in_progress?: boolean;
}

export interface PlanDocument {
  id: string;
  title: string;
  steps: PlanStep[];
}

export interface ToolCall {
  name: string;
  input: unknown;
  isError: boolean;
}

/**
 * Update step statuses based on the recent tool calls. Returns a
 * shallow-cloned plan with statuses updated. The input plan is not
 * mutated (caller persists if they want).
 */
export function updatePlanProgress(
  plan: PlanDocument,
  recentCalls: ToolCall[],
): PlanDocument {
  const steps = plan.steps.map((s) => ({ ...s }));
  for (const call of recentCalls) {
    for (const step of steps) {
      if (step.done || step.blocked) continue;
      // Match by tool name
      if (step.tool && call.name === step.tool) {
        if (call.isError) {
          step.blocked = true;
        } else if (step.target && callMatchesTarget(call, step.target)) {
          step.done = true;
          step.in_progress = false;
        } else {
          step.in_progress = true;
        }
      }
    }
  }
  return { ...plan, steps };
}

function callMatchesTarget(call: ToolCall, target: string): boolean {
  const inputStr = JSON.stringify(call.input ?? {});
  return inputStr.includes(target);
}

/** Render a markdown "## Plan progress" block for the system prompt. */
export function renderPlanProgress(plan: PlanDocument | null | undefined): string {
  if (!plan || plan.steps.length === 0) return '';
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.done).length;
  const lines: string[] = [];
  lines.push(`## Plan progress (${done} of ${total} done)`);
  for (const s of plan.steps) {
    let marker = '[ ]';
    if (s.done) marker = '[DONE]';
    else if (s.blocked) marker = '[BLOCKED]';
    else if (s.in_progress) marker = '[IN PROGRESS] ← you are here';
    lines.push(`- ${marker.padEnd(20)} ${s.title}`);
  }
  return lines.join('\n');
}

/** Find the active plan for a cwd by listing .deqi/plans/. Pure IO. */
export function findActivePlan(cwd: string): PlanDocument | null {
  // v3.9.1: real implementation. The plan tool writes
  // `.deqi/plans/<id>.json` in the cwd. "Active" = the most
  // recently modified plan that still has at least one step not
  // marked done. This keeps the module's tests pure (we tolerate
  // a missing dir by returning null).
  const planDir = path.join(cwd, '.deqi', 'plans');
  if (!fs.existsSync(planDir)) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(planDir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;
  // Sort by mtime desc; pick the first that has unfinished work.
  entries.sort((a, b) => {
    const sa = fs.statSync(path.join(planDir, a)).mtimeMs;
    const sb = fs.statSync(path.join(planDir, b)).mtimeMs;
    return sb - sa;
  });
  for (const name of entries) {
    try {
      const raw = fs.readFileSync(path.join(planDir, name), 'utf8');
      const plan = JSON.parse(raw) as PlanDocument;
      if (!Array.isArray(plan.steps) || plan.steps.length === 0) continue;
      const allDone = plan.steps.every((s) => s.done);
      if (allDone) continue;
      return plan;
    } catch {
      // Skip unparseable / unreadable plan files.
    }
  }
  return null;
}
