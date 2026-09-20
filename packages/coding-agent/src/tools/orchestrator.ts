/**
 * v3.3: orchestrator tool (Minsky K-line + Anthropic orchestrator-workers).
 *
 * The orchestrator is a thin wrapper that lets the main agent hand a
 * multi-step task to a coordinator. The coordinator chooses a
 * specialist (code-reviewer, test-runner, doc-writer) and runs it.
 *
 * v3.3 is the scaffold: `runSpecialist` returns deterministic stubs.
 * v3.4 wires it to AgentCore.run() so the specialist actually uses
 * the underlying LLM with the frozen system prompt + read-only tool
 * subset.
 *
 * The orchestrator also enforces a sandbox: the specialist can only
 * `read` / `grep` / `glob` from the sandboxed directory tree. Write
 * tools are stripped from the tool subset the specialist sees.
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import {
  SPECIALISTS,
  runSpecialist,
  resolveSandbox,
  type SpecialistName,
  type OrchestratorContext,
} from '../specialists.js';

const SPECIALIST_NAMES: ReadonlyArray<SpecialistName> = ['code-reviewer', 'test-runner', 'doc-writer'];

export const orchestratorTool: AgentTool = {
  name: 'orchestrator',
  description: `Dispatch a multi-step task to a specialist agent. v3.6 ships three LLM-backed specialists: code-reviewer (read-only), test-runner (can run tests), doc-writer (read-only). Each runs as a fresh sub-agent with the specialist's frozen system prompt and a restricted tool subset.

When to use:
  - You want a focused, parallelizable unit of work (review, test, docs)
  - The task is well-bounded and the specialist's output format is what you need
  - You want a separate context window so the main session stays clean

When NOT to use:
  - You need a tool the specialist isn't allowed to use (specialists are restricted)
  - The task is interactive (the specialist is fire-and-forget)
  - You could do the work yourself in 1-2 tool calls

Parameters:
  - specialist (string, required): 'code-reviewer' | 'test-runner' | 'doc-writer'
  - task (string, required): the unit of work. The specialist sees ONLY this string + the sandboxed directory.
  - sandbox (string, optional): absolute path OR path relative to cwd. Limits where the specialist can read. Invalid paths → isError.

Returns:
  - the specialist's report (text).
  - The first line is always a header: \`# <specialist>: <task>\`
  - The rest follows the specialist's contract (see specialists.ts).

Examples:
  - orchestrator specialist=code-reviewer task="review the last 3 commits" sandbox=src/
  - orchestrator specialist=test-runner task="run the full test suite"
  - orchestrator specialist=doc-writer task="document the public API" sandbox=packages/server/src

Concurrency: NOT safe (LLM-backed).`,

  inputSchema: {
    type: 'object',
    properties: {
      specialist: { type: 'string', enum: ['code-reviewer', 'test-runner', 'doc-writer'] },
      task: { type: 'string' },
      sandbox: { type: 'string' },
    },
    required: ['specialist', 'task'],
  },
  isConcurrencySafe: () => false,
  async execute(args: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const a = args as { specialist?: string; task?: string; sandbox?: string };
    if (!a?.specialist || !a?.task) {
      return { content: [{ type: 'text', text: 'Missing specialist or task' }], isError: true };
    }
    if (!SPECIALIST_NAMES.includes(a.specialist as SpecialistName)) {
      return { content: [{ type: 'text', text: `Unknown specialist: ${a.specialist}` }], isError: true };
    }
    const spec = SPECIALISTS[a.specialist as SpecialistName];
    if (a.sandbox) {
      const ok = resolveSandbox(ctx.cwd, a.sandbox);
      if (!ok) {
        return {
          content: [{ type: 'text', text: `Invalid sandbox: ${a.sandbox} (must be an existing directory)` }],
          isError: true,
        };
      }
    }
    const sandbox = a.sandbox ? resolveSandbox(ctx.cwd, a.sandbox) : null;
    // v3.6: pass the orchestrator ctx from the harness if available;
    // otherwise the specialist falls back to its deterministic stub.
    const orchestratorCtx = ctx.harness?.orchestrator as OrchestratorContext | undefined;
    const report = await runSpecialist(a.specialist as SpecialistName, a.task, sandbox, orchestratorCtx);
    // Prefix with the header so the orchestrator's downstream logic
    // can quickly see which specialist produced the report.
    const header = `# ${spec.name}: ${truncate(a.task, 80)}\n# sandbox: ${sandbox ?? '(none)'}\n# tools: ${spec.allowedTools.join(', ')}\n# mode: ${orchestratorCtx ? 'llm' : 'stub'}\n\n`;
    return { content: [{ type: 'text', text: header + report }] };
  },
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
