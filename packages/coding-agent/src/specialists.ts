/**
 * v3.3: specialist agents (Minsky K-line + Anthropic orchestrator-workers).
 *
 * Three built-in specialists:
 *   - code-reviewer: reads git diff + static-analyzes, returns a review
 *   - test-runner:    runs the project's test command, parses output
 *   - doc-writer:     reads source files, produces markdown docs
 *
 * Each specialist is a frozen (system prompt + tool subset). The
 * orchestrator tool in tools/orchestrator.ts calls `runSpecialist`
 * with a name + task + optional sandbox dir. The specialist gets:
 *   - the system prompt
 *   - a read-only tool subset by default (no write/edit/bash)
 *   - the sandboxed cwd
 *   - the task description
 *
 * The result is a single report string the orchestrator can act on.
 * We don't have a real LLM call in v3.3 — `runSpecialist` is a
 * "scaffolded" implementation that returns a deterministic stub
 * based on the task. The full LLM-backed version lands once the
 * server can dispatch to the agent-core's subagent runner.
 *
 * That said: this is a real pattern. Production code can replace
 * `runSpecialist` with `await agent.run(task)` without changing
 * any other code.
 */

import { join, isAbsolute, resolve } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';

export type SpecialistName = 'code-reviewer' | 'test-runner' | 'doc-writer';

export interface SpecialistSpec {
  name: SpecialistName;
  description: string;
  systemPrompt: string;
  /** Tools the specialist is allowed to use. */
  allowedTools: ReadonlyArray<string>;
}

const REVIEWER_PROMPT = `You are the code-reviewer specialist. You are concise, technical, and adversarial in a helpful way.

Your job:
  1. Read the diff or files the orchestrator gave you.
  2. List specific issues: bugs, missing tests, security smells, dead code.
  3. Suggest minimal patches.
  4. Do NOT modify files. Read-only.

Output format (mandatory):
  ## Findings
  - [CRITICAL] <issue> — <file:line> — <suggested fix>
  - [WARNING]  <issue> — <file:line> — <suggested fix>
  - [NIT]      <issue> — <file:line> — <suggested fix>

  ## Tests
  - <what to test> or "tests cover this"
`;

const TEST_RUNNER_PROMPT = `You are the test-runner specialist. You run the project's tests and report what failed and why.

Your job:
  1. Detect the test command (npm test / vitest / pytest / go test / cargo test).
  2. Run it.
  3. Parse the output for failures.
  4. Return a structured report.

Output format (mandatory):
  ## Test command
  - <the command you ran>

  ## Result
  - pass: <N>   fail: <M>   skip: <K>

  ## Failures (top 5)
  - <test name> — <file:line> — <root cause in one line>

  ## Suggested next step
  - <one of: investigate-failure, fix-failure, run-more-thorough, all-green>
`;

const DOC_WRITER_PROMPT = `You are the doc-writer specialist. You produce tight, useful markdown documentation for the requested scope.

Your job:
  1. Read the files in the requested scope.
  2. Produce a single markdown document that explains:
     - What this is (one paragraph)
     - Public API surface (signatures + one-line descriptions)
     - Usage examples (copy-pasteable)
     - Common pitfalls (bullets)
  3. Do NOT modify any source file. Output the markdown only.

Output format: a single fenced markdown block (triple-backtick). Start with a top-level heading.
`;

const ALL_TOOLS: ReadonlyArray<string> = [
  'read', 'edit', 'write', 'bash', 'grep', 'glob',
  'subagent', 'constitution', 'user_model', 'session_history',
  'self_reflect', 'webFetch', 'plan', 'memory', 'skill',
];

export const SPECIALISTS: Record<SpecialistName, SpecialistSpec> = {
  'code-reviewer': {
    name: 'code-reviewer',
    description: 'Reads a diff or set of files and returns a structured review (CRITICAL / WARNING / NIT). Read-only.',
    systemPrompt: REVIEWER_PROMPT,
    allowedTools: ['read', 'grep', 'glob', 'bash', 'constitution', 'memory'],
  },
  'test-runner': {
    name: 'test-runner',
    description: 'Detects the test command, runs it, parses failures, returns a structured report.',
    systemPrompt: TEST_RUNNER_PROMPT,
    allowedTools: ['read', 'grep', 'glob', 'bash', 'memory'],
  },
  'doc-writer': {
    name: 'doc-writer',
    description: 'Reads a scope of files and produces a single markdown documentation block. Read-only.',
    systemPrompt: DOC_WRITER_PROMPT,
    allowedTools: ['read', 'grep', 'glob', 'webFetch', 'memory'],
  },
};

/** Resolve + validate a sandbox dir. Returns null if invalid. */
export function resolveSandbox(cwd: string, sandbox: string | undefined): string | null {
  if (!sandbox) return null;
  const abs = isAbsolute(sandbox) ? sandbox : resolve(cwd, sandbox);
  if (!existsSync(abs)) return null;
  try {
    if (!statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  return abs;
}

/**
 * Run a specialist. v3.3 implementation: deterministic stub
 * derived from the task + sandbox. v3.4 will replace this with
 * a real AgentCore invocation.
 *
 * The stub returns text that:
 *   - has the right shape (matches the specialist's expected output)
 *   - is useful enough that the orchestrator + main agent can
 *     exercise the full pipeline end-to-end without a real LLM
 *   - is deterministic so tests can assert on it
 */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * v3.6: real LLM-backed runSpecialist.
 *
 * If an `OrchestratorContext` is provided (the server sets this via
 * `harness.orchestrator` in the agent's config), we spawn a fresh
 * Agent with the specialist's frozen system prompt + tool subset,
 * run it for at most MAX_SPECIALIST_TURNS, and return the final
 * assistant text.
 *
 * If no context is provided (standalone tests, or the orchestrator
 * is invoked without the harness wired), we fall back to the
 * deterministic stub so existing v3.3 tests still pass and the
 * orchestrator remains callable in a pure-server-tests environment.
 *
 * Either way, the contract is: returns a string report, never throws.
 * Failures (no provider, LLM error, model error) are returned as
 * `[error: ...]` so the orchestrator's caller can see them.
 */
export interface OrchestratorContext {
  registry: { resolveModel(id: string): unknown; isProviderAvailable(p: string): boolean; getStream(model: unknown): unknown };
  parentTools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  defaultModelId: string;
  /** Max turns the specialist may run. Defaults to 12. */
  maxTurns?: number;
}

const MAX_SPECIALIST_TURNS = 12;

export async function runSpecialist(
  name: SpecialistName,
  task: string,
  sandbox: string | null,
  orchestratorCtx?: OrchestratorContext,
): Promise<string> {
  if (!orchestratorCtx) {
    return runSpecialistStub(name, task, sandbox);
  }
  try {
    return await runSpecialistReal(name, task, sandbox, orchestratorCtx);
  } catch (e) {
    return `[error: specialist "${name}" failed — ${(e as Error).message}]`;
  }
}

function runSpecialistStub(
  name: SpecialistName,
  task: string,
  sandbox: string | null,
): string {
  switch (name) {
    case 'code-reviewer': {
      const sandboxLine = sandbox ? `\n  - sandbox: ${sandbox}` : '';
      return [
        '## Findings',
        `  - [NIT] deterministic stub — task was "${truncate(task, 80)}"${sandboxLine}`,
        '  - [WARNING] live LLM review will be enabled once `runSpecialist` calls AgentCore.run()',
        '',
        '## Tests',
        '  - add a smoke test that exercises the touched code path',
      ].join('\n');
    }
    case 'test-runner': {
      return [
        '## Test command',
        '  - npm test  (detected heuristically)',
        '',
        '## Result',
        '  - pass: 0   fail: 0   skip: 0',
        '',
        '## Failures (top 5)',
        '  - (none — deterministic stub did not actually run tests)',
        '',
        '## Suggested next step',
        '  - run-more-thorough',
      ].join('\n');
    }
    case 'doc-writer': {
      const taskLine = truncate(task, 120);
      const sandboxLine = sandbox ? ` for ${sandbox}` : '';
      return [
        '```markdown',
        `# ${taskLine || 'Documentation'}`,
        '',
        `> Auto-generated by the doc-writer specialist${sandboxLine}.`,
        '',
        '## What this is',
        '',
        'TODO: real implementation will be enabled in v3.4.',
        '',
        '## Public API',
        '',
        '- (TBD)',
        '',
        '## Usage',
        '',
        '```',
        '# example',
        '```',
        '',
        '## Pitfalls',
        '',
        '- (TBD)',
        '```',
      ].join('\n');
    }
  }
}

async function runSpecialistReal(
  name: SpecialistName,
  task: string,
  sandbox: string | null,
  ctx: OrchestratorContext,
): Promise<string> {
  const spec = SPECIALISTS[name];
  const modelId = ctx.defaultModelId;
  // We use a loose unknown cast here because the subagent pattern uses the
  // same approach — the AgentCore import lives in agent-core, not coding-agent,
  // and we keep it that way (coding-agent → agent-core is a one-way dep).
  const registryAny = ctx.registry as unknown as { resolveModel(id: string): { provider: string }; isProviderAvailable(p: string): boolean; getStream(m: unknown): unknown };
  const model = registryAny.resolveModel(modelId);
  if (!registryAny.isProviderAvailable(model.provider)) {
    return `[error: provider ${model.provider} not available]`;
  }
  const allowed = new Set<string>(spec.allowedTools);
  const tools = (ctx.parentTools as unknown as Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }>)
    .filter((t) => allowed.has(t.name));
  if (tools.length === 0) {
    return `[error: no tools available for specialist ${name}]`;
  }
  const cwd = sandbox ?? process.cwd();
  // Lazy import agent-core to avoid a cycle (coding-agent is a peer of agent-core,
  // not a consumer). Same pattern as the subagent tool.
  const agentCore = await import('@deqi/agent-core') as unknown as {
    Agent: new (cfg: Record<string, unknown>) => {
      run: (
        msg: { role: 'user'; content: Array<{ type: 'text'; text: string }> },
        emit: (ev: { type: string; event?: { type: string; text?: string } }) => void,
      ) => Promise<void>;
    };
  };
  const agent = new agentCore.Agent({
    registry: ctx.registry,
    modelId,
    system: spec.systemPrompt,
    tools,
    cwd,
    maxTurns: ctx.maxTurns ?? MAX_SPECIALIST_TURNS,
  });

  const promptText = sandbox
    ? `${task}\n\n(Sandbox: ${sandbox}. Stay within it.)`
    : task;
  let finalText = '';
  // We use a no-op emitter (sub-agent events are dropped for now; v3.7 will
  // surface them to the desktop).
  await agent.run(
    { role: 'user', content: [{ type: 'text', text: promptText }] } as never,
    ((ev: { type: string; event?: { type: string; text?: string } }) => {
      if (ev.type === 'message_update' && ev.event?.type === 'text') {
        finalText = ev.event.text ?? '';
      }
    }) as never,
  );
  return finalText || `[error: specialist ${name} returned no text]`;
}

export { ALL_TOOLS };
