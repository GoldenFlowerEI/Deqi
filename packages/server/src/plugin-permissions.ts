/**
 * v3.10: plugin permission model.
 *
 * A plugin manifest declares the set of capabilities it needs.
 * At load time the server checks that the declared set is a
 * subset of the user's installed-policy allowlist. A plugin that
 * tries to use a capability it didn't declare fails fast.
 *
 * The capability set is intentionally small. Each one is a
 * coarse-grained "yes/no" gate — not a fine-grained policy. We
 * trade off expressiveness for the safety property that a
 * human can read a manifest and instantly know what the plugin
 * can do.
 *
 * Capabilities:
 *   - 'fs:read'         read files in the cwd (read tool, glob, grep)
 *   - 'fs:write'        write / edit files in the cwd
 *   - 'subprocess'      spawn a child process (e.g. git, npm)
 *   - 'network'         open arbitrary outbound HTTP / fetch
 *   - 'env'             read environment variables
 *   - 'plugin:emit'     register HTTP routes (sends server-side events)
 *   - 'plugin:on'       subscribe to agent events
 *
 * Anything NOT in this list (e.g. "delete the user's home dir",
 * "modify global state") is a hard NO regardless of declaration.
 * Plugins cannot request capabilities the system doesn't know.
 */
export const KNOWN_CAPABILITIES = [
  'fs:read',
  'fs:write',
  'subprocess',
  'network',
  'env',
  'plugin:emit',
  'plugin:on',
] as const;

export type PluginCapability = (typeof KNOWN_CAPABILITIES)[number];

/** Default allowlist: the safe-by-default set a plugin gets
 *  without the user editing a policy file. Includes the
 *  capabilities the bundled official plugins need (subprocess
 *  for git, network for http-fetch) because blocking them
 *  would make the bundle useless. `fs:write` and `env` are
 *  STILL denied by default — those are the dangerous ones. */
export const DEFAULT_POLICY: ReadonlySet<PluginCapability> = new Set([
  'fs:read',
  'subprocess',
  'network',
  'plugin:emit',
  'plugin:on',
]);

/** Permissions declared in the manifest. */
export interface PluginPermissions {
  capabilities: PluginCapability[];
}

/**
 * Validate a permissions block from a manifest. Returns an error
 * string if invalid, or null if ok. The set is allowed to be
 * empty (the plugin then has no capabilities beyond the API
 * surface itself).
 */
export function validatePermissions(perms: unknown): string | null {
  if (perms === undefined || perms === null) return null;
  if (typeof perms !== 'object') return 'permissions must be an object';
  const obj = perms as { capabilities?: unknown };
  if (obj.capabilities === undefined) return null;
  if (!Array.isArray(obj.capabilities)) return 'permissions.capabilities must be an array';
  for (const c of obj.capabilities) {
    if (typeof c !== 'string') return 'each capability must be a string';
    if (!KNOWN_CAPABILITIES.includes(c as PluginCapability)) {
      return `unknown capability: '${c}' — must be one of ${KNOWN_CAPABILITIES.join(', ')}`;
    }
  }
  return null;
}

/**
 * v3.10: enforce the policy. Given a plugin's declared
 * capabilities and the active policy (default = DEFAULT_POLICY),
 * return the set of capabilities the plugin is actually granted.
 * A declared capability not in the policy is dropped (with a
 * warning the server can log).
 */
export function resolveGrantedCapabilities(
  declared: PluginCapability[],
  policy: ReadonlySet<PluginCapability> = DEFAULT_POLICY,
): { granted: Set<PluginCapability>; denied: PluginCapability[] } {
  const granted = new Set<PluginCapability>();
  const denied: PluginCapability[] = [];
  for (const c of declared) {
    if (policy.has(c)) granted.add(c);
    else denied.push(c);
  }
  return { granted, denied };
}

/**
 * Throws if the granted set does not contain `cap`. Plugins
 * import this and call it before performing a privileged action
 * — e.g. before a `bash` tool spawn or a `webFetch`. The
 * error is informative so misconfigured plugins can self-diagnose.
 */
export function requireCapability(
  granted: ReadonlySet<PluginCapability>,
  cap: PluginCapability,
  pluginName: string,
): void {
  if (!granted.has(cap)) {
    throw new Error(
      `plugin '${pluginName}' attempted '${cap}' but did not declare it in its manifest's permissions. ` +
        `Add '"${cap}"' to permissions.capabilities in plugin.json and re-install.`,
    );
  }
}
