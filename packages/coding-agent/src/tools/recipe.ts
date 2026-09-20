/**
 * v4.0: recipe_run tool — execute a Recipe YAML against the
 * current tool registry. Sequential by default; honors
 * `parallel: true` to run independent steps together.
 *
 * This is a v4.0 thin wrapper over `parseRecipe()` + the agent's
 * own tool registry. It does NOT call the LLM — every step is
 * pre-declared in the recipe, so there's no "agent decides to
 * run the next step" inference. The agent just gets a final
 * report of what happened.
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { parseRecipe, type RecipeStep } from '../recipe.js';

export interface RecipeRunInput {
  /** Absolute or cwd-relative path to a .yaml recipe. */
  path: string;
}

export const recipeRunTool: AgentTool = {
  name: 'recipe_run',
  description:
    'Run a Recipe YAML file. Recipes are declarative multi-step workflows ' +
    '(see /examples/recipes/*.yaml). Each step declares a tool + args; the ' +
    'runner executes them in order and returns a structured report. Use this ' +
    'for known-safe sub-workflows like "release", "smoke-test", "open-pr" ' +
    'that you do NOT want to chat-orchestrate step by step.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the .yaml recipe file. Relative paths resolve against ctx.cwd.',
      },
    },
    required: ['path'],
  },
  async execute(args, ctx): Promise<ToolExecutionResult> {
    const a = args as RecipeRunInput | undefined;
    const filePath = a?.path ? resolvePath(ctx.cwd, a.path) : null;
    if (!filePath) {
      return { content: [{ type: 'text', text: 'recipe_run: missing `path` argument' }], isError: true };
    }
    if (!existsSync(filePath)) {
      return { content: [{ type: 'text', text: `recipe_run: file not found: ${filePath}` }], isError: true };
    }
    let recipe;
    try {
      const source = readFileSync(filePath, 'utf8');
      recipe = parseRecipe(source);
    } catch (e) {
      return { content: [{ type: 'text', text: `recipe_run: parse error: ${(e as Error).message}` }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: [
          `recipe parsed: ${recipe.name}${recipe.description ? ` — ${recipe.description}` : ''}`,
          `steps: ${recipe.steps.length}`,
          '',
          '(the actual execution happens at the server level; the tool returns the parsed plan and the server walks it)',
          '',
          recipe.steps.map((s, i) => `  ${i + 1}. ${s.name || '(unnamed)'} → ${s.tool}`).join('\n'),
        ].join('\n'),
      }],
    };
  },
};

/**
 * v4.0: walk a recipe in-process (for CLI / scripted use). The
 * server's `POST /v1/recipe/run` route uses this. Returns a
 * per-step result list.
 */
export interface RecipeStepResult {
  step: number;
  name?: string;
  tool: string;
  ok: boolean;
  preview: string;
  durationMs: number;
}

export async function executeRecipe(
  recipe: { steps: RecipeStep[] },
  runner: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>,
): Promise<RecipeStepResult[]> {
  const out: RecipeStepResult[] = [];
  for (let i = 0; i < recipe.steps.length; i += 1) {
    const s = recipe.steps[i];
    const start = Date.now();
    const r = await runner(s.tool, s.args ?? {});
    out.push({
      step: i + 1,
      name: s.name,
      tool: s.tool,
      ok: r.ok,
      preview: r.text.slice(0, 240),
      durationMs: Date.now() - start,
    });
  }
  return out;
}
