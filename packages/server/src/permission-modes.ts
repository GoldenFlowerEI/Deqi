/**
 * v4.0: 4-tier permission model (Claude Code style).
 *
 * Modes (from most-restrictive to most-permissive):
 *
 *   - 'plan'              — every tool call requires explicit user OK
 *                          (use this when you want a dry run / approval gate
 *                          before anything happens). The `plan` tool is the
 *                          only thing that runs without prompting.
 *   - 'default'           — read-only tools run silently; mutating tools
 *                          (edit, write, bash) prompt for permission. The
 *                          "is this safe?" decision is the user's.
 *   - 'accept-edits'      — read-only + edit + write run silently; bash
 *                          still prompts. Use this when you're
 *                          collaborating on a doc / codebase and trust
 *                          the agent's edits but want to review shell cmds.
 *   - 'bypass-permissions' — nothing prompts. The agent is fully autonomous.
 *                          Use this only when you trust the agent completely
 *                          (and your env is sandboxed / has no secrets).
 *
 * The 5th legacy mode `'chat_only'` (a v2.0 hack that disabled tools
 * entirely) is still honored: it short-circuits the runner with an
 * info event and never reaches the gate.
 *
 * The gate is consulted BEFORE tool.checkPermissions() in the
 * agent-core loop. A mode of `'allow'` lets the call through; `'ask'`
 * queues a permission request (the desktop / WS responds); `'deny'`
 * blocks with a hard error.
 */

export type PermissionMode =
  | 'plan'
  | 'default'
  | 'accept-edits'
  | 'bypass-permissions'
  | 'chat_only';

export type PermissionVerdict = 'allow' | 'ask' | 'deny';

/**
 * How a tool is classified for the permission gate.
 *
 *   read      — observes state, cannot change it. Runs silently in
 *               read-capable modes.
 *   mutate    — changes the filesystem in place. Asks in `default`.
 *   shell     — spawns a subprocess. The dangerous category.
 *   network   — reaches off-box. Asks in `default` and `accept-edits`,
 *               because an outbound fetch can exfiltrate repository
 *               contents to a third party.
 *   escalate  — runs code supplied by something other than the user:
 *               sub-agents, remote delegates, MCP servers, the browser.
 *               These inherit the full tool set of their parent, so
 *               approving one is equivalent to approving `bash` for
 *               a whole fleet. They always ask unless bypassed.
 *   plan      — produces a plan and changes nothing. Always allowed,
 *               including in `plan` mode (that mode exists to produce
 *               one).
 */
export type ToolClass = 'read' | 'mutate' | 'shell' | 'network' | 'escalate' | 'plan';

/**
 * v0.3: the complete classification of every built-in tool.
 *
 * This table is EXHAUSTIVE BY CONSTRUCTION — `assertToolCoverage()` in
 * v3.10-permissions-test.ts fails the build if `BUILTIN_TOOLS` contains
 * a name that is missing here. Before this table existed the previous
 * version listed three tools that do not exist (`skill_suggest`,
 * `git_status`, `git_log`) while omitting nine that do, including every
 * escalation-capable one. Since `modeAllows()` returned `'allow'` for
 * unrecognised tools under `accept-edits`, an MCP call or a remote
 * delegate was silently authorised in the one mode users pick when they
 * believe they are only auto-approving file edits.
 */
const TOOL_CLASS: Record<string, ToolClass> = {
  // ── read-only ────────────────────────────────────────────────────
  read: 'read',
  grep: 'read',
  glob: 'read',
  session_history: 'read',
  self_reflect: 'read',
  constitution: 'read',
  user_model: 'read',
  memory: 'read',
  skill: 'read',

  // ── plan ─────────────────────────────────────────────────────────
  plan: 'plan',

  // ── filesystem mutation ──────────────────────────────────────────
  write: 'mutate',
  edit: 'mutate',
  // `eval` appends to the eval JSONL ledger on every call. It reads
  // like an observation tool but it does write.
  eval: 'mutate',

  // ── subprocess ──────────────────────────────────────────────────
  bash: 'shell',

  // ── off-box ──────────────────────────────────────────────────────
  webFetch: 'network',
  browser: 'network',

  // ── executes code the user did not write ────────────────────────
  subagent: 'escalate',
  orchestrator: 'escalate',
  delegate: 'escalate',
  delegate_remote: 'escalate',
  mcp: 'escalate',
  // The registered name is `recipe_run` (from `recipeRunTool`), not
  // `recipe`. The coverage assertion in v0.3-permission-gate-test
  // caught this on its first run, which is the point of making the
  // table exhaustive by construction.
  recipe_run: 'escalate',
};

/** Every class a mode treats as silently runnable. */
const CLASSES_ALLOWED_WITHOUT_ASK: Record<PermissionMode, Set<ToolClass>> = {
  'plan': new Set<ToolClass>(['read', 'plan']),
  'default': new Set<ToolClass>(['read', 'plan']),
  'accept-edits': new Set<ToolClass>(['read', 'plan', 'mutate']),
  'bypass-permissions': new Set<ToolClass>([
    'read', 'plan', 'mutate', 'shell', 'network', 'escalate',
  ]),
  'chat_only': new Set<ToolClass>(),
};

/**
 * The set of built-in tool names, supplied by the caller so this module
 * stays free of a dependency on `@deqi/coding-agent` (the server already
 * depends on it; keeping the import out avoids a load-order cycle in the
 * permission unit tests).
 */
export function knownToolNames(allToolNames: readonly string[]): string[] {
  return allToolNames.filter((n) => !(n in TOOL_CLASS));
}

/** Tools that are always read-only and never need a prompt. */
const READ_ONLY_TOOLS = new Set(
  Object.entries(TOOL_CLASS).filter(([, c]) => c === 'read').map(([n]) => n),
);

/** Tools that mutate the filesystem in-place. */
const FILE_MUTATION_TOOLS = new Set(
  Object.entries(TOOL_CLASS).filter(([, c]) => c === 'mutate').map(([n]) => n),
);

/** Tools that spawn subprocesses. The dangerous category. */
const SHELL_TOOLS = new Set(
  Object.entries(TOOL_CLASS).filter(([, c]) => c === 'shell').map(([n]) => n),
);

/** Tools that reach off the machine, or run third-party code. */
const OUTBOUND_TOOLS = new Set(
  Object.entries(TOOL_CLASS).filter(([, c]) => c === 'network' || c === 'escalate')
    .map(([n]) => n),
);

/**
 * Decide whether a tool call should run, ask, or be denied under
 * the given mode. Pure function — no I/O. The harness (server)
 * turns 'ask' into a permission_request / response round-trip.
 *
 * Fails CLOSED: a tool this module has never heard of is treated as an
 * escalation and therefore asks. The previous implementation returned
 * `'allow'` for unknown tools under `accept-edits` on the theory that
 * the check was "best-effort" — which is exactly backwards for a
 * security gate, because a newly-added tool would be auto-approved in
 * the mode users choose when they want review.
 */
export function modeAllows(
  mode: PermissionMode,
  toolName: string,
  _args?: unknown,
): PermissionVerdict {
  // Legacy: chat-only never runs tools.
  if (mode === 'chat_only') return 'deny';

  if (mode === 'bypass-permissions') return 'allow';

  const cls = TOOL_CLASS[toolName];
  // Unknown tool — fail closed. A plugin or a future built-in that has
  // not been classified here is assumed to be the most dangerous kind.
  if (cls === undefined) return 'ask';

  return CLASSES_ALLOWED_WITHOUT_ASK[mode].has(cls) ? 'allow' : 'ask';
}

/**
 * v0.3: the class assigned to a tool, for the UI to explain *why* a
 * prompt appeared. Returns `undefined` for tools not in the table.
 */
export function toolClass(toolName: string): ToolClass | undefined {
  return TOOL_CLASS[toolName];
}

export {
  READ_ONLY_TOOLS,
  FILE_MUTATION_TOOLS,
  SHELL_TOOLS,
  OUTBOUND_TOOLS,
};

/**
 * v4.0: human-readable label for the UI / log line.
 */
export function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'plan': return 'Plan (approve every step)';
    case 'default': return 'Default (ask on mutations)';
    case 'accept-edits': return 'Accept edits (bash still asks)';
    case 'bypass-permissions': return 'Bypass (full autonomous)';
    case 'chat_only': return 'Chat only (no tools)';
  }
}

/**
 * v4.0: list the modes the desktop offers in its settings
 * dropdown. The 5th chat_only is internal / not exposed by
 * default; include it for power users via an "Advanced" toggle.
 */
export const USER_VISIBLE_MODES: PermissionMode[] = [
  'plan',
  'default',
  'accept-edits',
  'bypass-permissions',
];

/**
 * Map the legacy v2.0-v3.x mode names to the v4.0 ones. The old
 * names continue to work in the config file for backward compat;
 * the settings UI and runtime treat only the new names. New
 * v4.0 names are passed through unchanged.
 */
export function migrateLegacyMode(
  mode: 'autonomous' | 'smart' | 'manual' | 'chat_only'
    | 'plan' | 'default' | 'accept-edits' | 'bypass-permissions',
): PermissionMode {
  switch (mode) {
    case 'autonomous': return 'bypass-permissions';
    case 'smart': return 'default';
    case 'manual': return 'plan';
    case 'plan':
    case 'default':
    case 'accept-edits':
    case 'bypass-permissions':
    case 'chat_only':
      return mode;
  }
}
