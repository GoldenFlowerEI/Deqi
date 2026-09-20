import type { AgentTool } from '@deqi/agent-core';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { bashTool } from './bash.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { subagentTool, type SubagentContext } from './subagent.js';
import { constitutionTool } from './constitution.js';
import { userModelTool } from './user-model.js';
import { sessionHistoryTool, selfReflectTool } from './self-reflect.js';
import { webFetchTool } from './web.js';
import { planTool, type PlanStep, type PlanDocument } from './plan.js';
import { memoryTool } from './memory.js';
import { skillTool } from './skill.js';
import { orchestratorTool } from './orchestrator.js';
import { evalTool } from './eval.js';
import { mcpTool } from './mcp.js';
import { browserTool } from './browser.js';
import { recipeRunTool, executeRecipe, type RecipeStepResult } from './recipe.js';
import { delegateTool } from './delegate.js';
import { delegateRemoteTool } from './delegate-remote.js';
import { TOOL_DESCRIPTIONS, getToolDescription, type ToolName } from './descriptions.js';

export {
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  subagentTool,
  constitutionTool,
  userModelTool,
  sessionHistoryTool,
  selfReflectTool,
  webFetchTool,
  planTool,
  memoryTool,
  skillTool,
  orchestratorTool,
  evalTool,
  mcpTool,
  browserTool,
  recipeRunTool,
  executeRecipe,
  delegateTool,
  delegateRemoteTool,
  type RecipeStepResult,
  TOOL_DESCRIPTIONS,
  getToolDescription,
  type ToolName,
  type PlanStep,
  type PlanDocument,
};
export type { SubagentContext };

/**
 * v3.1: apply the Anthropic 4-principles tool descriptions
 * (descriptions.ts) to each BUILTIN_TOOL. The `description` field
 * here is the only one the system prompt shows to the model, so
 * this is where you shape tool-use quality.
 */
function withDescription(tool: AgentTool, desc: string): AgentTool {
  return { ...tool, description: desc };
}

export const BUILTIN_TOOLS: AgentTool[] = [
  withDescription(readTool, TOOL_DESCRIPTIONS.read),
  withDescription(writeTool, TOOL_DESCRIPTIONS.write),
  withDescription(editTool, TOOL_DESCRIPTIONS.edit),
  withDescription(bashTool, TOOL_DESCRIPTIONS.bash),
  withDescription(grepTool, TOOL_DESCRIPTIONS.grep),
  withDescription(globTool, TOOL_DESCRIPTIONS.glob),
  withDescription(subagentTool, TOOL_DESCRIPTIONS.subagent),
  withDescription(constitutionTool, TOOL_DESCRIPTIONS.constitution),
  withDescription(userModelTool, TOOL_DESCRIPTIONS.user_model),
  withDescription(sessionHistoryTool, TOOL_DESCRIPTIONS.session_history),
  withDescription(selfReflectTool, TOOL_DESCRIPTIONS.self_reflect),
  withDescription(webFetchTool, TOOL_DESCRIPTIONS.webFetch),
  withDescription(planTool, TOOL_DESCRIPTIONS.plan),
  withDescription(memoryTool, TOOL_DESCRIPTIONS.memory),
  withDescription(skillTool, TOOL_DESCRIPTIONS.skill),
  withDescription(orchestratorTool, TOOL_DESCRIPTIONS.orchestrator),
  withDescription(evalTool, TOOL_DESCRIPTIONS.eval),
  withDescription(mcpTool, TOOL_DESCRIPTIONS.mcp),
  withDescription(browserTool, TOOL_DESCRIPTIONS.browser),
  withDescription(recipeRunTool, TOOL_DESCRIPTIONS.recipe ?? 'Run a Recipe YAML file (v4.0).'),
  withDescription(delegateTool, TOOL_DESCRIPTIONS.delegate ?? 'Fan out to N sub-agents in parallel (v4.2).'),
  withDescription(delegateRemoteTool, TOOL_DESCRIPTIONS.delegate_remote ?? 'Fan out to N sub-agents across multiple Deqi desktops (v4.8).'),
];

export function getBuiltinTool(name: string): AgentTool | undefined {
  return BUILTIN_TOOLS.find((t) => t.name === name);
}
