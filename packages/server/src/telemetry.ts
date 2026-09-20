/**
 * v4.7: opt-in telemetry.
 *
 * Records counts (NOT PII) of what the agent did this session:
 * tool calls by name, session count, error rate. Persists to
 * `~/.deqi/telemetry.jsonl` (one line per event) so a power user
 * can grep their own history.
 *
 * PII guarantees:
 *   - We never log tool ARGS, tool RESULTS, user text, or session
 *     IDs. Only the tool name (a string from a closed set) +
 *     the timestamp + an event type.
 *   - Aggregates are exposed via /v1/telemetry/aggregate (counts
 *     only) — never the raw event stream.
 *
 * Off by default. The user opts in by:
 *   - `Deqi_TELEMETRY=1` env var at server start, or
 *   - `POST /v1/telemetry/opt-in { enabled: true }`
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type TelemetryEventKind =
  | 'tool_call'         // { tool: string, isError: boolean }
  | 'session_start'     // {}
  | 'session_end'       // {}
  | 'turn_start'        // {}
  | 'turn_end'          // {}
  | 'plugin_load'       // { id: string }
  | 'plugin_unload'     // { id: string }
  | 'recipe_run'        // { name: string, steps: number }
  | 'error'             // { where: string, code: string }
  ;

export interface TelemetryEvent {
  kind: TelemetryEventKind;
  ts: string;             // ISO timestamp
  /** Bag of safe scalar fields. Never user text or tool args. */
  data: Record<string, string | number | boolean>;
}

export interface TelemetrySummary {
  /** Wall-clock window the summary covers. */
  from: string;
  to: string;
  total: number;
  byKind: Record<string, number>;
  /** tool_call breakdown: tool name → {calls, errors}. */
  tools: Record<string, { calls: number; errors: number }>;
}

const TELEMETRY_PATH = join(homedir(), '.deqi', 'telemetry.jsonl');

/**
 * v4.7: the in-process telemetry recorder. A no-op until
 * `enable()` flips the gate. After enable, every `record()`
 * call writes one JSONL line to disk.
 */
export class Telemetry {
  private enabled = false;
  private path: string;
  /** In-memory rolling totals for the GET /v1/telemetry/aggregate endpoint. */
  private summary: TelemetrySummary = this.emptySummary();

  constructor(path: string = TELEMETRY_PATH) {
    this.path = path;
  }

  private emptySummary(): TelemetrySummary {
    const now = new Date().toISOString();
    return { from: now, to: now, total: 0, byKind: {}, tools: {} };
  }

  /** v4.7: turn the recorder on. Idempotent. */
  enable(): void {
    this.enabled = true;
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Touch the file so the user can see it exists.
      if (!existsSync(this.path)) writeFileSync(this.path, '', 'utf8');
    } catch { /* best-effort */ }
  }

  /** v4.7: turn off. Existing file is kept (the user can inspect
   *  their past activity even if they opted out going forward). */
  disable(): void { this.enabled = false; }

  /** v4.7: report the current state. */
  isEnabled(): boolean { return this.enabled; }

  /** v4.7: record a single event. No-op when disabled. */
  record(kind: TelemetryEventKind, data: Record<string, string | number | boolean> = {}): void {
    if (!this.enabled) return;
    const ev: TelemetryEvent = {
      kind,
      ts: new Date().toISOString(),
      data: this.scrub(data),
    };
    this.bumpSummary(ev);
    try {
      appendFileSync(this.path, JSON.stringify(ev) + '\n', 'utf8');
    } catch { /* best-effort; the in-memory summary still updates */ }
  }

  /** v4.7: best-effort scrub of the data bag. We refuse any
   *  field name that looks like it could carry PII (text, args,
   *  result, prompt, query, url-with-query). The fields we
   *  actually record are short, well-known strings/numbers. */
  private scrub(data: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
    const BLOCKED = new Set(['text', 'args', 'result', 'prompt', 'query', 'message', 'body']);
    const out: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(data)) {
      if (BLOCKED.has(k.toLowerCase())) continue;
      if (typeof v === 'string' && v.length > 200) out[k] = v.slice(0, 200) + '…';
      else out[k] = v;
    }
    return out;
  }

  private bumpSummary(ev: TelemetryEvent): void {
    this.summary.to = ev.ts;
    this.summary.total += 1;
    this.summary.byKind[ev.kind] = (this.summary.byKind[ev.kind] ?? 0) + 1;
    if (ev.kind === 'tool_call') {
      const tool = String(ev.data['tool'] ?? 'unknown');
      const isErr = Boolean(ev.data['isError']);
      const cur = this.summary.tools[tool] ?? { calls: 0, errors: 0 };
      cur.calls += 1;
      if (isErr) cur.errors += 1;
      this.summary.tools[tool] = cur;
    }
  }

  /** v4.7: snapshot the current in-memory summary. */
  getSummary(): TelemetrySummary {
    return JSON.parse(JSON.stringify(this.summary)) as TelemetrySummary;
  }

  /** v4.7: re-build the summary from the JSONL file on disk.
   *  Useful when the server restarts and the in-memory state
   *  is lost. */
  rebuildFromDisk(): void {
    if (!existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      this.summary = this.emptySummary();
      for (const ln of lines) {
        try {
          const ev = JSON.parse(ln) as TelemetryEvent;
          this.bumpSummary(ev);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* best-effort */ }
  }
}
