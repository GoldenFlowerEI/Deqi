/**
 * v3.4: eval tool (Anthropic "Poka-yoke your tools" applied to self).
 *
 * The agent self-grades one of its recent actions. The grade is
 * written to the introspection log so:
 *   1. Future sessions can see "I usually fail at X" and route around it
 *   2. The bench harness (v3.4 bench/) can aggregate self-grades
 *      as a fast proxy for capability
 *
 * The tool is intentionally minimal: the LLM does the grading in
 * free text + a 0..1 numeric score, and we just persist + echo.
 * We do NOT validate against any external oracle (that's what
 * the bench is for) — eval is a self-report.
 */

import { randomBytes } from 'node:crypto';
import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { appendEntry, readRecent, getAggregateStats, type IntrospectionEntry } from '../introspection.js';

export const evalTool: AgentTool = {
  name: 'eval',
  description: `Self-grade a recent action or your own turn. Writes the grade to the introspection log. v3.4 ships this as a self-report — the grade is the model's honest assessment, not an external oracle (the bench harness in bench/ is the oracle).

Modes (mode param):
  - 'grade'   (default): grade ONE recent action. Required: subject, grade (0..1), rationale.
  - 'turn'    : grade your entire current turn. Same fields; 'subject' is auto-filled.
  - 'stats'   : return the aggregate stats from the introspection log (no writes).
  - 'recent'  : return the last N introspection entries (no writes). Required: limit?

Parameters:
  - mode (string, optional, default 'grade')
  - subject (string, required for grade): what you're grading (e.g. "tool:webFetch url=https://...")
  - grade (number, 0..1, required for grade): 0=failed, 1=perfect, 0.5=partial
  - rationale (string, required for grade): one or two sentences explaining the grade
  - sessionId (string, optional): session to grade against; defaults to current
  - limit (number, optional, default 10): for 'recent'

Returns:
  - grade: {ok: true, id, grade, meanGrade}  — the new entry + rolling mean
  - turn:  same shape, subject="<auto>"
  - stats: AggregateStats
  - recent: array of IntrospectionEntry

When to use:
  - You just did something the user might evaluate (a tool call, a long answer) — grade yourself
  - You want to know how you've been doing this session — call stats
  - You want to remember what happened — call recent

When NOT to use:
  - For user-facing grades (this is private)
  - For every turn (use it for the ones that matter — long answers, tool failures, ambiguous results)
  - Instead of doing the work (the grade is metadata, not a substitute for action)

Examples:
  - eval subject="tool:webFetch url=..." grade=0.9 rationale="worked first try"
  - eval mode=turn grade=0.7 rationale="got the answer but had to retry bash twice"
  - eval mode=stats → aggregate stats for the whole log

Concurrency: NOT safe (writes the introspection log).`,

  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['grade', 'turn', 'stats', 'recent'] },
      subject: { type: 'string' },
      grade: { type: 'number' },
      rationale: { type: 'string' },
      sessionId: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  isConcurrencySafe: () => false,
  async execute(args: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const a = args as {
      mode?: 'grade' | 'turn' | 'stats' | 'recent';
      subject?: string;
      grade?: number;
      rationale?: string;
      sessionId?: string;
      limit?: number;
    };
    const mode = a.mode ?? 'grade';
    const sessionId = a.sessionId ?? (ctx as { sessionId?: string }).sessionId ?? 'unknown';

    try {
      if (mode === 'stats') {
        return ok(getAggregateStats());
      }
      if (mode === 'recent') {
        return ok(readRecent(sessionId, a.limit ?? 10));
      }
      if (mode === 'turn') {
        // Auto-fill the subject with the last tool call or 'turn'
        const recent = readRecent(sessionId, 5);
        const lastTool = recent.reverse().find((e) => e.type === 'tool_call');
        const subject = lastTool
          ? `turn-with-${(lastTool.payload as { tool?: string }).tool ?? 'unknown'}`
          : 'turn';
        return await recordGrade({ subject, grade: a.grade, rationale: a.rationale }, sessionId);
      }
      // mode === 'grade'
      if (!a.subject || a.grade === undefined || !a.rationale) {
        return { content: [{ type: 'text', text: 'grade mode requires subject, grade, rationale' }], isError: true };
      }
      if (a.grade < 0 || a.grade > 1) {
        return { content: [{ type: 'text', text: 'grade must be in [0, 1]' }], isError: true };
      }
      return await recordGrade({ subject: a.subject, grade: a.grade, rationale: a.rationale }, sessionId);
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  },
};

function ok(data: unknown): ToolExecutionResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function recordGrade(
  args: { subject: string; grade?: number; rationale?: string },
  sessionId: string,
): Promise<ToolExecutionResult> {
  const entry: IntrospectionEntry = {
    ts: new Date().toISOString(),
    sessionId,
    type: 'grade',
    payload: { subject: args.subject, grade: args.grade, rationale: args.rationale },
  };
  appendEntry(entry);
  const stats = getAggregateStats();
  return ok({ ok: true, id: randomBytes(4).toString('hex'), entry, meanGrade: stats.meanGrade });
}
