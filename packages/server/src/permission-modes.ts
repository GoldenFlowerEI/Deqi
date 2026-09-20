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

/** Tools that are always read-only and never need a prompt. */
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'plan',
  'session_history',
  'self_reflect',
  'constitution',
  'user_model',
  'memory',
  'skill',
  'skill_suggest',
  'git_status',
  'git_log',
]);

/** Tools that mutate the filesystem in-place. */
const FILE_MUTATION_TOOLS = new Set(['edit', 'write']);

/** Tools that spawn subprocesses. The dangerous category. */
const SHELL_TOOLS = new Set(['bash']);

/**
 * Decide whether a tool call should run, ask, or be denied under
 * the given mode. Pure function — no I/O. The harness (server)
 * turns 'ask' into a permission_request / response round-trip.
 */
export function modeAllows(
  mode: PermissionMode,
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _args?: unknown,
): PermissionVerdict {
  // Legacy: chat-only never runs tools.
  if (mode === 'chat_only') return 'deny';

  if (mode === 'bypass-permissions') return 'allow';

  if (mode === 'plan') {
    // In plan mode, read-only tools run silently (so the agent
    // can investigate the codebase) and the `plan` tool itself
    // is allowed (so the agent can produce the plan). Everything
    // else waits for the user to approve-and-switch-modes.
    if (READ_ONLY_TOOLS.has(toolName)) return 'allow';
    if (toolName === 'plan') return 'allow';
    return 'ask';
  }

  if (mode === 'accept-edits') {
    // Read + edit + write are silent; bash still asks.
    if (READ_ONLY_TOOLS.has(toolName)) return 'allow';
    if (FILE_MUTATION_TOOLS.has(toolName)) return 'allow';
    if (SHELL_TOOLS.has(toolName)) return 'ask';
    return 'allow'; // unknown tool — be permissive, the check is best-effort
  }

  // 'default': read-only silent, mutating asks.
  if (READ_ONLY_TOOLS.has(toolName)) return 'allow';
  if (FILE_MUTATION_TOOLS.has(toolName)) return 'ask';
  if (SHELL_TOOLS.has(toolName)) return 'ask';
  return 'ask';
}

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
