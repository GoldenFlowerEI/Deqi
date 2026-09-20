export { SessionManager } from './session.js';
export {
  BUILTIN_TOOLS,
  getBuiltinTool,
  subagentTool,
  constitutionTool,
  userModelTool,
  sessionHistoryTool,
  selfReflectTool,
} from './tools/index.js';
export type { SubagentContext } from './tools/index.js';
export { loadAgentsMd } from './agents-md.js';
export { buildSystemPrompt } from './system-prompt.js';
export { loadConstitution, listPrinciples, _resetConstitutionCache } from './constitution.js';
export { ToolMasteryTracker, type MasteryLevel, attachMasteryTracker } from './tool-mastery.js';
export { UserModel, USER_MODEL_TOPICS, type UserModelTopic, type UserModelObservation } from './user-model.js';
export {
  loadConfig,
  saveConfig,
  setProviderKey,
  setDefaultModel,
  setBehavior,
  setProvider,
  resolveBehavior,
  providerKey,
  configPath,
  _resetConfigCache,
  type DeqiConfig,
  type PermissionMode,
} from './config.js';
// v3.1: long-running project state (initializer + coding agent)
export {
  loadProject,
  saveProject,
  derivePhase,
  initProject,
  pickNextFeature,
  markFeaturePass,
  appendProgress,
  readProgress,
  writeInitScript,
  readInitScript,
  projectIdForCwd,
  projectDir,
  PROJECTS_ROOT,
  type ProjectState,
  type ProjectFeature,
  type ProjectPhase,
} from './state.js';
// v3.2: long-term memory (facts / prefs / patterns / skills)
export {
  readFacts,
  writeFacts,
  addFact,
  findFact,
  searchFacts,
  deleteFact,
  readPrefs,
  writePrefs,
  setPref,
  getPref,
  readPatterns,
  writePatterns,
  addPattern,
  searchPatterns,
  readSkills,
  readSkill,
  writeSkill,
  MEMORY_ROOT,
  type Fact,
  type Pref,
  type TaskPattern,
  type SkillMeta,
  type FactsFile,
  type PrefsFile,
  type PatternsFile,
} from './memory.js';
// v3.9: pre-installed skills (commit / release / test / lint)
export { installBundledSkills, type BundledSkill } from './memory.js';
// v3.3: specialist agents (Minsky K-line)
export {
  SPECIALISTS,
  runSpecialist,
  resolveSandbox,
  ALL_TOOLS,
  type SpecialistName,
  type SpecialistSpec,
  type OrchestratorContext,
} from './specialists.js';
// v3.6: tool result cache (LRU + TTL, used by read + webFetch + browser)
export { ToolCache, hashKey, type CacheStats } from './cache.js';
// v3.6: plan progress helpers
export {
  updatePlanProgress,
  renderPlanProgress,
  findActivePlan,
  type PlanStep,
  type PlanDocument,
  type ToolCall,
} from './plan-progress.js';
// v3.7: Hermes-inspired active memory + reflection + skill auto-suggestion
export {
  retrieveRelevant,
  renderRetrievedMemory,
  tokenize,
  type RetrievalResult,
} from './auto-retrieve.js';
// v3.12: semantic retrieval (TF-IDF + cosine, pluggable Embedder)
export {
  TfIdfEmbedder,
  cosine,
  retrieveSemantic,
  renderSemanticRetrieval,
  retrieveCombined,
  bumpRetrievedUseCounts,
  type Embedder,
  type SemanticRetrievalResult,
} from './semantic-retrieve.js';
// v4.0: Recipe YAML (declarative multi-step workflow)
export {
  parseRecipe,
  stringifyRecipe,
  validateRecipeTools,
  type Recipe,
  type RecipeStep,
} from './recipe.js';
// v4.3: bench reporter — markdown output + regression diff
export {
  renderMarkdownReport,
  compareReports,
  summaryLine,
  type BenchSummary,
  type ComparisonReport,
} from '../bench/bench-reporter.js';
export { reflectOnTool, type ToolReflection } from './reflection.js';
export {
  suggestSkills,
  renderSkillSuggestions,
  listSkills,
  type SkillMatch,
} from './skill-suggest.js';
// v2.0: InteractiveSession and runPrint were removed along with
// the TUI and CLI. The desktop app talks to the deqi-server
// over WebSocket instead; the package no longer ships a CLI.
