/**
 * v3.6: small LRU + TTL cache for tool results.
 *
 * Used by:
 *   - read tool (keyed by path + mtime-ms; mtime changes invalidate)
 *   - webFetch + browser.navigate (keyed by URL; TTL-only)
 *
 * The cache is per-session. It is NOT global. Stale data across
 * projects is the kind of bug we want to never have.
 *
 * Limits: 256 entries, 16MB total content. Eviction by LRU.
 * Content is stored as a string. Tools that return binary should
 * NOT use this cache (they should go through a binary cache).
 */

interface Entry {
  key: string;
  content: string;
  /** Bytes (utf-8). */
  bytes: number;
  /** ms since epoch. */
  createdAt: number;
  /** ms since epoch. -1 = no TTL (sticky until mtime change). */
  expiresAt: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  entries: number;
  bytes: number;
}

export class ToolCache {
  private map = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private bytes = 0;

  constructor(
    private readonly maxEntries = 256,
    private readonly maxBytes = 16 * 1024 * 1024,
  ) {}

  get(key: string, now = Date.now()): string | null {
    const e = this.map.get(key);
    if (!e) { this.misses += 1; return null; }
    if (e.expiresAt > 0 && now > e.expiresAt) {
      this.remove(e);
      this.misses += 1;
      return null;
    }
    // LRU bump: delete + re-set to move to most-recently-used
    this.map.delete(key);
    this.map.set(key, e);
    this.hits += 1;
    return e.content;
  }

  set(key: string, content: string, opts: { ttlMs?: number; now?: number } = {}): void {
    const now = opts.now ?? Date.now();
    const bytes = Buffer.byteLength(content, 'utf-8');
    // If the key already exists, drop the old entry's bytes first
    const existing = this.map.get(key);
    if (existing) {
      this.remove(existing);
    }
    const e: Entry = {
      key,
      content,
      bytes,
      createdAt: now,
      expiresAt: opts.ttlMs !== undefined ? now + opts.ttlMs : -1,
    };
    this.map.set(key, e);
    this.bytes += bytes;
    this.enforceLimits();
  }

  /** Drop everything. Used when the project changes. */
  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      entries: this.map.size,
      bytes: this.bytes,
    };
  }

  private remove(e: Entry): void {
    this.map.delete(e.key);
    this.bytes -= e.bytes;
  }

  private enforceLimits(): void {
    while (this.map.size > this.maxEntries) {
      // First key in insertion order is the oldest (Map preserves it)
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const e = this.map.get(oldestKey);
      if (e) {
        this.remove(e);
        this.evictions += 1;
      }
    }
    while (this.bytes > this.maxBytes && this.map.size > 0) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const e = this.map.get(oldestKey);
      if (e) {
        this.remove(e);
        this.evictions += 1;
      }
    }
  }
}

/**
 * Hash a key deterministically. We don't need cryptographic security;
 * we just need a stable, short key. djb2 is fine.
 */
export function hashKey(parts: Array<string | number | boolean>): string {
  let h = 5381;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    h = ((h << 5) + h) ^ 0x1f; // separator
  }
  return (h >>> 0).toString(16);
}
