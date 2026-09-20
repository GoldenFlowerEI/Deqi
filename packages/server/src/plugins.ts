/**
 * deqi plugin loader.
 *
 * Plugins live under `~/.deqi/plugins/<name>/` with a
 * `plugin.json` manifest and a Node ESM entrypoint
 * (`index.mjs` or `main` from the manifest). A plugin's
 * `register(api)` hook can:
 *   - register custom tools (api.registerTool)
 *   - register HTTP routes (api.registerRoute)
 *   - subscribe to events (api.on)
 *
 * The full loader (discovery + dynamic import + register
 * call) is gated behind `Deqi_ENABLE_PLUGINS=1` (default
 * off) so a bad plugin can't take down the server on startup.
 * The /v1/plugins REST endpoint always works (it just lists
 * what's on disk + whether each has a valid main).
 *
 * Discovery walks the plugins directory, reads manifests
 * synchronously, validates the schema, and returns metadata.
 * No dynamic import happens at the listing layer.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  type PluginCapability,
  type PluginPermissions,
  resolveGrantedCapabilities,
  validatePermissions,
} from './plugin-permissions.js';

const PLUGINS_DIR = resolve(homedir(), '.deqi', 'plugins');

export interface PluginManifest {
  /** Plugin package name (e.g. "deqi-plugin-foo"). */
  name: string;
  /** SemVer string. */
  version: string;
  /** Short human-readable description. */
  description: string;
  /** Entry point relative to the plugin dir. Defaults to 'index.mjs'. */
  main?: string;
  /** Names of tools this plugin registers (informational). */
  tools?: string[];
  /** Author name + optional URL. */
  author?: string;
  /**
   * v3.10: capabilities this plugin needs. The server resolves
   * declared capabilities against the user's policy. Anything
   * not declared is denied (a plugin must opt in to subprocess,
   * network, fs:write, etc.). When omitted, the plugin only
   * gets the safe default (fs:read, plugin:emit, plugin:on).
   */
  permissions?: PluginPermissions;
}

export interface PluginInfo {
  /** Same as manifest.name. */
  id: string;
  /** Display name (manifest.description or name if missing). */
  displayName: string;
  /** From manifest.version. */
  version: string;
  /** From manifest.description. */
  description: string;
  /** From manifest.tools (defaults to []). */
  tools: string[];
  /** From manifest.author. */
  author?: string;
  /** Absolute path to the plugin directory. */
  path: string;
  /** True if the main entry exists. */
  hasEntry: boolean;
  /** v3.10: capabilities the manifest declares (raw, unfiltered). */
  declaredCapabilities: PluginCapability[];
  /** v3.10: capabilities actually granted after policy resolution. */
  grantedCapabilities: PluginCapability[];
  /** Set if manifest was invalid; describes the error. */
  error?: string;
}

/**
 * Walk the plugins directory and return a PluginInfo for
 * every subdirectory containing a plugin.json. Subdirectories
 * without a manifest are skipped silently (they might be
 * half-installed or unrelated). Invalid manifests are
 * returned with `error` set so the UI can surface them.
 */
export function listPlugins(): PluginInfo[] {
  if (!existsSync(PLUGINS_DIR)) return [];
  const out: PluginInfo[] = [];
  for (const name of readdirSync(PLUGINS_DIR)) {
    const dir = join(PLUGINS_DIR, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(dir, 'plugin.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: PluginManifest | null = null;
    let error: string | undefined;
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PluginManifest>;
      const v = validateManifest(parsed);
      if (v) error = v;
      else manifest = parsed as PluginManifest;
    } catch (err) {
      error = `parse: ${(err as Error).message}`;
    }
    if (manifest) {
      const main = manifest.main ?? 'index.mjs';
      const hasEntry = existsSync(join(dir, main));
      const declared = (manifest.permissions?.capabilities ?? []) as PluginCapability[];
      const { granted, denied } = resolveGrantedCapabilities(declared);
      if (denied.length > 0) {
        console.warn(
          `[Deqi-server] plugin ${manifest.name}: declared capabilities denied by policy: ${denied.join(', ')}`,
        );
      }
      out.push({
        id: manifest.name,
        displayName: manifest.description || manifest.name,
        version: manifest.version,
        description: manifest.description,
        tools: manifest.tools ?? [],
        author: manifest.author,
        path: dir,
        hasEntry,
        declaredCapabilities: declared,
        grantedCapabilities: Array.from(granted),
      });
    } else {
      out.push({
        id: name,
        displayName: name,
        version: '0.0.0',
        description: '(invalid manifest)',
        tools: [],
        path: dir,
        hasEntry: false,
        declaredCapabilities: [],
        grantedCapabilities: [],
        error,
      });
    }
  }
  // Sort by name for stable UI ordering.
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Returns null if the manifest is valid, or a string describing the error. */
function validateManifest(m: Partial<PluginManifest>): string | null {
  if (!m || typeof m !== 'object') return 'manifest is not an object';
  if (typeof m.name !== 'string' || m.name.length === 0) return 'missing name';
  if (typeof m.version !== 'string' || m.version.length === 0) return 'missing version';
  if (typeof m.description !== 'string') return 'description must be a string';
  if (m.tools !== undefined && !Array.isArray(m.tools)) return 'tools must be an array of strings';
  if (m.main !== undefined && typeof m.main !== 'string') return 'main must be a string';
  // v3.10: permissions block (optional). If present, every
  // capability must be a known one — typos are caught here
  // before the plugin ever runs.
  if (m.permissions !== undefined) {
    const permErr = validatePermissions(m.permissions);
    if (permErr) return `permissions: ${permErr}`;
  }
  return null;
}

export const PLUGIN_PATHS = { PLUGINS_DIR } as const;

// ─── v2.3: actually load + invoke plugins ─────────────────────────

/**
 * Loose shape of a tool a plugin wants to register. The server
 * wraps this in the AgentTool shape the rest of deqi uses. The
 * fields mirror AgentTool so the plugin author can be flexible.
 */
export interface PluginTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (args: unknown, ctx: { cwd: string }) => Promise<unknown>;
}

/**
 * The handle a plugin's `register(api)` function gets. Plugins
 * use it to add tools, routes, and event handlers. Everything
 * a plugin registers is namespaced by the plugin's name so
 * collisions are detected at load time.
 */
export interface PluginApi {
  /** Read-only: the plugin's manifest. */
  readonly manifest: PluginManifest;
  /**
   * v3.10: capabilities the server granted this plugin after
   * policy resolution. Plugins call `api.hasCapability(...)`
   * or `api.requireCapability(...)` before performing a
   * privileged action (spawning a subprocess, opening a
   * network connection, writing a file).
   */
  readonly grantedCapabilities: ReadonlySet<PluginCapability>;
  /** v3.10: returns true if the given capability is granted. */
  hasCapability(cap: PluginCapability): boolean;
  /** v3.10: throws a descriptive error if the capability is not
   *  granted. Use this right before a privileged action so the
   *  plugin's stack trace points at the offending call. */
  requireCapability(cap: PluginCapability): void;
  /** Register a tool. The tool's name must be unique across
   *  all loaded plugins AND the server's BUILTIN_TOOLS. */
  registerTool(tool: PluginTool): void;
  /** Register an HTTP route. Method + path. */
  registerRoute(method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', path: string, handler: (req: unknown) => unknown | Promise<unknown>): void;
  /** Subscribe to a server event (e.g. 'agent_start', 'turn_end'). */
  on(event: string, handler: (...args: unknown[]) => void): void;
  /** Log a line to the server's stdout. */
  log(msg: string): void;
}

/** What loadPlugins() actually applied. */
export interface PluginLoadResult {
  id: string;
  manifest: PluginManifest;
  path: string;
  tools: PluginTool[];
  /** v3.9: routes with live handlers (not just metadata), so
   *  the server can dispatch HTTP requests to the plugin. */
  routes: Array<{
    method: string;
    path: string;
    handler: (req: unknown) => unknown | Promise<unknown>;
  }>;
  /** v3.9: event subscribers — `events` lists names; `eventHandlers`
   *  pairs each name with the actual handler the plugin
   *  registered. The server calls these synchronously from
   *  the agent event dispatch path. */
  events: string[];
  eventHandlers: Array<{
    event: string;
    handlers: Array<(...args: unknown[]) => void>;
  }>;
  /** v3.10: capabilities actually granted to this plugin
   *  (after policy resolution). */
  grantedCapabilities: PluginCapability[];
  error?: string;
}

/**
 * Discover + dynamic-import + register every enabled plugin.
 *
 * Gated by `Deqi_ENABLE_PLUGINS=1` so production servers can
 * ship with the loader off. The first iteration wraps each
 * plugin's register() call in a try/catch so a crashing plugin
 * can't take down the server. Per-plugin errors are reported
 * via the `error` field on the result, not by throwing.
 */
export async function loadPlugins(opts: { enabled: boolean } = { enabled: process.env.Deqi_ENABLE_PLUGINS === '1' }): Promise<PluginLoadResult[]> {
  const out: PluginLoadResult[] = [];
  if (!opts.enabled) {
    return out;
  }
  if (!existsSync(PLUGINS_DIR)) {
    return out;
  }
  const infos = listPlugins();
  for (const info of infos) {
    const result: PluginLoadResult = {
      id: info.id,
      eventHandlers: [],
      manifest: {
        name: info.id,
        version: info.version,
        description: info.description,
        main: 'index.mjs',
        tools: info.tools,
        author: info.author,
      },
      path: info.path,
      tools: [],
      routes: [],
      events: [],
      grantedCapabilities: info.grantedCapabilities ?? [],
    };
    if (!info.hasEntry) {
      result.error = 'no entry file';
      out.push(result);
      continue;
    }
    if (info.error) {
      result.error = `manifest: ${info.error}`;
      out.push(result);
      continue;
    }
    const entryRel = info.id && info.tools ? (infos.find((i) => i.id === info.id) ? 'index.mjs' : 'index.mjs') : 'index.mjs';
    // Re-read manifest to get the `main` field (listPlugins normalizes away).
    let mainEntry = 'index.mjs';
    try {
      const raw = readFileSync(join(info.path, 'plugin.json'), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PluginManifest>;
      if (typeof parsed.main === 'string') mainEntry = parsed.main;
    } catch { /* fall through with default */ }
    const fullPath = join(info.path, mainEntry);
    const tools: PluginTool[] = [];
    const routes: PluginLoadResult['routes'] = [];
    const eventMap = new Map<string, Array<(...args: unknown[]) => void>>();
    const events: string[] = [];
    // v3.10: the granted capability set. Built from listPlugins
    // (which already resolved declared vs policy). The api lets
    // plugins check + require capabilities.
    const grantedCapabilities = new Set<PluginCapability>(
      (info.grantedCapabilities ?? []) as PluginCapability[],
    );
    const api: PluginApi = {
      manifest: result.manifest,
      grantedCapabilities,
      hasCapability(cap) {
        return grantedCapabilities.has(cap);
      },
      requireCapability(cap) {
        if (!grantedCapabilities.has(cap)) {
          throw new Error(
            `plugin '${info.id}' attempted '${cap}' but did not declare it in its manifest's permissions. ` +
              `Add '${cap}' to permissions.capabilities in plugin.json and re-install.`,
          );
        }
      },
      registerTool(t) {
        tools.push(t);
      },
      registerRoute(method, path, handler) {
        routes.push({ method, path, handler });
      },
      on(event, handler) {
        const list = eventMap.get(event) ?? [];
        list.push(handler);
        eventMap.set(event, list);
        events.push(event);
      },
      log(msg) {
        // eslint-disable-next-line no-console
        console.log(`[plugin:${info.id}] ${msg}`);
      },
    };
    try {
      // dynamic import — the path must be a file:// URL
      const url = new URL('file:///' + fullPath.replace(/\\/g, '/'));
      const mod = await import(url.href);
      if (typeof mod.register === 'function') {
        await mod.register(api);
        result.tools = tools;
        result.routes = routes;
        result.events = events;
        result.eventHandlers = Array.from(eventMap.entries()).map(([event, handlers]) => ({ event, handlers }));
      } else {
        result.error = 'no `register(api)` export';
      }
    } catch (e) {
      result.error = `load: ${(e as Error).message}`;
    }
    void entryRel; // silence unused warning
    out.push(result);
  }
  return out;
}
