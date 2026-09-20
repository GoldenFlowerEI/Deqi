/**
 * Deqi-server: HTTP + WebSocket facade for the agent-core.
 *
 * The server is a thin transport layer. All the actual agent
 * logic lives in @deqi/agent-core, @deqi/coding-agent, and
 * @deqi/introspection; this file just exposes that logic over
 * a JSON+WebSocket API the desktop app consumes.
 *
 * Architecture (v0.1):
 *
 *   Desktop (Tauri/React)
 *        │  WebSocket /v1/chat (session events)
 *        │  HTTP      /v1/sessions, /v1/models, /v1/tools
 *        ▼
 *   ┌─────────────────────────────────┐
 *   │  HTTP server (Node 22)          │
 *   │  - REST: sessions, models, ...  │
 *   │  - WS:   /v1/chat (multiplexed) │
 *   └────────────┬────────────────────┘
 *                │
 *   ┌────────────▼────────────────────┐
 *   │  AgentRunner (one per session)  │
 *   │  - Agent (agent-core)           │
 *   │  - SessionManager (JSONL)       │
 *   │  - permission queue             │
 *   └─────────────────────────────────┘
 *
 * The server binds to 127.0.0.1 only — deqi is a local-only
 * product, not a SaaS. The desktop app and the server share the
 * same machine.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ModelRegistry } from '@deqi/ai';
import { ClusterRegistry } from './cluster-registry.js';
import { getDesktopId } from './desktop-identity.js';
import {
  BUILTIN_TOOLS,
  loadConfig,
  saveConfig,
  setDefaultModel,
  setBehavior,
  setProvider,
  resolveBehavior,
  SessionManager,
  getBuiltinTool,
  installBundledSkills,
  type PermissionMode,
} from '@deqi/coding-agent';
import { AgentRunner } from './agent-runner.js';
import { listPlugins, loadPlugins, type PluginTool, type PluginLoadResult } from './plugins.js';
import { PluginWatcher } from './plugin-watcher.js';
import { Telemetry } from './telemetry.js';
import {
  handleSearch,
  handleListSchedule,
  handleCreateSchedule,
  handleUpdateSchedule,
  handleDeleteSchedule,
  handleRunScheduleNow,
  handleListFiles,
  handleCreateFeedback,
  handleListFeedback,
  handleListPairs,
  handleCreatePair,
  handleDeletePair,
  type ScheduleItem,
} from './v2endpoints.js';
import type {
  WsClientMessage,
  WsServerMessage,
  SessionEvent,
  SessionSummary,
  SessionDetails,
  ModelInfo,
  ToolInfo,
  ServerConfig,
} from './types.js';

const PROTOCOL_VERSION = 1;
const SESSION_PATH = 'C--Users-P1'; // unused; kept for compat
const SERVER_VERSION = '0.1.0';

/**
 * v3.9.1: Match a plugin route pattern against a request path,
 * returning the named `:param` values on a hit, or `null` on
 * miss. Patterns may contain `:name` segments; everything else
 * must match literally. Trailing slashes and case are significant.
 *
 *   matchPluginRoute('/v1/plugin/foo/:id', '/v1/plugin/foo/42')
 *     → { id: '42' }
 *   matchPluginRoute('/v1/plugin/foo/:id', '/v1/plugin/foo')
 *     → null
 *   matchPluginRoute('/v1/plugin/foo/:id', '/v1/plugin/foo/')
 *     → null  (trailing slash is not a free match)
 */
function matchPluginRoute(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i];
    const v = pathParts[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return null;
    }
  }
  return params;
}

/**
 * Read the request body as parsed JSON, or `null` if empty /
 * not JSON. Bounded to 4MB to avoid runaway plugins.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > 4 * 1024 * 1024) {
        req.destroy();
        resolveP(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolveP(null);
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolveP(JSON.parse(text)); } catch { resolveP(text); }
    });
    req.on('error', () => resolveP(null));
  });
}

export interface ServerOptions {
  /** Host to bind to. Defaults to 127.0.0.1 (local-only). */
  host?: string;
  /** Port to bind to. Defaults to 7700. */
  port?: number;
}

export class DeqiServer {
  private httpServer: ReturnType<typeof createServer> | null = null;
  private runners = new Map<string, AgentRunner>();
  private wsClients = new Set<WsClient>();
  /** v4.1: mobile push subscribers (paired phones reading the
   *  session event stream). Separate from wsClients so a phone
   *  doesn't get raw tool-call events the desktop is meant to
   *  render. Each PushClient has a `pairId` and a `deviceName`. */
  private pushClients = new Set<PushClient>();
  private registry: ModelRegistry;
  /**
   * v2.3: tools contributed by plugins. Loaded on `init()` when
   * `Deqi_ENABLE_PLUGINS=1` is set. The AgentRunner passes these
   * to the agent as additional tools alongside BUILTIN_TOOLS.
   * Public so the /v1/plugins REST endpoint and the /v1/tools
   * endpoint can report them.
   */
  pluginTools: PluginTool[] = [];
  pluginLoadResults: PluginLoadResult[] = [];
  /** v3.9: routes registered by plugins. Matched AFTER all
   *  built-in /v1/* routes so a plugin can't shadow a core API.
   *  Path uses express-style params (e.g. `/v1/plugin/foo/:id`). */
  pluginRoutes: Array<{ method: string; path: string; handler: (req: unknown) => unknown | Promise<unknown> }> = [];
  /** v3.9: event subscribers registered by plugins. Keyed by
   *  event name. Called synchronously from the agent event
   *  dispatch path; exceptions are swallowed (logged). */
  private pluginEventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  /** v4.6: file watcher for hot-reload. Null until start() runs
   *  with Deqi_ENABLE_PLUGINS=1 AND a watch is requested. */
  private pluginWatcher: PluginWatcher | null = null;
  /** v4.7: opt-in telemetry. Disabled by default; enable via
   *  Deqi_TELEMETRY=1 env or POST /v1/telemetry/opt-in. */
  readonly telemetry: Telemetry = new Telemetry();
  /** v4.8: multi-desktop cluster registry. The local entry
   *  advertises this server to other Deqi servers sharing the
   *  same `~/.deqi/` (via cluster.json). */
  readonly cluster: ClusterRegistry = new ClusterRegistry();

  constructor(public readonly opts: ServerOptions = {}) {
    this.registry = this.buildRegistry();
  }

  /**
   * Build a fresh ModelRegistry from the persisted config. Called
   * once at construction and again whenever a provider config
   * changes (PUT /v1/config/providers/:name), so newly-added
   * providers take effect without a server restart.
   */
  private buildRegistry(): ModelRegistry {
    const cfg = loadConfig() ?? { providers: {} };
    const providers = (cfg.providers ?? {}) as Record<string, { apiKey?: string; baseUrl?: string; path?: string } | undefined>;
    return new ModelRegistry({
      anthropic: providers.anthropic
        ? { apiKey: providers.anthropic.apiKey ?? '' }
        : undefined,
      openai: providers.openai
        ? { apiKey: providers.openai.apiKey ?? '' }
        : undefined,
      google: providers.google
        ? { apiKey: providers.google.apiKey ?? '' }
        : undefined,
      'openai-compat': providers['openai-compat']
        ? {
            apiKey: providers['openai-compat'].apiKey ?? '',
            baseUrl: providers['openai-compat'].baseUrl ?? '',
            // v1.1.x config: `path` overrides the default
            // `/v1/chat/completions`; pass it through so the
            // desktop app can hit the same endpoint as the CLI.
            path: providers['openai-compat'].path,
          }
        : undefined,
    });
  }

  /** Rebuild the registry. Call after mutating config. */
  private rebuildRegistry(): void {
    this.registry = this.buildRegistry();
  }

  /** Start the server. Resolves once listening. */
  async start(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? 7700;

    // v3.9: install bundled skills (commit / release / test / lint)
    // on first run. Only writes skills that don't exist yet, so
    // user edits are preserved. The data file is bundled with the
    // @deqi/coding-agent package.
    try {
      const r = installBundledSkills();
      if (r.installed.length > 0) {
        console.log(`[Deqi-server] installed ${r.installed.length} bundled skill(s): ${r.installed.join(', ')}`);
      }
    } catch (e) {
      console.error(`[Deqi-server] failed to install bundled skills: ${(e as Error).message}`);
    }

    // v2.3: load plugins (gated by Deqi_ENABLE_PLUGINS=1). We do
    // this BEFORE binding the port so a misbehaving plugin can't
    // hold the port open. Each plugin's register() is wrapped in
    // try/catch in loadPlugins(); we just collect what worked.
    if (process.env.Deqi_ENABLE_PLUGINS === '1') {
      await this.loadAndWirePlugins();
      // v4.6: start the file watcher so plugin edits don't need
      // a server restart. The watcher calls back into
      // refreshPlugins() on add/modify/remove.
      const pluginsDir = join(homedir(), '.deqi', 'plugins');
      this.pluginWatcher = new PluginWatcher({
        pluginsDir,
        onChange: (name, reason) => {
          console.log(`[Deqi-server] plugin ${name} ${reason} changed; hot-reloading`);
          void this.refreshPlugins().catch((e) => {
            console.error(`[Deqi-server] plugin hot-reload failed: ${(e as Error).message}`);
          });
        },
      });
      this.pluginWatcher.start();
      console.log(`[Deqi-server] plugin watcher started on ${pluginsDir}`);
      // v4.7: opt-in telemetry via env var
      if (process.env.Deqi_TELEMETRY === '1') {
        this.telemetry.enable();
        this.telemetry.rebuildFromDisk();
        this.propagateTelemetry();
        console.log('[Deqi-server] telemetry enabled via Deqi_TELEMETRY=1');
      }
    }

    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.httpServer.on('clientError', (err, _socket) => {
      // Swallow the noisy "Parse Error" from browsers probing the
      // port — they're checking if a WebSocket server is running,
      // not actually connecting.
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        console.error('[Deqi-server] client error:', err.message);
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(port, host, () => resolve());
    });
    this.startScheduler();

    // v4.8: register this server in the multi-desktop cluster.
    // The local entry advertises our name + host + port + tags +
    // a baseline set of capabilities (every built-in tool, plus
    // each loaded plugin id). The cluster heartbeat will refresh
    // `last_heartbeat` every 5s until stop().
    const localName =
      process.env.Deqi_DESKTOP_NAME ?? `desktop-${getDesktopId().slice(2, 8)}`;
    const localTags = (process.env.Deqi_DESKTOP_TAGS ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    this.cluster.start({
      name: localName,
      host,
      port,
      tags: localTags,
      capabilities: this.collectCapabilities(),
    });
    console.log(`[Deqi-server] cluster: registered as ${getDesktopId()} (${localName}) on ${host}:${port}`);

    return { host, port };
  }

  /**
   * v4.8: compute the local desktop's advertised capabilities.
   * Built-in tools are always present; loaded plugin ids are
   * appended on top. Called once on start() and again after
   * every plugin hot-reload so the cluster registry reflects
   * the current set.
   */
  private collectCapabilities(): string[] {
    const caps: string[] = BUILTIN_TOOLS.map((t) => t.name);
    for (const r of this.pluginLoadResults) {
      if (!r.error) caps.push(r.id);
    }
    return caps;
  }

  // ─── v4.4: permission grant endpoints ─────────────────────

  /**
   * v4.4: list every grant across every runner. The desktop UI
   * uses this to show "you've approved these N things". The
   * returned grants are flat (one row per grant); the level +
   * cwdScope tell the UI how to render and whether the grant is
   * still active.
   */
  private handleListGrants(res: ServerResponse): void {
    const all: unknown[] = [];
    for (const r of this.runners.values()) {
      for (const g of r.listGrants()) {
        all.push({ ...g, session_id: r.sessionId, cwd: r.cwd });
      }
    }
    this.json(res, { grants: all });
  }

  /**
   * v4.4: record a new grant. Body shape:
   *   { session_id, tool, pattern?, level, cwdScope?, note? }
   * The default cwd scope is the session's cwd. The default
   * pattern is 'exact' (matches the single tool name).
   */
  private async handleAddGrant(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await readBody(req) as {
      session_id?: string;
      tool?: string;
      pattern?: 'exact' | 'prefix';
      level?: 'turn' | 'session' | 'forever';
      cwdScope?: string;
      note?: string;
    } | null;
    if (!body || !body.tool || !body.level || !body.session_id) {
      this.json(res, { error: 'missing required fields: tool, level, session_id' }, 400);
      return;
    }
    const runner = this.runners.get(body.session_id);
    if (!runner) {
      this.json(res, { error: 'session_not_found' }, 404);
      return;
    }
    const grant = runner.addGrant({
      tool: body.tool,
      pattern: body.pattern ?? 'exact',
      level: body.level,
      cwdScope: body.cwdScope,
      note: body.note,
    });
    this.json(res, { ok: true, grant, session_id: body.session_id });
  }

  /** v4.4: drop a grant by id. Walks every runner's grant store. */
  private handleRemoveGrant(res: ServerResponse, id: string): void {
    for (const r of this.runners.values()) {
      if (r.removeGrant(id)) {
        this.json(res, { ok: true, id });
        return;
      }
    }
    this.json(res, { error: 'not_found' }, 404);
  }

  // ─── v4.7: telemetry endpoints ──────────────────────────────

  /** v4.7: enable / disable telemetry at runtime. Body:
   *   { enabled: boolean }
   * When enabling, we also rebuild the in-memory summary from
   * the on-disk JSONL so the aggregate has full history. */
  private async handleTelemetryOptIn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as { enabled?: boolean } | null;
    if (body?.enabled) {
      this.telemetry.enable();
      this.telemetry.rebuildFromDisk();
      this.propagateTelemetry();
    } else {
      this.telemetry.disable();
    }
    this.json(res, { ok: true, enabled: this.telemetry.isEnabled() });
  }

  /** v4.7: snapshot the in-memory summary. */
  private handleTelemetryAggregate(res: ServerResponse): void {
    this.json(res, { ok: true, summary: this.telemetry.getSummary() });
  }

  /** v4.7: report whether telemetry is on + where it's stored. */
  private handleTelemetryStatus(res: ServerResponse): void {
    this.json(res, { ok: true, enabled: this.telemetry.isEnabled() });
  }

  /** v4.7: when telemetry is toggled, every existing runner
   *  needs its `telemetry` field updated. New runners created
   *  after the toggle pick up the new recorder via the
   *  constructor closure. */
  private propagateTelemetry(): void {
    for (const r of this.runners.values()) {
      r.telemetry = this.telemetry;
    }
  }

  // ─── v4.6: plugin loading + hot-reload helpers ──────────────

  /**
   * v4.6: re-run `loadPlugins` and replace every per-plugin
   * slice in the server's collections. Used both at startup
   * (after `loadAndWirePlugins` did the initial pass) and on
   * every file-watcher callback. The replacement is whole-
   * plugin: a single broken plugin takes down only its own
   * tools/routes/events, not the rest.
   */
  private async loadAndWirePlugins(): Promise<void> {
    this.pluginLoadResults = await loadPlugins({ enabled: true });
    for (const r of this.pluginLoadResults) {
      if (r.error) {
        console.error(`[Deqi-server] plugin ${r.id} failed to load: ${r.error}`);
        continue;
      }
      console.log(`[Deqi-server] plugin ${r.id} loaded: ${r.tools.length} tools, ${r.routes.length} routes, ${r.events.length} events`);
      for (const t of r.tools) this.pluginTools.push(t);
      for (const route of r.routes) {
        this.pluginRoutes.push({
          method: route.method,
          path: route.path,
          handler: route.handler,
        });
      }
      for (const entry of r.eventHandlers ?? []) {
        const list = this.pluginEventHandlers.get(entry.event) ?? [];
        for (const h of entry.handlers) list.push(h);
        this.pluginEventHandlers.set(entry.event, list);
      }
    }
  }

  /**
   * v4.6: hot-reload. Drops every plugin's slice from the
   * server's collections, then re-loads from disk. The drop
   * is per-id: a plugin that didn't change stays a fresh
   * load with a new dynamic-import.
   *
   * We could try to be smarter (only re-import the changed
   * plugin) but the cost of loadPlugins is tiny (~50ms for
   * 5 plugins) and the whole-replace semantics are easier
   * to reason about.
   */
  async refreshPlugins(): Promise<void> {
    if (process.env.Deqi_ENABLE_PLUGINS !== '1') return;
    // Snapshot the old tool / route / event slices keyed by
    // plugin id so we know which entries belong to which plugin
    // after the reload.
    const oldToolCount = this.pluginTools.length;
    const oldRouteCount = this.pluginRoutes.length;
    // Re-load the underlying list. We don't preserve the OLD
    // collections in place because plugin entry-points may have
    // changed; we just re-run a fresh load.
    this.pluginTools = [];
    this.pluginRoutes = [];
    this.pluginEventHandlers = new Map();
    this.pluginLoadResults = [];
    try {
      await this.loadAndWirePlugins();
      const dTools = this.pluginTools.length - oldToolCount;
      const dRoutes = this.pluginRoutes.length - oldRouteCount;
      console.log(`[Deqi-server] plugin reload complete: ${this.pluginTools.length} tools, ${this.pluginRoutes.length} routes (Δtools=${dTools}, Δroutes=${dRoutes})`);
      // v4.8: refresh the cluster's advertised capabilities so a
      // newly-loaded plugin becomes discoverable to peer desktops
      // without waiting for the next 5s heartbeat.
      this.cluster.updateLocal({ capabilities: this.collectCapabilities() });
    } catch (e) {
      console.error(`[Deqi-server] plugin reload failed: ${(e as Error).message}`);
    }
  }

  /** Stop the server and close all WS clients. */
  async stop(): Promise<void> {
    // Stop the periodic scheduler first so we don't fire more
    // runs while the runners are being torn down.
    this.stopScheduler();
    // v4.6: tear down the plugin watcher so we don't leak the
    // fs.watch handle on shutdown.
    if (this.pluginWatcher) { this.pluginWatcher.close(); this.pluginWatcher = null; }
    // v4.4: clear every runner's session-scoped grants. Forever
    // grants are persisted to disk and survive the restart.
    for (const r of this.runners.values()) {
      try { r.grantStore.clearSessionGrants(); } catch { /* ignore */ }
    }
    for (const ws of this.wsClients) {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.wsClients.clear();
    for (const pc of this.pushClients) {
      try { pc.close(); } catch { /* ignore */ }
    }
    this.pushClients.clear();
    // v4.8: deregister from the cluster so other desktops see us
    // as gone immediately (faster than waiting for the 15s
    // heartbeat staleness check).
    this.cluster.stop();
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  // ─── HTTP routes ─────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // CORS — desktop app is on a different origin (tauri://...)
      // so we must allow cross-origin requests from the local
      // webview. We accept * because the server only binds to
      // 127.0.0.1, so cross-origin attacks are infeasible.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Health
      if (path === '/health' && method === 'GET') return this.json(res, { ok: true, version: SERVER_VERSION });

      // Sessions
      if (path === '/v1/sessions' && method === 'GET') return this.handleListSessions(req, res, url);
      if (path === '/v1/sessions' && method === 'POST') return this.handleCreateSession(req, res, url);
      const sessionMatch = path.match(/^\/v1\/sessions\/([A-Za-z0-9_-]+)(\/.*)?$/);
      if (sessionMatch) {
        const [, id, sub] = sessionMatch;
        if (!sub && method === 'GET') return this.handleGetSession(id, res);
        if (!sub && method === 'DELETE') return this.handleDeleteSession(id, res);
        if (sub === '/messages' && method === 'GET') return this.handleGetSessionMessages(id, res);
        if (sub === '/resume' && method === 'POST') return this.handleResumeSession(id, res);
      }

      // Catalog
      if (path === '/v1/models' && method === 'GET') return this.handleListModels(res);
      if (path === '/v1/tools' && method === 'GET') return this.handleListTools(res);

      // Config
      if (path === '/v1/config' && method === 'GET') return this.handleGetConfig(res);
      if (path === '/v1/config' && method === 'PATCH') return this.handlePatchConfig(req, res);
      // v2.2: single-provider update (PUT /v1/config/providers/:name)
      const providerMatch = path.match(/^\/v1\/config\/providers\/([a-zA-Z0-9_-]+)$/);
      if (providerMatch && method === 'PUT') return this.handlePutProvider(req, res, providerMatch[1]);

      // v2.1 — search across all session messages
      if (path === '/v1/search' && method === 'GET') return handleSearch(req, res, url);

      // v2.1 — scheduled tasks (CRUD on ~/.deqi/schedule.json)
      if (path === '/v1/schedule' && method === 'GET') return handleListSchedule(req, res);
      if (path === '/v1/schedule' && method === 'POST') return handleCreateSchedule(req, res);
      // Match /v1/schedule/<id> (PATCH/DELETE) or /v1/schedule/<id>/run (POST).
      // Use non-capturing group for the optional /run suffix so `id` and
      // the action are clean (action is 'run' | undefined, not '/run').
      const schedMatch = path.match(/^\/v1\/schedule\/([A-Za-z0-9_]+)(?:\/(run))?$/);
      if (schedMatch) {
        const id = schedMatch[1];
        const isRun = !!schedMatch[2];
        if (!isRun && method === 'PATCH') return handleUpdateSchedule(req, res, id);
        if (!isRun && method === 'DELETE') return handleDeleteSchedule(req, res, id);
        if (isRun && method === 'POST') {
          return handleRunScheduleNow(req, res, id, (item) => this.runScheduledItem(item));
        }
      }

      // v2.1 — file tree (for @-mention)
      if (path === '/v1/files' && method === 'GET') return handleListFiles(req, res, url);

      // v5.1 — in-app feedback channel (desktop "send feedback" button)
      if (path === '/v1/feedback' && method === 'POST') return handleCreateFeedback(req, res);
      if (path === '/v1/feedback' && method === 'GET') return handleListFeedback(req, res, url);

      // v2.1 — mobile pairing (Phase 2 stub)
      if (path === '/v1/pair' && method === 'GET') return handleListPairs(req, res);
      if (path === '/v1/pair' && method === 'POST') return handleCreatePair(req, res);
      const pairMatch = path.match(/^\/v1\/pair\/([A-Za-z0-9_]+)$/);
      if (pairMatch && method === 'DELETE') return handleDeletePair(req, res, pairMatch[1]);

      // v2.2 — plugin discovery (manifest scan, no dynamic import yet)
      if (path === '/v1/plugins' && method === 'GET') return this.handleListPlugins(res);
      // v4.6 — manual plugin reload
      if (path === '/v1/plugins/reload' && method === 'POST') {
        void this.refreshPlugins().then(
          () => this.json(res, { ok: true }),
          (e) => this.json(res, { error: 'reload_failed', message: String((e as Error).message) }, 500),
        );
        return;
      }

      // v4.7 — telemetry opt-in + aggregate
      if (path === '/v1/telemetry/opt-in' && method === 'POST') return this.handleTelemetryOptIn(req, res);
      if (path === '/v1/telemetry/aggregate' && method === 'GET') return this.handleTelemetryAggregate(res);
      if (path === '/v1/telemetry/status' && method === 'GET') return this.handleTelemetryStatus(res);

      // v4.4 — per-session permission grants
      if (path === '/v1/permission/grants' && method === 'GET') return this.handleListGrants(res);
      if (path === '/v1/permission/grants' && method === 'POST') return this.handleAddGrant(req, res, url);
      const grantDelMatch = path.match(/^\/v1\/permission\/grants\/([A-Za-z0-9_-]+)$/);
      if (grantDelMatch && method === 'DELETE') return this.handleRemoveGrant(res, grantDelMatch[1]);

      // v3.1 — long-running project state (initializer vs coding dispatch)
      if (path === '/v1/project/state' && method === 'GET') return this.handleGetProjectState(req, res, url);

      // v4.8 — multi-desktop cluster registry
      if (path === '/v1/cluster' && method === 'GET') return this.handleListCluster(res, url);
      if (path === '/v1/cluster/who-runs' && method === 'GET') return this.handleWhoRunsSession(res, url);
      // v4.8 — cross-desktop RPC: another Deqi server asks us
      // to run a task. We return the result synchronously.
      if (path === '/v1/rpc/run-task' && method === 'POST') return this.handleRpcRunTask(req, res);

      // v3.9 — plugin routes. Matched AFTER all built-in /v1/*
      // routes so a plugin can't shadow a core API. v3.9.1+ adds
      // express-style params (e.g. `/v1/plugin/foo/:id`).
      for (const route of this.pluginRoutes) {
        if (route.method !== method) continue;
        const params = matchPluginRoute(route.path, path);
        if (params === null) continue;
        try {
          const body = await readBody(req);
          const out = await route.handler({
            method, path, query: Object.fromEntries(url.searchParams),
            params, headers: req.headers, body,
          });
          this.json(res, out ?? { ok: true });
        } catch (e) {
          this.json(res, { error: 'plugin_error', message: String((e as Error).message ?? e) }, 500);
        }
        return;
      }

      this.json(res, { error: 'not_found', path }, 404);
    } catch (err) {
      this.json(res, { error: 'internal', message: String((err as Error).message ?? err) }, 500);
    }
  }

  private async handleListSessions(_req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const cwd = url.searchParams.get('cwd') ?? process.cwd();
    const existing = await SessionManager.list(cwd);
    const sessions: SessionSummary[] = existing.map((s, i) => ({
      id: s.id,
      cwd: s.header.cwd,
      model: s.header.model,
      provider: s.header.provider,
      created_at: s.header.createdAt,
      updated_at: s.header.createdAt, // TODO: track last activity
      message_count: 0, // TODO: count from disk
      is_latest: i === 0,
    }));
    this.json(res, { sessions });
  }

  private async handleCreateSession(_req: IncomingMessage, res: ServerResponse, _url: URL): Promise<void> {
    const cfg = loadConfig();
    const model = cfg?.defaultModel ?? 'MiniMax-M3';
    const cwd = process.cwd();
    const session = await SessionManager.create(cwd, model, 'openai-compat');
    this.json(res, {
      session: {
        id: session.sessionId,
        cwd: session.filePath,
        model,
        provider: 'openai-compat',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        message_count: 0,
        is_latest: true,
        messages: [],
      } satisfies SessionDetails,
    });
  }

  private async handleGetSession(id: string, res: ServerResponse): Promise<void> {
    try {
      const cwd = process.cwd();
      const all = await SessionManager.list(cwd);
      const match = all.find((s) => s.id === id);
      if (!match) {
        this.json(res, { error: 'not_found' }, 404);
        return;
      }
      this.json(res, {
        session: {
          id: match.id,
          cwd: match.header.cwd,
          model: match.header.model,
          provider: match.header.provider,
          created_at: match.header.createdAt,
          updated_at: match.header.createdAt,
          message_count: 0,
          is_latest: false,
          messages: [],
        } satisfies SessionDetails,
      });
    } catch (err) {
      this.json(res, { error: 'not_found', message: String((err as Error).message) }, 404);
    }
  }

  private async handleDeleteSession(id: string, res: ServerResponse): Promise<void> {
    // For now, just unload the runner. The JSONL stays on disk
    // so the user can recover by re-importing. (TODO: archive
    // the file instead of deleting — goose-style "recycle bin".)
    this.runners.delete(id);
    this.json(res, { ok: true, id });
  }

  private async handleGetSessionMessages(id: string, res: ServerResponse): Promise<void> {
    const cwd = process.cwd();
    try {
      const all = await SessionManager.list(cwd);
      const match = all.find((s) => s.id === id);
      if (!match) {
        this.json(res, { error: 'not_found' }, 404);
        return;
      }
      const session = await SessionManager.load(match.filePath);
      const messages = session.getEntries()
        .filter((e) => e.type === 'message')
        .map((e) => {
          const m = e as { id: string; role: string; content: unknown; ts: string };
          return { id: m.id, role: m.role, content: m.content, ts: m.ts };
        });
      this.json(res, { messages });
    } catch (err) {
      this.json(res, { error: 'not_found', message: String((err as Error).message) }, 404);
    }
  }

  private async handleResumeSession(id: string, res: ServerResponse): Promise<void> {
    // Resume = make sure a runner exists for this session id.
    // The runner is created lazily on first user_message, but
    // the desktop UI may want to attach before sending a prompt.
    const runner = await this.getOrCreateRunner(id);
    this.json(res, { ok: true, id, busy: runner.isBusy() });
  }

  private handleListModels(res: ServerResponse): void {
    const models: ModelInfo[] = this.registry.listModels().map((m) => ({
      id: m.id,
      provider: m.provider,
      context_window: m.contextWindow,
      max_output_tokens: m.maxOutputTokens,
      cost: { input: 0, output: 0 }, // placeholder; real cost from provider metadata
    }));
    this.json(res, { models });
  }

  private handleListTools(res: ServerResponse): void {
    const tools: ToolInfo[] = BUILTIN_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      concurrency_safe: t.isConcurrencySafe ? t.isConcurrencySafe({}) : false,
    }));
    // v2.3: append plugin tools so the desktop's Tools panel
    // (and the system prompt enumeration) sees them.
    for (const pt of this.pluginTools) {
      tools.push({
        name: pt.name,
        description: pt.description,
        input_schema: pt.input_schema as ToolInfo['input_schema'],
        concurrency_safe: false,
      });
    }
    this.json(res, { tools });
  }

  private handleGetConfig(res: ServerResponse): void {
    const cfg = loadConfig();
    // Redact provider keys: only show the last 4 chars, never the full key.
    const providers: ServerConfig['providers'] = {};
    if (cfg?.providers) {
      for (const [name, p] of Object.entries(cfg.providers)) {
        if (!p) continue;
        const apiKey = 'apiKey' in p ? p.apiKey : undefined;
        const baseUrl = 'baseUrl' in p ? p.baseUrl : undefined;
        providers[name] = {
          has_key: Boolean(apiKey),
          key_tail: apiKey ? `...${apiKey.slice(-4)}` : null,
          base_url: baseUrl,
        };
      }
    }
    const behavior = resolveBehavior();
    this.json(res, {
      default_model: cfg?.defaultModel ?? 'MiniMax-M3',
      providers,
      permission_mode: behavior.permissionMode,
      show_surprise: behavior.showSurprise,
      enable_reflection: behavior.enableReflection,
    } satisfies ServerConfig);
  }

  /**
   * v2.2: PATCH /v1/config — persist behavior + default model.
   * All fields are optional; only the ones present in the body
   * are written. Provider credentials are NOT accepted here
   * (use PUT /v1/config/providers/:name) to keep this endpoint
   * idempotent and easy to reason about.
   */
  private async handlePatchConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson<Partial<ServerConfig>>(req);
    if (body.default_model) {
      setDefaultModel(body.default_model);
    }
    const behavior: {
      permissionMode?: PermissionMode;
      showSurprise?: boolean;
      enableReflection?: boolean;
    } = {};
    if (body.permission_mode) behavior.permissionMode = body.permission_mode;
    if (typeof body.show_surprise === 'boolean') behavior.showSurprise = body.show_surprise;
    if (typeof body.enable_reflection === 'boolean') behavior.enableReflection = body.enable_reflection;
    if (Object.keys(behavior).length > 0) {
      setBehavior(behavior);
    }
    this.json(res, { ok: true, config: this.handleGetConfigBody() });
  }

  /**
   * v2.2: PUT /v1/config/providers/:name — add or update one
   * provider's credentials. Rebinds the model registry so the
   * new key takes effect on the next /v1/models call and the
   * next turn.
   */
  private async handlePutProvider(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const allowed = ['anthropic', 'openai', 'google', 'openai-compat'];
    if (!allowed.includes(name)) {
      this.json(res, { error: 'bad_provider', message: `unknown provider: ${name}` }, 400);
      return;
    }
    const body = await this.readJson<{ apiKey?: string; baseUrl?: string; path?: string }>(req);
    if (!body.apiKey && !body.baseUrl && !body.path) {
      this.json(res, { error: 'empty_patch', message: 'provide at least one of apiKey/baseUrl/path' }, 400);
      return;
    }
    setProvider(name as 'anthropic' | 'openai' | 'google' | 'openai-compat', body);
    this.rebuildRegistry();
    this.json(res, { ok: true, config: this.handleGetConfigBody() });
  }

  /** Internal helper: same body as GET /v1/config but as a plain object. */
  private handleGetConfigBody(): ServerConfig {
    const cfg = loadConfig();
    const providers: ServerConfig['providers'] = {};
    if (cfg?.providers) {
      for (const [n, p] of Object.entries(cfg.providers)) {
        if (!p) continue;
        const apiKey = 'apiKey' in p ? p.apiKey : undefined;
        const baseUrl = 'baseUrl' in p ? p.baseUrl : undefined;
        providers[n] = {
          has_key: Boolean(apiKey),
          key_tail: apiKey ? `...${apiKey.slice(-4)}` : null,
          base_url: baseUrl,
        };
      }
    }
    const behavior = resolveBehavior();
    return {
      default_model: cfg?.defaultModel ?? 'MiniMax-M3',
      providers,
      permission_mode: behavior.permissionMode,
      show_surprise: behavior.showSurprise,
      enable_reflection: behavior.enableReflection,
    };
  }

  /**
   * v2.2: list discovered plugins. Reads manifests from
   * ~/.deqi/plugins/* synchronously (no dynamic import) and
   * returns metadata for each. The full plugin runtime
   * (sandboxed import, tool registration) lands in v2.3
   * behind Deqi_ENABLE_PLUGINS=1.
   */
  private handleListPlugins(res: ServerResponse): void {
    // v2.3: merge the on-disk discovery (always runs) with the
    // load results (only populated when Deqi_ENABLE_PLUGINS=1
    // was set at startup). The UI can show "discovered but not
    // loaded" vs "loaded successfully" vs "loaded with error".
    const discovered = listPlugins();
    const byId = new Map(this.pluginLoadResults.map((r) => [r.id, r]));
    const merged = discovered.map((d) => {
      const loaded = byId.get(d.id);
      return {
        ...d,
        loaded: !!loaded && !loaded.error,
        loadError: loaded?.error,
        tools: loaded?.tools?.map((t) => t.name) ?? d.tools,
        routes: loaded?.routes ?? [],
        events: loaded?.events ?? [],
      };
    });
    this.json(res, { plugins: merged, pluginsEnabled: process.env.Deqi_ENABLE_PLUGINS === '1' });
  }

  /**
   * v3.1: GET /v1/project/state — returns the current project's
   * phase + features + progress log. The desktop uses this to
   * render the "phase badge" (initializer / coding / complete)
   * and the next-feature card.
   */
  private handleGetProjectState(_req: IncomingMessage, res: ServerResponse, url: URL): void {
    const cwd = url.searchParams.get('cwd') ?? process.cwd();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { loadProject, derivePhase, readProgress } = require('@deqi/coding-agent') as typeof import('@deqi/coding-agent');
    const state = loadProject(cwd);
    if (!state) {
      this.json(res, { project: null, phase: 'uninitialized' as const, progress: '' });
      return;
    }
    const phase = derivePhase(cwd);
    this.json(res, { project: state, phase, progress: readProgress(cwd) });
  }

  // ─── v4.8: multi-desktop cluster handlers ─────────────────

  /**
   * v4.8: list live desktops in the cluster. Supports a `?all=1`
   * flag to include stale (crashed) entries — useful for the
   * desktop UI's "show ghost desktops" debug view. The default
   * filters to entries with a fresh `last_heartbeat` (≤ 15s ago).
   */
  private handleListCluster(res: ServerResponse, url: URL): void {
    const includeStale = url.searchParams.get('all') === '1';
    const desktops = includeStale ? this.cluster.listAll() : this.cluster.list();
    const local = this.cluster.local();
    this.json(res, {
      desktops,
      local_desktop_id: local?.desktop_id ?? null,
      local_desktop_name: local?.name ?? null,
      stale_after_ms: 15_000,
    });
  }

  /**
   * v4.8: look up which desktop owns a given session. We walk
   * the local `~/.deqi/sessions/` dir; sessions created on this
   * desktop are reported as `this desktop`, sessions we don't
   * know about return `null` (we can't see other desktops'
   * session files from here without scanning the cluster).
   *
   * In v4.8 the answer is binary — a session is "ours" or
   * "remote, unknown". v4.9+ can index session→desktop_id
   * centrally for full lookup.
   */
  private async handleWhoRunsSession(res: ServerResponse, url: URL): Promise<void> {
    const sessionId = url.searchParams.get('session_id') ?? '';
    if (!sessionId) {
      this.json(res, { error: 'missing session_id' }, 400);
      return;
    }
    const cwd = url.searchParams.get('cwd') ?? process.cwd();
    try {
      const all = await SessionManager.list(cwd);
      const found = all.find((s) => s.id === sessionId);
      const local = this.cluster.local();
      this.json(res, {
        session_id: sessionId,
        desktop_id: found && local ? local.desktop_id : null,
        desktop_name: found && local ? local.name : null,
        known_locally: !!found,
      });
    } catch (err) {
      this.json(res, { error: 'lookup_failed', message: (err as Error).message }, 500);
    }
  }

  /**
   * v4.8: cross-desktop RPC. A peer Deqi server POSTs here to
   * run a single prompt and get the result back. We create a
   * transient session (so the JSONL trail exists), spin up a
   * runner, run one turn, and return the final assistant text.
   *
   * Body:
   *   { task_id, prompt, model?, allowTools?, parent_session_id? }
   *
   * Response:
   *   { task_id, ok, text, durationMs, session_id }
   *
   * The remote caller (`delegate_remote`) is responsible for
   * surfacing events to the user; we just produce the answer.
   */
  private async handleRpcRunTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const body = (await readBody(req).catch(() => null)) as {
      task_id?: string;
      prompt?: string;
      model?: string;
      allowTools?: string[];
      parent_session_id?: string;
    } | null;
    if (!body || !body.prompt) {
      this.json(res, { error: 'missing_field', need: ['prompt'] }, 400);
      return;
    }
    const taskId = body.task_id ?? 'rpc_' + Date.now().toString(36);
    try {
      const cfg = loadConfig();
      const model = body.model ?? cfg?.defaultModel ?? 'MiniMax-M3';
      const cwd = process.cwd();
      const session = await SessionManager.create(cwd, model, 'openai-compat');
      const runner = new AgentRunner(this.registry, session.sessionId, cwd, {
        cwd,
        model_id: model,
        permission_mode: 'smart',
        show_surprise: false,
        enable_reflection: false,
        // v4.8: cluster client. The RPC runner is the canonical
        // case for cross-desktop routing — the local user asked
        // us to run a task on their behalf, so we should be able
        // to pick a peer desktop.
        cluster: {
          list: () => this.cluster.list(),
          pick: (t) => {
            const d = this.cluster.pick(t);
            return d ? { desktop_id: d.desktop_id, host: d.host, port: d.port } : null;
          },
          local: () => {
            const d = this.cluster.local();
            return d ? { desktop_id: d.desktop_id, name: d.name, host: d.host, port: d.port } : null;
          },
        },
      });
      await runner.init();
      this.runners.set(session.sessionId, runner);
      // The runner's runTurn drains the event stream; we don't
      // forward events to anyone in the RPC path. The remote
      // desktop sees only the final text.
      let finalText = '';
      const onEvent = (event: SessionEvent): void => {
        // Capture assistant text deltas as they stream so the
        // RPC reply is a faithful copy of what the model
        // emitted. We don't reconstruct from message blocks —
        // deltas are already in the right order.
        if (event.type === 'text_delta') {
          finalText += event.delta;
        }
      };
      await runner.runTurn(body.prompt, onEvent);
      await runner.waitForCurrentTurn();
      this.runners.delete(session.sessionId);
      this.json(res, {
        task_id: taskId,
        ok: true,
        text: finalText || '(no assistant text emitted)',
        durationMs: Date.now() - start,
        session_id: session.sessionId,
      });
    } catch (err) {
      this.json(res, {
        task_id: taskId,
        ok: false,
        text: '',
        durationMs: Date.now() - start,
        error: (err as Error).message,
      });
    }
  }

  // ─── WebSocket ───────────────────────────────────────────────

  private handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, _head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    // v4.1: paired phones connect to /v1/push?pair_id=... to
    // receive a phone-safe subset of session events.
    if (url.pathname === '/v1/push') {
      this.handlePushUpgrade(req, socket, url);
      return;
    }
    if (url.pathname !== '/v1/chat') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // Use the `ws` package or hand-rolled WebSocket upgrade.
    // We hand-roll it because deqi doesn't depend on `ws` yet
    // and the upgrade is only ~50 lines of code.
    if (!this.performWebSocketHandshake(req, socket)) return;
    const ws = new WsClient(socket, this);
    this.wsClients.add(ws);
    ws.send({ type: 'hello_ack', protocol: PROTOCOL_VERSION, server_version: SERVER_VERSION });
  }

  /** v4.1: paired-phone WebSocket upgrade. Validates the pair_id
   *  query param, then adds the socket to pushClients. The phone
   *  is now a live subscriber; when the user un-pairs or the
   *  socket drops, we clean up.
   *
   *  v4.8: optional `?desktop_id=...` lets the phone target a
   *  specific desktop in the cluster. If the desktop_id doesn't
   *  match this server, the upgrade is rejected with 404 so the
   *  phone falls back to its other known machines. */
  private async handlePushUpgrade(
    req: IncomingMessage,
    socket: import('node:stream').Duplex,
    url: URL,
  ): Promise<void> {
    const pairId = url.searchParams.get('pair_id') ?? '';
    const deviceName = url.searchParams.get('device_name') ?? 'phone';
    const targetDesktopId = url.searchParams.get('desktop_id') ?? '';
    if (!pairId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    // v4.8: if the phone asks for a specific desktop, make sure
    // the id matches us. Otherwise the phone is talking to the
    // wrong machine and should try the next one in its list.
    if (targetDesktopId) {
      const local = this.cluster.local();
      if (!local || local.desktop_id !== targetDesktopId) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    // Validate the pair exists. The pair file is at
    // ~/.deqi/pairs.json. We use the same readPairs helper.
    const { readPairs } = await import('./v2endpoints.js');
    const pairs = await readPairs();
    const pair = pairs.find((p: { id: string }) => p.id === pairId);
    if (!pair) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!this.performWebSocketHandshake(req, socket)) return;
    const client = new PushClient(socket, this, pairId, deviceName);
    this.pushClients.add(client);
    client.send({ type: 'hello_ack', protocol: PROTOCOL_VERSION, server_version: SERVER_VERSION });
    client.send({ type: 'pair_ack', pair_id: pairId, device_name: deviceName });
  }

  /** Validate the Sec-WebSocket-Key handshake and complete it.
   *  This is RFC 6455 §1.3 in 30 lines. */
  private performWebSocketHandshake(req: IncomingMessage, socket: import('node:stream').Duplex): boolean {
    const key = req.headers['sec-websocket-key'];
    if (!key || Array.isArray(key)) return false;
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
    );
    return true;
  }

  // ─── Runner registry ──────────────────────────────────────────

  /**
   * v3.9: build a single Map<eventName, handlers[]> from every
   * loaded plugin's event subscriptions. One map shared across
   * all sessions — handlers are stateless, so a session-bound
   * map would only add garbage. Lookups are O(1).
   */
  private buildPluginEventMap(): Map<string, Array<(ev: unknown) => void>> {
    const m = new Map<string, Array<(ev: unknown) => void>>();
    for (const r of this.pluginLoadResults) {
      if (r.error) continue;
      for (const entry of r.eventHandlers ?? []) {
        const list = m.get(entry.event) ?? [];
        for (const h of entry.handlers) list.push(h);
        m.set(entry.event, list);
      }
    }
    return m;
  }

  /** Get or lazily create a runner for the given session id. */
  private async getOrCreateRunner(sessionId: string): Promise<AgentRunner> {
    let runner = this.runners.get(sessionId);
    if (!runner) {
      const cfg = loadConfig();
      const modelId = cfg?.defaultModel ?? 'MiniMax-M3';
      const cwd = process.cwd();
      runner = new AgentRunner(this.registry, sessionId, cwd, {
        cwd,
        model_id: modelId,
        permission_mode: 'smart',
        show_surprise: true,
        enable_reflection: true,
        // v4.8: same cluster client; needed for delegate_remote
        // to work in interactive chat sessions.
        cluster: {
          list: () => this.cluster.list(),
          pick: (t) => {
            const d = this.cluster.pick(t);
            return d ? { desktop_id: d.desktop_id, host: d.host, port: d.port } : null;
          },
          local: () => {
            const d = this.cluster.local();
            return d ? { desktop_id: d.desktop_id, name: d.name, host: d.host, port: d.port } : null;
          },
        },
        // v2.3: any plugins that registered tools become part of
        // the LLM's vocabulary alongside BUILTIN_TOOLS.
        extra_tools: this.pluginTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.input_schema,
          execute: t.execute,
        })),
        // v3.9: per-event-type plugin handlers. Each plugin's
        // `on(event, handler)` registrations get routed here.
        plugin_event_handlers: this.buildPluginEventMap(),
      });
      await runner.init();
      this.runners.set(sessionId, runner);
    }
    return runner;
  }

  // ─── Schedule: real run-now + periodic scheduler ──────────────

  /**
   * v2.2: actually execute a schedule item. Creates a new
   * session for the run, runs the prompt as a single turn,
   * broadcasts every session_event to all connected WS clients
   * (so the desktop's chat view renders the run in real time),
   * and returns a result for the caller to persist.
   */
  async runScheduledItem(item: ScheduleItem): Promise<{ ok: boolean; note: string }> {
    try {
      const cfg = loadConfig();
      const model = cfg?.defaultModel ?? 'MiniMax-M3';
      const cwd = process.cwd();
      const session = await SessionManager.create(cwd, model, 'openai-compat');
      const runner = new AgentRunner(this.registry, session.sessionId, cwd, {
        cwd,
        model_id: model,
        permission_mode: 'smart',
        show_surprise: false,
        enable_reflection: false,
        // v4.8: cluster client (scheduled runs share the
        // same surface as RPC + interactive sessions).
        cluster: {
          list: () => this.cluster.list(),
          pick: (t) => {
            const d = this.cluster.pick(t);
            return d ? { desktop_id: d.desktop_id, host: d.host, port: d.port } : null;
          },
          local: () => {
            const d = this.cluster.local();
            return d ? { desktop_id: d.desktop_id, name: d.name, host: d.host, port: d.port } : null;
          },
        },
      });
      await runner.init();
      this.runners.set(session.sessionId, runner);
      // v3.1: prepend a phase directive (initializer vs coding) so the
      // agent knows which role to play this session. The user's
      // item.prompt becomes the goal of the session.
      const directive = this.pickPhaseDirective(cwd);
      const composedPrompt = `${directive}\n\nGOAL (from the user):\n${item.prompt}`;
      await runner.runTurn(composedPrompt, (event) => {
        this.broadcastSessionEvent(session.sessionId, event);
      });
      await runner.waitForCurrentTurn();
      return { ok: true, note: `session=${session.sessionId.slice(0, 12)}` };
    } catch (err) {
      return { ok: false, note: (err as Error).message };
    }
  }

  /** Send a session_event to every connected WS client. */
  private broadcastSessionEvent(sessionId: string, event: SessionEvent): void {
    for (const ws of this.wsClients) {
      try {
        ws.send({ type: 'session_event', session_id: sessionId, event });
      } catch { /* ignore individual client send errors */ }
    }
    // v4.1: also forward to paired phones. We filter to a phone-
    // safe subset (skip raw tool I/O, keep text + agent state).
    for (const pc of this.pushClients) {
      if (!isPhoneVisibleEvent(event)) continue;
      try {
        pc.send({ type: 'session_event', session_id: sessionId, event });
      } catch { /* ignore */ }
    }
  }

  /** v4.1: list currently-connected phones (for the desktop UI). */
  listPushSubscribers(): Array<{ pairId: string; deviceName: string; connectedAt: string }> {
    return Array.from(this.pushClients).map((c) => ({
      pairId: c.pairId,
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
    }));
  }

  // ─── v3.1: Initializer vs Coding agent dispatch ──────────────
  /**
   * Decide which agent prompt to use based on the project's phase.
   *
   *   - uninitialized  → initializer (build init.sh + progress.md + first commit)
   *   - active         → coding agent (pick next feature, make it pass)
   *   - complete       → no-op ("everything's done")
   *
   * Returns a system-prompt prefix to prepend to the user's text.
   * The actual implementation uses the standard `buildSystemPrompt`
   * from coding-agent; this method just appends a per-phase directive.
   */
  pickPhaseDirective(cwd: string): string {
    // Lazy require to avoid a circular dep at module load
    let phase: 'uninitialized' | 'active' | 'complete' = 'uninitialized';
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { derivePhase } = require('@deqi/coding-agent') as typeof import('@deqi/coding-agent');
      phase = derivePhase(cwd);
    } catch {
      phase = 'uninitialized';
    }
    if (phase === 'complete') {
      return [
        'PHASE: complete',
        'All features for this project are passing. Respond briefly explaining that and ask the user what they want next.',
      ].join('\n');
    }
    if (phase === 'uninitialized') {
      return [
        'PHASE: initializer (first run for this project).',
        'Before doing anything else:',
        '  1. Read the project root and list the top-level files (use `bash ls`).',
        '  2. Write a `init.sh` to the project state dir that idempotently sets up the dev environment (install deps, start a dev server, etc.).',
        '  3. Write a `progress.md` (use the `appendProgress` API or the `plan` tool).',
        '  4. Use the `plan` tool with action=propose to decompose the user goal into a step list.',
        '  5. Use the `bash` tool to run init.sh and confirm it succeeds end-to-end.',
        'Do NOT try to implement features in this first session. Set up the harness.',
      ].join('\n');
    }
    // active
    return [
      'PHASE: coding (returning session for an active project).',
      'Steps to do at the start of every session:',
      '  1. Run `pwd` to confirm cwd.',
      '  2. Read `progress.md` and the project state to see what was last done.',
      '  3. Run the `init.sh` from the project state to confirm the dev environment is still working.',
      '  4. Pick the next feature whose `passes: false` (use the state module).',
      '  5. Implement that one feature ONLY. Do not start others.',
      '  6. End-to-end test it (curl, browser, or run the actual binary).',
      '  7. Append to `progress.md` and mark the feature `passes: true`.',
      '  8. Commit (if a git repo).',
      'Do NOT batch multiple features. Do NOT remove or edit existing tests.',
    ].join('\n');
  }

  /**
   * v2.2: simple in-process scheduler. Every 30 seconds, walk
   * the schedule, fire any item whose lastRunAt is older than
   * its cadence. Lightweight: no external cron, no job queue.
   * On server restart the schedule resumes from disk — no
   * state lives in memory beyond the timer handle.
   */
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerRunning = false;

  private startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => this.tickScheduler(), 30_000);
    // Run an initial tick ~3s after start so the user doesn't
    // have to wait a full interval on launch.
    setTimeout(() => this.tickScheduler(), 3_000);
  }

  private stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /** Read the schedule from disk and fire any due item. */
  private async tickScheduler(): Promise<void> {
    if (this.schedulerRunning) return; // single-flight
    this.schedulerRunning = true;
    try {
      const items = await readScheduleFile();
      const now = Date.now();
      for (const item of items) {
        if (!item.enabled) continue;
        const due = isItemDue(item, now);
        if (!due) continue;
        // Fire and forget — runScheduledItem updates the file
        // itself with lastRunAt on completion.
        void this.runScheduledItem(item).then(async (result) => {
          await patchScheduleItem(item.id, (i) => {
            i.lastRunAt = new Date().toISOString();
            i.lastRunStatus = result.ok ? 'ok' : 'error';
            i.lastRunNote = result.note;
          });
        }).catch(() => { /* already logged in runScheduledItem */ });
      }
    } catch (err) {
      console.error('[Deqi-server] scheduler tick failed:', err);
    } finally {
      this.schedulerRunning = false;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private json(res: ServerResponse, body: unknown, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private readJson<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? (JSON.parse(text) as T) : ({} as T));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }
}

// ─── Minimal WebSocket client wrapper ───────────────────────────

/**
 * A single connected client. The server multiplexes sessions
 * over one socket — every `session_event` carries a `session_id`
 * so the client can route to the right UI panel.
 *
 * Implemented from RFC 6455 (client→server frames only; the
 * server is half-duplex from the client's POV). Sufficient for
 * the desktop app's needs (~10 messages per turn).
 */
class WsClient {
  private buffer: Buffer = Buffer.alloc(0);
  closed = false;

  constructor(
    private socket: import('node:stream').Duplex,
    private server: DeqiServer,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', () => this.onClose());
  }

  send(msg: WsServerMessage): void {
    if (this.closed) return;
    this.socket.write(encodeFrame(JSON.stringify(msg)));
  }

  close(): void {
    this.closed = true;
    try { this.socket.end(); } catch { /* ignore */ }
  }

  private onClose(): void {
    this.closed = true;
    this.server['wsClients'].delete(this);
  }

  private async onData(chunk: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = decodeFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frame.totalLength);
      try {
        const msg = JSON.parse(frame.payload.toString('utf8')) as WsClientMessage;
        await this.handleMessage(msg);
      } catch (err) {
        this.send({ type: 'error', message: `bad frame: ${(err as Error).message}` });
      }
    }
  }

  private async handleMessage(msg: WsClientMessage): Promise<void> {
    if (msg.type === 'hello') {
      // Already acked on connect; this is just a re-hello.
      this.send({ type: 'hello_ack', protocol: PROTOCOL_VERSION, server_version: SERVER_VERSION });
      return;
    }
    if (msg.type === 'user_message') {
      console.log(`[Deqi-server] user_message on session ${msg.session_id}${msg.model ? ` (model=${msg.model})` : ''}: ${msg.text.slice(0, 80)}`);
      try {
        const runner = await this.server['getOrCreateRunner'](msg.session_id);
        await runner.runTurn(msg.text, (event) => {
          this.send({ type: 'session_event', session_id: msg.session_id, event });
        }, msg.model);
        // Wait for the turn to actually finish before returning
        // so a single user_message maps 1:1 to a complete turn.
        await runner.waitForCurrentTurn();
        console.log(`[Deqi-server] turn complete on session ${msg.session_id}`);
      } catch (err) {
        console.error(`[Deqi-server] turn error:`, err);
        this.send({ type: 'session_event', session_id: msg.session_id, event: { type: 'info', kind: 'error', text: String((err as Error).message) } });
      }
      return;
    }
    if (msg.type === 'permission_response') {
      // Look up which runner owns this request_id. The runner
      // pushed it into its queue; we route to all runners and
      // let the matching one handle it.
      for (const runner of this.server['runners'].values()) {
        runner.resolvePermission(msg.request_id, msg.decision);
      }
      return;
    }
    if (msg.type === 'abort') {
      const runner = this.server['runners'].get(msg.session_id);
      runner?.abort();
      return;
    }
  }
}

// ─── WebSocket frame codec (RFC 6455) ───────────────────────────

function encodeFrame(payload: string): Buffer {
  const data = Buffer.from(payload, 'utf8');
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | len; // MASK bit set, but we don't mask server→client
    // Note: per RFC, server→client frames SHOULD NOT be masked.
    // Clear the mask bit.
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

interface DecodedFrame {
  payload: Buffer;
  totalLength: number;
}

function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const b1 = buf[1]!;
  const masked = (b1 & 0x80) !== 0;
  let payloadLen = b1 & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < offset + 2) return null;
    payloadLen = buf.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLen === 127) {
    if (buf.length < offset + 8) return null;
    payloadLen = Number(buf.readBigUInt64BE(offset));
    offset += 8;
  }
  if (masked) {
    if (buf.length < offset + 4) return null;
    // Read the 4-byte mask key and unmask the payload. RFC 6455
    // requires all client→server frames to be masked; without
    // unmasking the JSON parse downstream would see scrambled bytes
    // and reject the frame.
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    if (buf.length < offset + payloadLen) return null;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i += 1) {
      payload[i] = buf[offset + i]! ^ mask[i % 4]!;
    }
    return { payload, totalLength: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return { payload: buf.subarray(offset, offset + payloadLen), totalLength: offset + payloadLen };
}

// ─── Schedule helpers (used by DeqiServer.runScheduledItem / scheduler) ─

const SCHEDULE_PATH = join(homedir(), '.deqi', 'schedule.json');

/** Read the schedule file from disk. Returns [] if missing. */
async function readScheduleFile(): Promise<ScheduleItem[]> {
  if (!existsSync(SCHEDULE_PATH)) return [];
  try {
    const raw = await readFile(SCHEDULE_PATH, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ScheduleItem[]) : [];
  } catch {
    return [];
  }
}

/** Read-modify-write a single schedule item by id. */
async function patchScheduleItem(
  id: string,
  patch: (item: ScheduleItem) => void,
): Promise<void> {
  const items = await readScheduleFile();
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  patch(items[idx]!);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(homedir(), '.deqi'), { recursive: true });
  writeFileSync(SCHEDULE_PATH, JSON.stringify(items, null, 2), 'utf-8');
}

/**
 * Is this item due to run? Returns true if it has never run
 * (lastRunAt undefined) or if (now - lastRunAt) >= cadence.
 * Cadence strings map to milliseconds.
 */
function isItemDue(item: ScheduleItem, now: number): boolean {
  if (!item.lastRunAt) return true;
  const elapsed = now - new Date(item.lastRunAt).getTime();
  return elapsed >= cadenceMs(item.cadence);
}

function cadenceMs(cadence: string): number {
  switch (cadence) {
    case '5m': return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '30m': return 30 * 60_000;
    case '1h': return 60 * 60_000;
    case '6h': return 6 * 60 * 60_000;
    case 'daily': return 24 * 60 * 60_000;
    case 'weekly': return 7 * 24 * 60 * 60_000;
    default: return 60 * 60_000; // safe default: hourly
  }
}

// ─── v4.1: paired phone push client ────────────────────────────

/**
 * v4.1: filter that decides which session events a phone sees.
 * Phones are a quick-glance UI; we suppress raw tool I/O and
 * noise (message_update internals, tool_execution_* with raw
 * input/output). We keep:
 *   - agent_start, agent_end, turn_start, turn_end
 *   - text_delta, thinking_delta (the actual conversation)
 *   - tool_start, tool_end (names only — no args/results)
 *   - info messages (errors, warnings)
 * The phone is a viewer, not a debugger. Detailed tool I/O
 * stays in the desktop's "raw" panel.
 */
function isPhoneVisibleEvent(ev: SessionEvent): boolean {
  switch (ev.type) {
    case 'agent_start':
    case 'agent_end':
    case 'turn_start':
    case 'turn_end':
    case 'text_delta':
    case 'thinking_delta':
    case 'info':
    case 'subagent_event':  // v3.9.1: also forward (phone can show "agent thinking…")
      return true;
    case 'tool_start':
    case 'tool_end':
      // Surface the tool name, but suppress the body in the
      // send-side. The phone renders "{tool_name} ran" only.
      return true;
    default:
      return false;
  }
}

/**
 * v4.1: paired phone WebSocket client. Lighter than the desktop
 * WsClient — phones don't need to drive turns, they just read.
 * The phone can send `user_message` (same wire format as the
 * desktop) and the server treats it as if the desktop had sent
 * it — the desktop sees the message stream in lockstep.
 */
class PushClient {
  private buffer: Buffer = Buffer.alloc(0);
  closed = false;
  readonly connectedAt: string;
  pingInterval: NodeJS.Timeout | null = null;

  constructor(
    private socket: import('node:stream').Duplex,
    private server: DeqiServer,
    readonly pairId: string,
    readonly deviceName: string,
  ) {
    this.connectedAt = new Date().toISOString();
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('close', () => this.onClose());
    this.socket.on('error', () => this.onClose());
    // v4.1: 30s heartbeat so the phone sees a fresh connection
    // (and a stale phone gets detected within 2 missed pings).
    this.pingInterval = setInterval(() => {
      if (this.closed) return;
      try { this.send({ type: 'ping' }); } catch { /* ignore */ }
    }, 30_000);
    console.log(`[Deqi-server] phone paired: ${this.deviceName} (pair=${this.pairId})`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    try { this.socket.end(); } catch { /* ignore */ }
  }

  send(msg: unknown): void {
    if (this.closed) return;
    try {
      const json = JSON.stringify(msg);
      this.socket.write(encodeFrame(json));
    } catch { /* ignore send errors; onClose will fire */ }
  }

  private onClose(): void {
    this.closed = true;
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    this.server['pushClients'].delete(this);
    console.log(`[Deqi-server] phone disconnected: ${this.deviceName}`);
  }

  private async onData(chunk: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const frame = decodeFrame(this.buffer);
      if (!frame) break;
      this.buffer = this.buffer.subarray(frame.totalLength);
      try {
        const msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
        // The phone may send user_message just like the desktop.
        // Forward it to the desktop's chat by routing through the
        // server's first wsClient (or fail with an error).
        if (msg['type'] === 'pong') continue; // heartbeat reply
        if (msg['type'] === 'user_message') {
          // Find the first connected desktop and inject the
          // message as if it came from the user. v4.1 is a one-
          // desktop / one-phone world; multi-desktop is v4.2.
          const desktop = Array.from(this.server['wsClients'])[0];
          if (desktop) {
            const sid = String(msg['session_id'] ?? '');
            const text = String(msg['text'] ?? '');
            const model = typeof msg['model'] === 'string' ? msg['model'] : undefined;
            if (sid && text) {
              desktop['handleMessage']({
                type: 'user_message',
                session_id: sid,
                text,
                model,
              } as never);
            }
          } else {
            this.send({ type: 'error', message: 'no desktop connected; user_message dropped' });
          }
        }
      } catch (err) {
        this.send({ type: 'error', message: `bad frame: ${(err as Error).message}` });
      }
    }
  }
}
