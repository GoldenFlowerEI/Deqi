/**
 * Deqi-server v2.1 endpoints — search, schedule, files, mobile-pair.
 *
 * Added in v2.1 to support the desktop app's new left-rail:
 *   - 任务搜索 (search across session messages)
 *   - 定时任务 (CRUD on cron-like jobs)
 *   - @-mention file tree (read-only directory listing)
 *   - 手机操控 stub (pairing code generation, no real backend)
 *
 * All endpoints are local-only (server binds 127.0.0.1) and live
 * in this file so the existing v0.1 server.ts stays a thin
 * transport layer.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { SessionManager } from '@deqi/coding-agent';

const SCHEDULE_FILE = join(homedir(), '.deqi', 'schedule.json');
const PAIR_FILE = join(homedir(), '.deqi', 'mobile-pairs.json');

// ─── Schedule types ─────────────────────────────────────────────

export interface ScheduleItem {
  id: string;
  name: string;
  prompt: string;
  /** One of: '5m' | '15m' | '30m' | '1h' | '6h' | 'daily' | 'weekly' */
  cadence: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastRunStatus?: 'ok' | 'error';
  lastRunNote?: string;
}

export interface MobilePair {
  id: string;
  code: string;
  deviceName: string;
  pairedAt: string;
  lastSeenAt?: string;
}

// ─── File tree types ─────────────────────────────────────────────

export interface FileNode {
  name: string;
  path: string; // relative to root
  kind: 'file' | 'dir';
  size?: number;
  children?: FileNode[];
}

// ─── Small JSON helper ───────────────────────────────────────────

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function ensureFile(path: string, fallback: unknown): Promise<void> {
  const dir = path.replace(/[\\/][^\\/]+$/, '');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) {
    await writeFile(path, JSON.stringify(fallback, null, 2), 'utf-8');
  }
}

async function readSchedule(): Promise<ScheduleItem[]> {
  await ensureFile(SCHEDULE_FILE, []);
  try {
    const raw = await readFile(SCHEDULE_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

async function writeSchedule(items: ScheduleItem[]): Promise<void> {
  await ensureFile(SCHEDULE_FILE, []);
  await writeFile(SCHEDULE_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

export async function readPairs(): Promise<MobilePair[]> {
  await ensureFile(PAIR_FILE, []);
  try {
    const raw = await readFile(PAIR_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function writePairs(items: MobilePair[]): Promise<void> {
  await ensureFile(PAIR_FILE, []);
  await writeFile(PAIR_FILE, JSON.stringify(items, null, 2), 'utf-8');
}

// ─── Search handler ──────────────────────────────────────────────

/**
 * Search across all session messages for a query string.
 * Returns up to `limit` sessions ranked by hit-count, with
 * a 100-char context snippet around each hit.
 *
 * Implementation note: we walk the cwd's session directory on
 * disk, parse each JSONL, and search. This is O(n) over the
 * user's local session history — fine for hundreds of sessions,
 * would need an index at 10K+. Not using SQLite here on purpose
 * to avoid pulling in another dep.
 */
export async function handleSearch(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const q = (url.searchParams.get('q') ?? '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '20'), 50);
  if (!q) {
    json(res, { results: [], query: q, total: 0 });
    return;
  }
  const qLower = q.toLowerCase();
  const cwd = url.searchParams.get('cwd') ?? process.cwd();

  const all = await SessionManager.list(cwd);
  const results: Array<{
    sessionId: string;
    cwd: string;
    model: string;
    createdAt: string;
    hits: Array<{ role: string; snippet: string; ts: string }>;
    hitCount: number;
  }> = [];

  for (const s of all) {
    try {
      const loaded = await SessionManager.load(s.filePath);
      const entries = loaded.getEntries();
      const hits: Array<{ role: string; snippet: string; ts: string }> = [];
      for (const e of entries) {
        if (e.type !== 'message') continue;
        const text = extractText(e.content);
        if (!text) continue;
        const lower = text.toLowerCase();
        const idx = lower.indexOf(qLower);
        if (idx < 0) continue;
        const start = Math.max(0, idx - 50);
        const end = Math.min(text.length, idx + q.length + 50);
        const snippet = (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
        hits.push({ role: e.role, snippet, ts: e.ts });
      }
      if (hits.length > 0) {
        results.push({
          sessionId: s.id,
          cwd: s.header.cwd,
          model: s.header.model,
          createdAt: s.header.createdAt,
          hits: hits.slice(0, 5),
          hitCount: hits.length,
        });
      }
    } catch {
      // skip unreadable sessions
    }
  }
  results.sort((a, b) => b.hitCount - a.hitCount);
  json(res, { results: results.slice(0, limit), query: q, total: results.length });
}

// ─── Schedule handlers ───────────────────────────────────────────

export async function handleListSchedule(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const items = await readSchedule();
  json(res, { items });
}

export async function handleCreateSchedule(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<Partial<ScheduleItem>>(req);
  if (!body.name || !body.prompt || !body.cadence) {
    json(res, { error: 'missing_field', need: ['name', 'prompt', 'cadence'] }, 400);
    return;
  }
  const item: ScheduleItem = {
    id: 'sch_' + randomBytes(6).toString('hex'),
    name: body.name,
    prompt: body.prompt,
    cadence: body.cadence,
    enabled: body.enabled ?? true,
    createdAt: new Date().toISOString(),
  };
  const items = await readSchedule();
  items.push(item);
  await writeSchedule(items);
  json(res, { item }, 201);
}

export async function handleUpdateSchedule(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const items = await readSchedule();
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) {
    json(res, { error: 'not_found' }, 404);
    return;
  }
  const body = await readJsonBody<Partial<ScheduleItem>>(req);
  items[idx] = { ...items[idx], ...body, id: items[idx].id, createdAt: items[idx].createdAt };
  await writeSchedule(items);
  json(res, { item: items[idx] });
}

export async function handleDeleteSchedule(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const items = await readSchedule();
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) {
    json(res, { error: 'not_found' }, 404);
    return;
  }
  await writeSchedule(next);
  json(res, { ok: true, id });
}

export async function handleRunScheduleNow(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  /**
   * v2.2: actually execute the item. The handler responds 200
   * immediately with `lastRunNote: "queued"` so the UI can
   * reflect the intent; the `runItem` callback runs the
   * prompt in the background and updates the item's
   * lastRunAt / lastRunStatus / lastRunNote when it finishes.
   */
  runItem?: (item: ScheduleItem) => Promise<{ ok: boolean; note: string }>,
): Promise<void> {
  const items = await readSchedule();
  const item = items.find((i) => i.id === id);
  if (!item) {
    json(res, { error: 'not_found' }, 404);
    return;
  }
  // Mark the queue intent. We DON'T pre-set lastRunStatus='ok' —
  // the background completion is the only way for lastRunStatus
  // to reach a terminal state. The desktop UI shows the
  // "queued" / lastRunNote string to indicate work in flight.
  item.lastRunAt = new Date().toISOString();
  item.lastRunNote = runItem ? 'queued' : 'no-runner';
  // lastRunStatus is left as-is (undefined on first run, or the
  // previous run's status). The background then() sets it to
  // 'ok' or 'error' when the prompt actually completes.
  await writeSchedule(items);
  json(res, { ok: true, item });

  if (runItem) {
    void runItem(item).then(async (result) => {
      // Re-read items (other patches may have run since) and
      // update only this one's run fields.
      const cur = await readSchedule();
      const i = cur.find((x) => x.id === id);
      if (!i) return;
      i.lastRunAt = new Date().toISOString();
      i.lastRunStatus = result.ok ? 'ok' : 'error';
      i.lastRunNote = result.note;
      await writeSchedule(cur);
    }).catch((err) => {
      // Last-resort: write the error so the user sees it on
      // the next list. Don't crash the server on a single
      // schedule failure.
      void (async () => {
        const cur = await readSchedule();
        const i = cur.find((x) => x.id === id);
        if (!i) return;
        i.lastRunAt = new Date().toISOString();
        i.lastRunStatus = 'error';
        i.lastRunNote = `crash: ${(err as Error).message}`;
        await writeSchedule(cur);
      })();
    });
  }
}

// ─── Files handler ───────────────────────────────────────────────

/** Reject paths that try to escape the root. */
function safeJoin(root: string, rel: string): string | null {
  if (!rel || rel.startsWith('..')) return null;
  const abs = join(root, rel);
  const norm = abs.replace(/[\\/]+/g, sep);
  const rootNorm = root.replace(/[\\/]+/g, sep).replace(sep + '$', '');
  if (norm !== rootNorm && !norm.startsWith(rootNorm + sep)) return null;
  return abs;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '.next', 'build', '.cargo', '.bun']);
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 4;

export async function handleListFiles(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const root = url.searchParams.get('root') ?? process.cwd();
  const rel = url.searchParams.get('path') ?? '.';
  const abs = safeJoin(root, rel);
  if (!abs) {
    json(res, { error: 'unsafe_path' }, 400);
    return;
  }
  if (!existsSync(abs)) {
    json(res, { error: 'not_found' }, 404);
    return;
  }
  try {
    const tree = await walkDir(abs, root, 0);
    json(res, { root, path: rel, node: tree });
  } catch (err) {
    json(res, { error: 'read_failed', message: String((err as Error).message) }, 500);
  }
}

async function walkDir(absPath: string, root: string, depth: number): Promise<FileNode> {
  const st = await stat(absPath);
  if (!st.isDirectory()) {
    return {
      name: absPath.split(/[\\/]/).pop() ?? '',
      path: relative(root, absPath).replace(/\\/g, '/'),
      kind: 'file',
      size: st.size,
    };
  }
  const entries = await readdir(absPath);
  const children: FileNode[] = [];
  let total = 0;
  for (const name of entries) {
    if (total >= MAX_ENTRIES) break;
    if (name.startsWith('.') && name !== '.deqi' && name !== '.cargo') continue;
    if (SKIP_DIRS.has(name)) continue;
    if (depth >= MAX_DEPTH) break;
    const childAbs = join(absPath, name);
    children.push(await walkDir(childAbs, root, depth + 1));
    total += 1;
  }
  children.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return {
    name: absPath.split(/[\\/]/).pop() ?? '',
    path: relative(root, absPath).replace(/\\/g, '/') || '.',
    kind: 'dir',
    children,
  };
}

// ─── Mobile pair handlers (stub) ────────────────────────────────

export async function handleListPairs(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const items = await readPairs();
  json(res, { items });
}

/** Generate a new pairing code. Stub: the real backend would be
 *  a WebSocket / push-notification service.
 *
 *  Code format: 12 hex chars split into 3 groups of 4 with dashes,
 *  e.g. "29FC-1552-C6A0" (14 chars total). The 12 hex chars come
 *  from 6 random bytes. */
export async function handleCreatePair(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<{ deviceName?: string }>(req);
  const group = (): string => randomBytes(2).toString('hex');
  const code = (group() + '-' + group() + '-' + group()).toUpperCase();
  const item: MobilePair = {
    id: 'pair_' + randomBytes(4).toString('hex'),
    code,
    deviceName: body.deviceName ?? 'iPhone',
    pairedAt: new Date().toISOString(),
  };
  const items = await readPairs();
  items.push(item);
  await writePairs(items);
  json(res, { item, expiresInSec: 600 }, 201);
}

// ─── v5.1: in-app feedback channel ───────────────────────────────────
// User-facing feedback from the desktop / web / CLI lands here as one
// JSONL line per submission. Same shape regardless of surface, so the
// desktop "send feedback" button, the CLI `deqi feedback "…"`, and the
// eventual web "?" button all converge on the same file.
//
// The file is `~/.deqi/feedback.jsonl`. No auth, no PII scrubbing — the
// user is sending themselves a note. If a future version syncs to a
// remote, the scrub step belongs there, not here.
//
// Idempotency: the client may retry (e.g. network blip). The endpoint
// accepts an optional `clientId` (string) and dedupes on it. Without
// `clientId`, every submission is a new row.

const FEEDBACK_FILE = join(homedir(), '.deqi', 'feedback.jsonl');

export interface FeedbackEntry {
  id: string;
  clientId?: string;
  kind: 'bug' | 'feature' | 'comment' | 'question';
  /** Free-text message from the user. 1-4000 chars. */
  message: string;
  /** 1-5 stars. Optional. */
  rating?: number;
  /** Which view/page the user was on when they submitted. */
  surface: string;
  /** Optional session id for cross-referencing logs. */
  sessionId?: string;
  /** Optional desktop id for multi-machine installations. */
  desktopId?: string;
  /** App version, e.g. "v5.1.0". */
  appVersion: string;
  createdAt: string;
}

export async function handleCreateFeedback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody<Partial<FeedbackEntry>>(req);
  if (!body.message || typeof body.message !== 'string') {
    json(res, { error: 'missing_field', need: ['message'] }, 400);
    return;
  }
  const message = body.message.trim();
  if (message.length < 1 || message.length > 4000) {
    json(res, { error: 'invalid_length', need: '1-4000 chars' }, 400);
    return;
  }
  const kind = body.kind ?? 'comment';
  if (!['bug', 'feature', 'comment', 'question'].includes(kind)) {
    json(res, { error: 'invalid_kind', accepted: ['bug', 'feature', 'comment', 'question'] }, 400);
    return;
  }
  if (body.rating !== undefined && (body.rating < 1 || body.rating > 5)) {
    json(res, { error: 'invalid_rating', need: '1..5' }, 400);
    return;
  }
  // Idempotency: dedupe on clientId within the last 1000 entries.
  // (Cheap O(n) scan; feedback volume is low, not worth an index.)
  if (body.clientId) {
    try {
      if (existsSync(FEEDBACK_FILE)) {
        const recent = readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean).slice(-1000);
        for (const line of recent) {
          try {
            const prev = JSON.parse(line) as FeedbackEntry;
            if (prev.clientId === body.clientId && prev.message === message) {
              json(res, { ok: true, id: prev.id, deduped: true });
              return;
            }
          } catch {
            // Skip malformed line.
          }
        }
      }
    } catch {
      // Best-effort dedup. If the file is unreadable, fall through
      // and write a new row.
    }
  }
  const entry: FeedbackEntry = {
    id: 'fb_' + randomBytes(4).toString('hex'),
    clientId: body.clientId,
    kind,
    message,
    rating: body.rating,
    surface: body.surface ?? 'unknown',
    sessionId: body.sessionId,
    desktopId: body.desktopId,
    appVersion: body.appVersion ?? 'unknown',
    createdAt: new Date().toISOString(),
  };
  try {
    const dir = join(homedir(), '.deqi');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    json(res, { error: 'write_failed', message: String((err as Error).message) }, 500);
    return;
  }
  json(res, { ok: true, id: entry.id }, 201);
}

export interface FeedbackListOptions {
  limit?: number;
  kind?: FeedbackEntry['kind'];
}

export async function handleListFeedback(
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!existsSync(FEEDBACK_FILE)) {
    json(res, { entries: [], total: 0 });
    return;
  }
  try {
    const raw = readFileSync(FEEDBACK_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const entries: FeedbackEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as FeedbackEntry);
      } catch {
        // Skip malformed line.
      }
    }
    const kind = url.searchParams.get('kind') as FeedbackEntry['kind'] | null;
    const filtered = kind ? entries.filter((e) => e.kind === kind) : entries;
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const recent = filtered.slice(-limit).reverse();
    json(res, { entries: recent, total: filtered.length });
  } catch (err) {
    json(res, { error: 'read_failed', message: String((err as Error).message) }, 500);
  }
}

export async function handleDeletePair(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const items = await readPairs();
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) {
    json(res, { error: 'not_found' }, 404);
    return;
  }
  await writePairs(next);
  json(res, { ok: true, id });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

// Re-export the helpers used by the v2 router.
export { json };
