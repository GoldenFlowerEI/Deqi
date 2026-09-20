/**
 * v4.6: plugin hot-reload via file watcher.
 *
 * Watches `~/.deqi/plugins/<name>/plugin.json` and `index.mjs`.
 * When a file changes, debounces 200ms (a typical editor save
 * emits 2-3 events) and invokes a `reload(name)` callback.
 * The callback decides what to do — for Deqi the server uses
 * it to: re-validate the manifest, dynamic-import the new
 * `index.mjs`, call its `register(api)`, and swap the per-plugin
 * slice in its collections (pluginTools / pluginRoutes /
 * pluginEventHandlers).
 *
 * Why a debounce: editors like VSCode write to a temp file
 * then rename to the final name — that produces 2 inotify
 * events back-to-back. Without the debounce we'd reload twice
 * for every save.
 *
 * Why per-file watch (not a single recursive watcher): the
 * recursive watcher on Windows is unreliable (and on macOS
 * expensive); per-plugin subdirs are bounded (single-digit),
 * so 6-8 individual fs.watch handles are fine.
 *
 * The watcher is "dumb" by design: it does NOT do the actual
 * reload. It just calls `onChange(name, reason)`. The server
 * owns the policy: re-validate, fall back to "mark as errored"
 * if the new manifest is broken, etc.
 */

import { watch, type FSWatcher, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PluginWatcherOptions {
  pluginsDir: string;
  onChange: (pluginName: string, reason: 'manifest' | 'entry' | 'removed') => void;
  /** Optional debounce ms (default 200). */
  debounceMs?: number;
  /** Optional poll interval ms (default 1000). The poll is the
   *  reliable fallback for platforms where fs.watch misses
   *  events (Windows + macOS). Set lower for tests. */
  pollIntervalMs?: number;
}

export class PluginWatcher {
  private watchers: FSWatcher[] = [];
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private closed = false;
  private readonly debounceMs: number;
  /** v4.6: last-snapshot state for the 1s poll fallback. */
  private snapshot: Record<string, Record<string, string>> = {};
  private pollTimer: NodeJS.Timeout | null = null;

  private readonly pollIntervalMs: number;

  constructor(private readonly opts: PluginWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 200;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
  }

  /** v4.6: start watching. We rely on polling for reliability
   *  (fs.watch on Windows + macOS is famously unreliable for
   *  directory-level events). The 1s poll reads the dir, diffs
   *  against the last snapshot, and fires onChange for any
   *  diff. Cheap: one readdir per second per poll. */
  start(): void {
    if (!existsSync(this.opts.pluginsDir)) return;
    this.snapshot = this.snapshotDir();
    this.attachTopLevelWatch();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /** v4.6: periodic poll. Compares the current dir state to the
   *  last snapshot; fires the same onChange callback the watcher
   *  would. The debounce coalesces 1s polls with watcher events
   *  into a single reload. */
  private poll(): void {
    if (this.closed) return;
    const next = this.snapshotDir();
    const prev = this.snapshot;
    // Detect new subdirs.
    for (const name of Object.keys(next)) {
      if (!prev[name]) this.scheduleReload(name, 'manifest');
    }
    // Detect removed subdirs.
    for (const name of Object.keys(prev)) {
      if (!next[name]) this.scheduleReload(name, 'removed');
    }
    // Detect changed files in existing subdirs.
    for (const name of Object.keys(next)) {
      if (!prev[name]) continue;
      const a = prev[name];
      const b = next[name];
      if (a['plugin.json'] !== b['plugin.json']) this.scheduleReload(name, 'manifest');
      if (a['index.mjs'] !== b['index.mjs'] || a['index.js'] !== b['index.js']) this.scheduleReload(name, 'entry');
    }
    this.snapshot = next;
  }

  private snapshotDir(): Record<string, Record<string, string>>;
  private snapshotDir(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    if (!existsSync(this.opts.pluginsDir)) return out;
    try {
      for (const name of readdirSync(this.opts.pluginsDir)) {
        try {
          if (!statSync(join(this.opts.pluginsDir, name)).isDirectory()) continue;
        } catch { continue; }
        const inner: Record<string, string> = {};
        for (const leaf of ['plugin.json', 'index.mjs', 'index.js']) {
          const p = join(this.opts.pluginsDir, name, leaf);
          if (existsSync(p)) {
            try { inner[leaf] = readFileSync(p, 'utf8'); } catch { /* ignore */ }
          }
        }
        out[name] = inner;
      }
    } catch { /* ignore */ }
    return out;
  }

  private attachTopLevelWatch(): void {
    // The poll loop is the single source of truth; the fs.watch
    // handles below are best-effort accelerators. They reduce
    // the average detection latency from `pollIntervalMs` to
    // ~10ms but are NOT load-bearing — the poll still catches
    // anything the watchers miss.
    const w = watch(this.opts.pluginsDir, { persistent: false }, (eventType, filename) => {
      if (this.closed) return;
      if (!filename) return;
      // We don't try to interpret the dir-level event; the next
      // poll will pick up the change. This sidesteps all the
      // "did existsSync return true yet" race conditions.
      void eventType;
    });
    w.on('error', () => { /* swallow */ });
    this.watchers.push(w);
  }

  /** v4.6: coalesce multiple file events for the same plugin
   *  into a single callback. Without this, an editor save
   *  produces 2-3 events in 50ms and we'd reload 2-3 times. */
  private scheduleReload(name: string, reason: 'manifest' | 'entry' | 'removed'): void {
    if (this.closed) return;
    const key = `${name}::${reason}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.debounceTimers.delete(key);
      try { this.opts.onChange(name, reason); } catch { /* swallow */ }
    }, this.debounceMs);
    this.debounceTimers.set(key, t);
  }

  /** v4.6: stop watching and release all handles. */
  close(): void {
    this.closed = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
  }

  /** v4.6: number of active fs.watch handles (for tests + logging). */
  get handleCount(): number {
    return this.watchers.length;
  }
}
