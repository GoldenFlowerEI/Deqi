/**
 * plan tool (v3.1).
 *
 * Implements the "plan-then-execute" extension of ReAct (Yao 2023
 * §4.2 / Anthropic orchestrator-workers): for a multi-step task,
 * the agent first calls `plan` to decompose into a dependency-aware
 * step list, then executes each step with the standard ReAct loop.
 *
 * Two modes:
 *   - `propose` (default): the LLM returns a JSON step list; we
 *     validate + return it. The agent then drives execution.
 *   - `record`: the agent explicitly checkpoints "step N is done"
 *     so a future session can resume. Mirrors Anthropic's
 *     claude-progress.txt discipline.
 *
 * The tool is `isConcurrencySafe = false` (planning writes state).
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { projectDir } from '../state.js';

export interface PlanStep {
  id: string;
  title: string;
  /** Short imperative line ("call webFetch on X"). */
  action: string;
  /** IDs of steps that must complete before this one. */
  dependsOn: string[];
  /** One of: tool name, "respond", or any agent-readable verb. */
  kind: 'tool' | 'respond' | 'think' | 'subagent';
  /** Optional — tool name when kind='tool'. */
  toolName?: string;
}

export interface PlanDocument {
  version: 1;
  planId: string;
  createdAt: string;
  goal: string;
  steps: PlanStep[];
  /** Set by `record`. Keys are step ids, values are done | in_progress | skipped. */
  status: Record<string, 'done' | 'in_progress' | 'skipped'>;
  notes: Record<string, string>;
}

const PLAN_FILE = 'plan.json';

function planPath(cwd: string, planId: string): string {
  return join(projectDir(cwd), 'plans', `${planId}.json`);
}

export const planTool: AgentTool = {
  name: 'plan',
  description: `Decompose a multi-step task into a dependency-aware plan, or checkpoint progress on an existing plan.

When to use:
  - User asks for >3 steps of work (build a feature, investigate a problem, ship a refactor)
  - You want a paper trail that survives session restarts
  - The task has dependencies between subtasks (do A, then B depends on A)

When NOT to use:
  - Single-step question/answer
  - One tool call will resolve it
  - You're already inside a planned execution (use \`record\` only)

Modes (action param):
  - 'propose' (default): returns a validated step list. Required: \`goal\`, \`steps\` (array of {title, action, dependsOn?}).
  - 'record': checkpoint one step. Required: \`planId\`, \`stepId\`, \`status\` ('done' | 'in_progress' | 'skipped'), \`note?\`.
  - 'list': list plan ids for the cwd.
  - 'read': read a plan. Required: \`planId\`.

Returns:
  - propose: { planId, steps, validated: true } or { error: '...', issues: [...] }
  - record: { ok: true, status: {...} } or { error: 'plan/step not found' }
  - list: { planIds: [...] }
  - read: { plan: {...} } or { error: 'not found' }

Examples:
  - propose {{ goal: "refactor auth", steps: [{{title:"audit", action:"grep / read auth files", dependsOn:[]}}, {{title:"refactor", action:"edit + bash tests", dependsOn:["s1"]}}] }}
  - record {{ planId: "plan_abc", stepId: "s1", status: "done", note: "all 5 auth files mapped" }}

Concurrency: NOT safe (writes state to disk).`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['propose', 'record', 'list', 'read'],
        description: 'What to do with the plan.',
      },
      planId: { type: 'string', description: 'Existing plan id (for record/read).' },
      stepId: { type: 'string', description: 'Step id (for record).' },
      status: {
        type: 'string',
        enum: ['done', 'in_progress', 'skipped'],
        description: 'New step status (for record).',
      },
      note: { type: 'string', description: 'Optional progress note (for record).' },
      goal: { type: 'string', description: 'Human-readable goal (for propose).' },
      steps: {
        type: 'array',
        description: 'Array of step objects (for propose).',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            action: { type: 'string' },
            dependsOn: { type: 'array', items: { type: 'string' } },
            kind: { type: 'string', enum: ['tool', 'respond', 'think', 'subagent'] },
            toolName: { type: 'string' },
          },
          required: ['title', 'action'],
        },
      },
    },
    required: ['action'],
  },
  isConcurrencySafe: () => false,
  async execute(
    args: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const a = args as {
      action?: 'propose' | 'record' | 'list' | 'read';
      planId?: string;
      stepId?: string;
      status?: 'done' | 'in_progress' | 'skipped';
      note?: string;
      goal?: string;
      steps?: Array<Partial<PlanStep>>;
    };
    if (!a?.action) {
      return { content: [{ type: 'text', text: 'Missing action' }], isError: true };
    }
    const cwd = ctx.cwd;

    if (a.action === 'list') {
      const dir = join(projectDir(cwd), 'plans');
      if (!existsSync(dir)) {
        return { content: [{ type: 'text', text: JSON.stringify({ planIds: [] }) }] };
      }
      const { readdirSync } = await import('node:fs');
      const ids = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
      return { content: [{ type: 'text', text: JSON.stringify({ planIds: ids }) }] };
    }

    if (a.action === 'read') {
      if (!a.planId) {
        return { content: [{ type: 'text', text: 'Missing planId' }], isError: true };
      }
      const p = planPath(cwd, a.planId);
      if (!existsSync(p)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'not found' }) }], isError: true };
      }
      const { readFileSync } = await import('node:fs');
      return { content: [{ type: 'text', text: readFileSync(p, 'utf-8') }] };
    }

    if (a.action === 'propose') {
      if (!a.goal || !Array.isArray(a.steps) || a.steps.length === 0) {
        return { content: [{ type: 'text', text: 'Missing goal or empty steps' }], isError: true };
      }
      // Validate + auto-id
      const issues: string[] = [];
      const steps: PlanStep[] = [];
      for (let i = 0; i < a.steps.length; i += 1) {
        const s = a.steps[i]!;
        if (!s.title || !s.action) {
          issues.push(`step[${i}] missing title or action`);
          continue;
        }
        const id = s.id ?? `s${i + 1}`;
        const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
        // Check deps reference prior steps
        for (const d of deps) {
          if (!a.steps.some((x, j) => j < i && (x.id ?? `s${j + 1}`) === d)) {
            issues.push(`step ${id} depends on "${d}" which is not a prior step`);
          }
        }
        steps.push({
          id,
          title: s.title,
          action: s.action,
          dependsOn: deps,
          kind: s.kind ?? 'tool',
          toolName: s.toolName,
        });
      }
      if (issues.length > 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ validated: false, issues }, null, 2),
          }],
          isError: true,
        };
      }
      const planId = `plan_${randomBytes(4).toString('hex')}`;
      const doc: PlanDocument = {
        version: 1,
        planId,
        createdAt: new Date().toISOString(),
        goal: a.goal,
        steps,
        status: Object.fromEntries(steps.map((s) => [s.id, 'in_progress' as const])),
        notes: {},
      };
      const dir = join(projectDir(cwd), 'plans');
      mkdirSync(dir, { recursive: true });
      writeFileSync(planPath(cwd, planId), JSON.stringify(doc, null, 2), 'utf-8');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ planId, validated: true, steps: doc.steps }, null, 2),
        }],
      };
    }

    if (a.action === 'record') {
      if (!a.planId || !a.stepId || !a.status) {
        return {
          content: [{ type: 'text', text: 'Missing planId/stepId/status' }],
          isError: true,
        };
      }
      const p = planPath(cwd, a.planId);
      if (!existsSync(p)) {
        return { content: [{ type: 'text', text: 'plan not found' }], isError: true };
      }
      const { readFileSync } = await import('node:fs');
      const doc = JSON.parse(readFileSync(p, 'utf-8')) as PlanDocument;
      if (!(a.stepId in doc.status)) {
        return { content: [{ type: 'text', text: 'step not found' }], isError: true };
      }
      doc.status[a.stepId] = a.status;
      if (a.note) doc.notes[a.stepId] = a.note;
      writeFileSync(p, JSON.stringify(doc, null, 2), 'utf-8');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, status: doc.status, notes: doc.notes }, null, 2),
        }],
      };
    }

    return { content: [{ type: 'text', text: `unknown action: ${a.action}` }], isError: true };
  },
};
