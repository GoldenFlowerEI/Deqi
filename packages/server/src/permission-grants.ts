/**
 * v4.4: per-session permission grants.
 *
 * The v4.0 permission gate (`modeAllows`) returns a static
 * verdict: "in this mode, this tool is allowed/asked/denied".
 * v4.4 adds the user's per-tool override: "I approved `bash` for
 * this session" or "always allow `read` for this cwd".
 *
 * Three grant levels, in increasing scope:
 *
 *   'turn'      — One-shot. Cleared at the end of the current turn.
 *                  Used when the user clicks "Allow" on a single
 *                  tool prompt and wants to confirm just this one.
 *   'session'   — Persists for the rest of this AgentRunner's
 *                  lifetime. Survives multiple turns. Used when the
 *                  user says "I trust you to run tests, just don't
 *                  touch production".
 *   'forever'   — Persists on disk in `~/.deqi/permission-grants.json`.
 *                  Survives server restarts. Used when the user
 *                  says "always allow read for this project".
 *
 * The store is consulted by `AgentRunner.evaluatePermission` BEFORE
 * the v4.0 mode gate. A grant overrides the mode: if the user said
 * "always allow `read`", even `plan` mode allows it. Conversely,
 * a grant for `bash` doesn't override `bypass-permissions` (the
 * gate already allows it; the grant is a no-op there).
 *
 * The store is also inspectable via /v1/permission/grants so the
 * desktop UI can show "you've approved these 3 things this session".
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type GrantLevel = 'turn' | 'session' | 'forever';
export type GrantPattern = 'exact' | 'prefix';

/** A single grant. Records WHO approved WHAT, and for HOW LONG. */
export interface PermissionGrant {
  /** Stable id (random hex). */
  id: string;
  /** The tool this grant applies to (e.g. 'bash', 'edit', 'read'). */
  tool: string;
  /** 'exact' matches a single tool name; 'prefix' allows
   *  family members like `git_*` to match `git_status`. */
  pattern: GrantPattern;
  /** What scope the grant lasts. */
  level: GrantLevel;
  /** Optional cwd scope. When set, the grant only applies to
   *  this cwd (a project-level grant). When null, it's global. */
  cwdScope?: string;
  /** ISO timestamp of when the user approved this. */
  grantedAt: string;
  /** Human-readable note ("I trust this for tests"). */
  note?: string;
}

interface GrantStoreFile {
  /** Schema version for forward-compat. */
  version: 1;
  /** All 'forever' grants. 'session' / 'turn' live in memory. */
  grants: PermissionGrant[];
}

const STORE_PATH = join(homedir(), '.deqi', 'permission-grants.json');

/**
 * v4.4: the in-process grant store. Holds 'turn' and 'session'
 * grants in memory and 'forever' grants on disk. The runner
 * consults `evaluate()` before falling back to the mode gate.
 */
export class GrantStore {
  /** 'turn' grants — cleared at the end of the current turn. */
  private turnGrants: PermissionGrant[] = [];
  /** 'session' grants — cleared when the runner stops. */
  private sessionGrants: PermissionGrant[] = [];
  /** 'forever' grants — loaded from disk on construction. */
  private foreverGrants: PermissionGrant[] = [];

  constructor(storePath: string = STORE_PATH) {
    this.foreverGrants = loadForever(storePath);
  }

  /**
   * v4.4: record a new grant. The user approved a tool at the
   * given level. The grant is added to the appropriate list and
   * (for 'forever') persisted to disk.
   */
  add(g: Omit<PermissionGrant, 'id' | 'grantedAt'> & { id?: string; grantedAt?: string }, storePath: string = STORE_PATH): PermissionGrant {
    const grant: PermissionGrant = {
      id: g.id ?? randomHex(8),
      tool: g.tool,
      pattern: g.pattern,
      level: g.level,
      cwdScope: g.cwdScope,
      grantedAt: g.grantedAt ?? new Date().toISOString(),
      note: g.note,
    };
    if (grant.level === 'turn') this.turnGrants.push(grant);
    else if (grant.level === 'session') this.sessionGrants.push(grant);
    else {
      this.foreverGrants.push(grant);
      persistForever(storePath, this.foreverGrants);
    }
    return grant;
  }

  /** v4.4: drop a grant by id. Returns true if found + removed. */
  remove(id: string, storePath: string = STORE_PATH): boolean {
    const before = this.foreverGrants.length;
    this.foreverGrants = this.foreverGrants.filter((g) => g.id !== id);
    if (this.foreverGrants.length !== before) {
      persistForever(storePath, this.foreverGrants);
      return true;
    }
    const sb = this.sessionGrants.length;
    this.sessionGrants = this.sessionGrants.filter((g) => g.id !== id);
    if (this.sessionGrants.length !== sb) return true;
    const tb = this.turnGrants.length;
    this.turnGrants = this.turnGrants.filter((g) => g.id !== id);
    return this.turnGrants.length !== tb;
  }

  /**
   * v4.4: clear 'turn' grants (called by the runner at the end
   * of each turn). 'session' / 'forever' are unaffected.
   */
  clearTurnGrants(): void {
    this.turnGrants = [];
  }

  /**
   * v4.4: clear 'session' grants (called by the runner when it
   * stops). 'forever' persists to disk.
   */
  clearSessionGrants(): void {
    this.sessionGrants = [];
  }

  /**
   * v4.4: does a grant cover this (tool, cwd) combination?
   * Returns the matching grant, or null. 'turn' is checked first,
   * then 'session', then 'forever' — earliest scope wins so the
   * user can grant one-shot exceptions to broader rules.
   */
  match(tool: string, cwd?: string): PermissionGrant | null {
    const all = [...this.turnGrants, ...this.sessionGrants, ...this.foreverGrants];
    for (const g of all) {
      if (g.cwdScope && cwd && g.cwdScope !== cwd) continue;
      if (g.pattern === 'exact' && g.tool === tool) return g;
      if (g.pattern === 'prefix' && (g.tool === tool || tool.startsWith(g.tool + '_'))) return g;
    }
    return null;
  }

  /** v4.4: list every grant (across all scopes). */
  list(): PermissionGrant[] {
    return [...this.turnGrants, ...this.sessionGrants, ...this.foreverGrants];
  }
}

// ─── disk persistence for 'forever' grants ─────────────────────

function loadForever(path: string): PermissionGrant[] {
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as GrantStoreFile;
    if (data.version !== 1) return [];
    return Array.isArray(data.grants) ? data.grants : [];
  } catch {
    return [];
  }
}

function persistForever(path: string, grants: PermissionGrant[]): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: GrantStoreFile = { version: 1, grants };
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  } catch { /* best-effort; the in-memory copy still works */ }
}

function randomHex(bytes: number): string {
  // Tiny inline impl so we don't pull in node:crypto for what is
  // effectively a 4-byte id.
  let s = '';
  for (let i = 0; i < bytes; i += 1) {
    s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  }
  return s;
}
