/**
 * v4.8: multi-desktop cluster registry.
 *
 * A Deqi-server is normally a single-machine affair. v4.8 lets
 * multiple servers in the same `~/.deqi/` cluster discover each
 * other through a shared JSON file, so:
 *
 *   - The mobile push endpoint can target a specific desktop
 *     (`?desktop_id=d_xxx`), so the user controls which machine
 *     receives the message instead of the network racing them.
 *   - `delegate_remote` can route a task to a specific desktop,
 *     or pick a desktop that has a particular plugin loaded
 *     (e.g. only the laptop has the `browser-v2` plugin).
 *
 * Design:
 *
 *   - File-backed (`~/.deqi/cluster.json`) — no network protocol
 *     to invent. Each desktop rewrites its own row on heartbeat
 *     (every 5s) and re-reads on every list. The file is the
 *     source of truth, the in-memory snapshot is a cache.
 *   - Liveness via heartbeat: an entry whose `last_heartbeat`
 *     is older than `STALE_MS` (default 15s) is considered dead
 *     and dropped on the next list. This means a crashed
 *     desktop vanishes from the registry within ~15s.
 *   - Atomic writes: we write to `cluster.json.tmp` and rename,
 *     so a parallel read never sees a half-written file.
 *   - Local-only: we bind to 127.0.0.1 and the registry file
 *     lives under the user's home dir. No auth. Production
 *     cross-machine usage would need TLS + auth; for v4.8
 *     we're focused on the multi-desktop-on-the-same-lan case
 *     where the user copies the cluster.json via ssh/sync.
 *
 * Why not real service discovery (mDNS, Consul, etc.)?
 *
 *   - Zero deps is the rule. mDNS needs `mdns` (1MB+ native).
 *   - mDNS only works on the same LAN. The user might have a
 *     desktop at home and a laptop on a coffee-shop wifi; the
 *     laptop syncs `~/.deqi/` over a private tunnel and the
 *     registry still works.
 *   - File-based = auditable. The user can `cat cluster.json`
 *     to see who thinks they're alive.
 *
 * Picking a desktop:
 *
 *   - `pick({ capability: "browser-v2" })` — first live entry
 *     that has the capability. (We don't do load balancing in
 *     v4.8; round-robin is a v4.9+ concern.)
 *   - `pick({ tag: "laptop" })` — first live entry with the tag.
 *   - `pick({ desktop_id: "d_xxx" })` — exact match if live,
 *     null otherwise.
 *   - `pick({})` — first live entry. (Effectively "any".)
 *
 * Concurrency:
 *
 *   - The registry is read by HTTP handlers (which run in the
 *     event loop, async) and written by a 5s setInterval. We
 *     don't lock; the worst case is a stale read for ~5s after
 *     a new desktop joins, which is fine for a control-plane
 *     feature.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getDesktopId } from './desktop-identity.js';

const Deqi_HOME = join(homedir(), '.deqi');
const REGISTRY_PATH = join(Deqi_HOME, 'cluster.json');
const REGISTRY_TMP = REGISTRY_PATH + '.tmp';

export const STALE_MS = 15_000;
export const HEARTBEAT_MS = 5_000;

export interface DesktopEntry {
  desktop_id: string;
  name: string;
  host: string;
  port: number;
  tags: string[];
  capabilities: string[];
  registered_at: string;
  last_heartbeat: string;
  /** Optional free-form metadata: e.g. OS, arch, version. */
  meta?: Record<string, string>;
}

interface ClusterFile {
  version: 1;
  desktops: DesktopEntry[];
}

export interface DesktopTarget {
  desktop_id?: string;
  capability?: string;
  tag?: string;
  /** Explicit pin; bypasses discovery. */
  exact?: boolean;
}

export class ClusterRegistry {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cached: DesktopEntry | null = null;
  private readonly registryPath: string;
  private readonly registryTmp: string;

  constructor(opts: { registryPath?: string } = {}) {
    // The test suite needs to point the registry at a temp
    // directory; production passes nothing and gets the default
    // `~/.deqi/cluster.json`. We resolve both paths up front
    // because `start()` may run on a different async tick than
    // the constructor.
    if (opts.registryPath) {
      this.registryPath = opts.registryPath;
      this.registryTmp = opts.registryPath + '.tmp';
    } else {
      this.registryPath = REGISTRY_PATH;
      this.registryTmp = REGISTRY_TMP;
    }
  }

  /**
   * Register the local desktop and start the heartbeat loop.
   * The local entry is created with `registered_at = now` and
   * `last_heartbeat = now`; subsequent heartbeats only update
   * `last_heartbeat` (and any mutable fields the caller passes
   * via `updateLocal`).
   */
  start(local: Omit<DesktopEntry, 'desktop_id' | 'registered_at' | 'last_heartbeat'>): void {
    if (this.heartbeatTimer) return;
    if (!existsSync(Deqi_HOME)) mkdirSync(Deqi_HOME, { recursive: true });
    const now = new Date().toISOString();
    this.cached = {
      ...local,
      desktop_id: getDesktopId(),
      registered_at: now,
      last_heartbeat: now,
    };
    this.writeNow();
    this.heartbeatTimer = setInterval(() => this.tick(), HEARTBEAT_MS);
    // Don't keep the event loop alive just for heartbeats.
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  /**
   * Stop the heartbeat loop and remove the local entry from the
   * registry so other desktops see us as gone immediately.
   * Idempotent.
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!this.cached) return;
    const file = this.readFile();
    file.desktops = file.desktops.filter((d) => d.desktop_id !== this.cached!.desktop_id);
    this.writeFile(file);
    this.cached = null;
  }

  /**
   * Update mutable fields of the local entry. Useful for picking
   * up newly-loaded plugin capabilities without a server restart.
   */
  updateLocal(patch: Partial<Pick<DesktopEntry, 'name' | 'tags' | 'capabilities' | 'meta'>>): void {
    if (!this.cached) return;
    this.cached = {
      ...this.cached,
      ...patch,
      // Don't let the patch overwrite the immutable fields.
      desktop_id: this.cached.desktop_id,
      registered_at: this.cached.registered_at,
      last_heartbeat: this.cached.last_heartbeat,
    };
    this.writeNow();
  }

  private tick(): void {
    if (!this.cached) return;
    this.cached.last_heartbeat = new Date().toISOString();
    this.writeNow();
  }

  private writeNow(): void {
    if (!this.cached) return;
    const file = this.readFile();
    const idx = file.desktops.findIndex((d) => d.desktop_id === this.cached!.desktop_id);
    if (idx >= 0) file.desktops[idx] = this.cached;
    else file.desktops.push(this.cached);
    this.writeFile(file);
  }

  /** Test-only: read the resolved registry path. */
  _path(): string { return this.registryPath; }

  // ─── Public read API ──────────────────────────────────────

  /** List live desktops (stale entries filtered out). */
  list(): DesktopEntry[] {
    return this.readFile().desktops.filter((d) => this.isLive(d));
  }

  /** All entries including stale ones. Mostly for /v1/cluster debug. */
  listAll(): DesktopEntry[] {
    return [...this.readFile().desktops];
  }

  findById(desktopId: string): DesktopEntry | null {
    const d = this.readFile().desktops.find((x) => x.desktop_id === desktopId);
    return d && this.isLive(d) ? d : null;
  }

  findByCapability(cap: string): DesktopEntry[] {
    return this.list().filter((d) => d.capabilities.includes(cap));
  }

  findByTag(tag: string): DesktopEntry[] {
    return this.list().filter((d) => d.tags.includes(tag));
  }

  /**
   * Pick the best desktop for a target. Resolution order:
   *   1. `desktop_id` (exact) — must be live
   *   2. `capability` — first live desktop with the capability
   *   3. `tag` — first live desktop with the tag
   *   4. `{}` (any) — first live desktop (the local one if alone)
   *
   * Returns null if nothing matches. The local entry is included
   * in the candidate set; this means a `delegate_remote` task
   * with no target picks "us" and effectively degrades to a
   * local `delegate` — a sane default.
   */
  pick(target: DesktopTarget): DesktopEntry | null {
    const all = this.list();
    if (all.length === 0) return null;
    if (target.desktop_id) {
      return all.find((d) => d.desktop_id === target.desktop_id) ?? null;
    }
    if (target.capability) {
      return all.find((d) => d.capabilities.includes(target.capability!)) ?? null;
    }
    if (target.tag) {
      return all.find((d) => d.tags.includes(target.tag!)) ?? null;
    }
    return all[0] ?? null;
  }

  /** The local entry. Null if `start()` was never called. */
  local(): DesktopEntry | null {
    return this.cached;
  }

  private isLive(d: DesktopEntry): boolean {
    const last = Date.parse(d.last_heartbeat);
    if (Number.isNaN(last)) return false;
    return Date.now() - last <= STALE_MS;
  }

  private readFile(): ClusterFile {
    if (!existsSync(this.registryPath)) return { version: 1, desktops: [] };
    try {
      const raw = readFileSync(this.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.version === 1 &&
        Array.isArray(parsed.desktops)
      ) {
        return parsed as ClusterFile;
      }
    } catch {
      // Corrupted file: start clean. (A backup would be nicer;
      // v4.8 keeps it simple.)
    }
    return { version: 1, desktops: [] };
  }

  private writeFile(file: ClusterFile): void {
    if (!existsSync(Deqi_HOME)) mkdirSync(Deqi_HOME, { recursive: true });
    // Atomic write: tmp + rename. Avoids a parallel reader seeing
    // a half-written file (a single `writeFileSync` of a 1KB JSON
    // is technically atomic on most filesystems, but renameSync
    // is the documented cross-platform contract).
    writeFileSync(this.registryTmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(this.registryTmp, this.registryPath);
  }
}
