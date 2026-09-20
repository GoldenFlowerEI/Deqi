/**
 * v3.4: introspection log (Friston / Schön / Maturana autopoiesis).
 *
 * The agent's "behavior snapshots" — tool calls, decisions, grades —
 * are persisted as a JSONL append-only log under
 * ~/.deqi/introspection/<sessionId>.jsonl. This is the substrate that
 * `self_reflect` reads and the future bench harness scores against.
 *
 * v3.4 minimum viable scope:
 *   - appendEntry: any entry with { ts, type, payload }
 *   - readRecent(sessionId, limit): tail the log
 *   - getAggregateStats(): counters by type, for the bench harness
 *
 * NOT in v3.4 (deliberate):
 *   - Reflection: v3.4 has the LOG, but `self_reflect` stays the
 *     existing shallow heuristic. Wiring the LLM to actually
 *     reflect on its own log is v3.4.1.
 *   - Cross-session pattern detection (would need embeddings).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const LOG_ROOT = resolve(homedir(), '.deqi', 'introspection');

export type EntryType =
  | 'tool_call'
  | 'tool_result'
  | 'grade'
  | 'reflection'
  | 'phase_transition'
  | 'session_start'
  | 'session_end'
  | 'plan_proposed'
  | 'plan_recorded'
  | 'memory_written'
  | 'skill_invoked'
  | 'orchestrator_dispatched';

export interface IntrospectionEntry {
  ts: string;
  sessionId: string;
  type: EntryType;
  /** Free-form payload; the entry type dictates the shape. */
  payload: Record<string, unknown>;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function logFile(sessionId: string): string {
  ensureDir(LOG_ROOT);
  return join(LOG_ROOT, `${sessionId}.jsonl`);
}

/** Append a single entry. Synchronous to keep the contract simple. */
export function appendEntry(entry: IntrospectionEntry): void {
  const file = logFile(entry.sessionId);
  ensureDir(LOG_ROOT);
  writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a', encoding: 'utf-8' });
}

/** Tail the last N entries for a session. Newest last. */
export function readRecent(sessionId: string, limit = 50): IntrospectionEntry[] {
  const file = logFile(sessionId);
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n').filter(Boolean);
  const out: IntrospectionEntry[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as IntrospectionEntry);
    } catch { /* skip corrupted */ }
  }
  if (out.length <= limit) return out;
  return out.slice(-limit);
}

/** Read all entries across all sessions. O(n) but logs are small in v3.4. */
export function readAll(limitPerSession = 200): IntrospectionEntry[] {
  if (!existsSync(LOG_ROOT)) return [];
  const all: IntrospectionEntry[] = [];
  for (const name of readdirSync(LOG_ROOT)) {
    if (!name.endsWith('.jsonl')) continue;
    const sid = name.replace(/\.jsonl$/, '');
    for (const e of readRecent(sid, limitPerSession)) all.push(e);
  }
  return all;
}

export interface AggregateStats {
  totalEntries: number;
  byType: Record<EntryType, number>;
  sessionCount: number;
  gradeCount: number;
  meanGrade: number | null;     // 0..1
  toolCallCount: number;
  uniqueTools: number;
  firstAt: string | null;
  lastAt: string | null;
}

export function getAggregateStats(): AggregateStats {
  const all = readAll();
  const byType: Partial<Record<EntryType, number>> = {};
  const sessionIds = new Set<string>();
  const toolNames = new Set<string>();
  let gradeCount = 0;
  let gradeSum = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  for (const e of all) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    sessionIds.add(e.sessionId);
    if (e.type === 'grade') {
      const g = (e.payload as { grade?: number }).grade;
      if (typeof g === 'number' && g >= 0 && g <= 1) {
        gradeCount += 1;
        gradeSum += g;
      }
    }
    if (e.type === 'tool_call') {
      const t = (e.payload as { tool?: string }).tool;
      if (typeof t === 'string') toolNames.add(t);
    }
    if (!firstAt || e.ts < firstAt) firstAt = e.ts;
    if (!lastAt || e.ts > lastAt) lastAt = e.ts;
  }
  return {
    totalEntries: all.length,
    byType: byType as Record<EntryType, number>,
    sessionCount: sessionIds.size,
    gradeCount,
    meanGrade: gradeCount > 0 ? gradeSum / gradeCount : null,
    toolCallCount: byType['tool_call'] ?? 0,
    uniqueTools: toolNames.size,
    firstAt,
    lastAt,
  };
}

export { LOG_ROOT };
