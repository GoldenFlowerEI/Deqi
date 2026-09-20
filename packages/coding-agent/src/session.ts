import { readFile, writeFile, mkdir, appendFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

/**
 * Session persistence.
 *
 * v0.1: linear JSONL with a single active leaf.
 * v0.2 will lift this to a tree (parentId-based, /tree navigation).
 *
 * Schema (one entry per line):
 *   { "type": "session",   "id": "uuid", "cwd": "...", "createdAt": "...",
 *     "model": "...", "provider": "..." }
 *   { "type": "message",    "id": "8hex", "parentId": "8hex|null", "role": "...",
 *     "content": [...], "ts": "..." }
 *   { "type": "model_change", "id": "...", "parentId": "...", "model": "..." }
 *   { "type": "compact",     "id": "...", "parentId": "...", "summary": "...",
 *     "tokensBefore": 12345 }
 *   { "type": "label",       "id": "...", "parentId": "...", "label": "..." }
 */

const Deqi_HOME = join(homedir(), '.deqi');

export interface SessionHeader {
  type: 'session';
  id: string;
  cwd: string;
  createdAt: string;
  model: string;
  provider: string;
}

export interface MessageEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: unknown;
  ts: string;
}

export interface ModelChangeEntry {
  type: 'model_change';
  id: string;
  parentId: string | null;
  model: string;
  provider: string;
  ts: string;
}

export interface CompactEntry {
  type: 'compact';
  id: string;
  parentId: string | null;
  summary: string;
  tokensBefore: number;
  ts: string;
}

export interface LabelEntry {
  type: 'label';
  id: string;
  parentId: string | null;
  label: string;
  ts: string;
}

export type SessionEntry =
  | SessionHeader
  | MessageEntry
  | ModelChangeEntry
  | CompactEntry
  | LabelEntry
  | ReflectionEntry
  | ForkEntry;

export interface ReflectionEntry {
  type: 'reflection';
  id: string;
  parentId: string | null;
  /** Short structured note (≤ 280 chars). */
  note: string;
  /** What the agent tried (one-line). */
  tried: string;
  /** What the agent learned (one-line). */
  learned: string;
  /** What it would do differently (one-line). */
  nextHint: string;
  /** Number of tool calls in the reflected turn. */
  toolCallCount: number;
  /** Whether the turn produced any errors. */
  hadErrors: boolean;
  ts: string;
}

export interface ForkEntry {
  type: 'fork';
  id: string;
  parentId: string | null;
  /** A short label for the new branch. */
  label: string;
  /** The leaf id of the original branch at fork time. */
  forkPoint: string;
  ts: string;
}

/** A node in the session tree. */
export interface TreeNode {
  id: string;
  entry: SessionEntry;
  children: TreeNode[];
  depth: number;
}

function makeId(): string {
  return createHash('sha256')
    .update(crypto.randomBytes(8))
    .digest('hex')
    .slice(0, 8);
}

// Avoid pulling in node:crypto.randomBytes explicitly as it is identical.
import * as crypto from 'node:crypto';

export class SessionManager {
  readonly filePath: string;
  readonly sessionId: string;
  private entries: SessionEntry[] = [];
  private leafId: string | null = null;
  private loaded = false;

  private constructor(filePath: string, sessionId: string) {
    this.filePath = filePath;
    this.sessionId = sessionId;
  }

  static async create(cwd: string, model: string, provider: string): Promise<SessionManager> {
    const dir = join(Deqi_HOME, 'sessions', encodeCwd(cwd));
    await mkdir(dir, { recursive: true });
    const sessionId = createHash('sha1')
      .update(cwd + ':' + Date.now() + ':' + Math.random())
      .digest('hex')
      .slice(0, 12);
    const filePath = join(dir, `${sessionId}.jsonl`);
    const sm = new SessionManager(filePath, sessionId);
    const header: SessionHeader = {
      type: 'session',
      id: sessionId,
      cwd,
      createdAt: new Date().toISOString(),
      model,
      provider,
    };
    sm.entries.push(header);
    sm.leafId = header.id;
    await writeFile(filePath, JSON.stringify(header) + '\n', 'utf8');
    sm.loaded = true;
    return sm;
  }

  static async load(filePath: string): Promise<SessionManager> {
    const sm = new SessionManager(filePath, basename(filePath).replace(/\.jsonl$/, ''));
    await sm.loadFromDisk();
    return sm;
  }

  static async list(cwd: string): Promise<Array<{ id: string; filePath: string; header: SessionHeader }>> {
    const dir = join(Deqi_HOME, 'sessions', encodeCwd(cwd));
    if (!existsSync(dir)) return [];
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(dir);
    const out: Array<{ id: string; filePath: string; header: SessionHeader }> = [];
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const full = join(dir, n);
      try {
        const sm = await SessionManager.load(full);
        const header = sm.entries[0] as SessionHeader;
        if (header?.type === 'session') {
          out.push({ id: header.id, filePath: full, header });
        }
      } catch {
        // skip broken
      }
    }
    return out.sort((a, b) => b.header.createdAt.localeCompare(a.header.createdAt));
  }

  private async loadFromDisk(): Promise<void> {
    if (!existsSync(this.filePath)) {
      throw new Error(`Session file not found: ${this.filePath}`);
    }
    const text = await readFile(this.filePath, 'utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SessionEntry;
        this.entries.push(entry);
      } catch {
        // skip malformed
      }
    }
    // Determine leaf: the entry with no children.
    const hasChild = new Set<string>();
    for (const e of this.entries) {
      if ('parentId' in e && e.parentId) {
        hasChild.add(e.parentId);
      }
    }
    const leaves = this.entries.filter((e) => 'id' in e && !hasChild.has(e.id));
    if (leaves.length > 0) {
      this.leafId = leaves[leaves.length - 1].id;
    }
    this.loaded = true;
  }

  async reload(): Promise<void> {
    this.entries = [];
    this.leafId = null;
    await this.loadFromDisk();
  }

  getEntries(): readonly SessionEntry[] {
    return this.entries;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  async appendUserMessage(content: unknown): Promise<string> {
    return this.append({
      type: 'message',
      id: makeId(),
      parentId: this.leafId,
      role: 'user',
      content,
      ts: new Date().toISOString(),
    });
  }

  async appendAssistantMessage(content: unknown): Promise<string> {
    return this.append({
      type: 'message',
      id: makeId(),
      parentId: this.leafId,
      role: 'assistant',
      content,
      ts: new Date().toISOString(),
    });
  }

  async appendToolMessage(content: unknown): Promise<string> {
    return this.append({
      type: 'message',
      id: makeId(),
      parentId: this.leafId,
      role: 'tool',
      content,
      ts: new Date().toISOString(),
    });
  }

  async appendModelChange(model: string, provider: string): Promise<string> {
    return this.append({
      type: 'model_change',
      id: makeId(),
      parentId: this.leafId,
      model,
      provider,
      ts: new Date().toISOString(),
    });
  }

  async appendCompact(summary: string, tokensBefore: number): Promise<string> {
    return this.append({
      type: 'compact',
      id: makeId(),
      parentId: this.leafId,
      summary,
      tokensBefore,
      ts: new Date().toISOString(),
    });
  }

  async appendLabel(label: string): Promise<string> {
    return this.append({
      type: 'label',
      id: makeId(),
      parentId: this.leafId,
      label,
      ts: new Date().toISOString(),
    });
  }

  async appendReflection(note: {
    note: string;
    tried: string;
    learned: string;
    nextHint: string;
    toolCallCount: number;
    hadErrors: boolean;
  }): Promise<string> {
    return this.append({
      type: 'reflection',
      id: makeId(),
      parentId: this.leafId,
      ts: new Date().toISOString(),
      ...note,
    });
  }

  async appendFork(label: string): Promise<string> {
    if (!this.leafId) throw new Error('No leaf to fork from');
    const forkPoint = this.leafId;
    return this.append({
      type: 'fork',
      id: makeId(),
      parentId: this.leafId,
      label,
      forkPoint,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Move the active leaf pointer to a different node in the tree.
   * This is what /tree and /fork use to navigate branches.
   */
  setLeaf(id: string): void {
    if (!this.entries.find((e) => 'id' in e && e.id === id)) {
      throw new Error(`No entry with id ${id}`);
    }
    this.leafId = id;
  }

  /**
   * Build the tree of entries rooted at the session header, with each
   * node's children sorted by timestamp. Returns the root node (header)
   * with nested children.
   */
  getTree(): TreeNode {
    const byParent = new Map<string | null, SessionEntry[]>();
    for (const e of this.entries) {
      const key = 'parentId' in e ? e.parentId : null;
      const arr = byParent.get(key) ?? [];
      arr.push(e);
      byParent.set(key, arr);
    }
    for (const arr of byParent.values()) {
      arr.sort((a, b) => ('ts' in a && 'ts' in b ? a.ts.localeCompare(b.ts) : 0));
    }
    const build = (entry: SessionEntry, depth: number): TreeNode => {
      const id = 'id' in entry ? entry.id : '';
      const children = (byParent.get(id) ?? []).map((c) => build(c, depth + 1));
      return { id, entry, children, depth };
    };
    const header = this.entries[0] as SessionHeader;
    return build(header, 0);
  }

  /** Find a specific node by id, or null. */
  findNode(id: string): TreeNode | null {
    const tree = this.getTree();
    const stack: TreeNode[] = [tree];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      for (const c of n.children) stack.push(c);
    }
    return null;
  }

  /**
   * Pretty-print the tree, one line per node, with branch glyphs.
   * v0.2 minimal: no color, no truncation.
   */
  renderTree(): string {
    const lines: string[] = [];
    const walk = (n: TreeNode, prefix: string, isLast: boolean): void => {
      const glyph = n.depth === 0 ? '' : isLast ? '└─ ' : '├─ ';
      const e = n.entry;
      const summary = renderNodeSummary(e);
      const marker = n.id === this.leafId ? ' ←' : '';
      lines.push(prefix + glyph + summary + marker);
      const childPrefix = prefix + (n.depth === 0 ? '' : isLast ? '   ' : '│  ');
      n.children.forEach((c, i) => walk(c, childPrefix, i === n.children.length - 1));
    };
    walk(this.getTree(), '', true);
    return lines.join('\n');
  }

  private async append(entry: SessionEntry): Promise<string> {
    if (!this.loaded) {
      throw new Error('Session not loaded; call create() or load() first.');
    }
    const id = (entry as { id: string }).id;
    this.entries.push(entry);
    this.leafId = id;
    await appendFile(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    return id;
  }
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[/\\:]/g, '-').replace(/^-+|-+$/g, '') || 'root';
}

function stripBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type: string; text?: string; thinking?: string }) => {
      if (b.type === 'text') return b.text ?? '';
      if (b.type === 'thinking') return b.thinking ?? '';
      if (b.type === 'tool_use') return `[tool ${(b as { name?: string }).name ?? '?'}]`;
      if (b.type === 'tool_result') return '[tool result]';
      return '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function renderNodeSummary(e: SessionEntry): string {
  switch (e.type) {
    case 'session':
      return `${e.id} (${e.model})`;
    case 'message':
      return `[${e.role}] ${truncate(stripBlocks(e.content), 60)}`;
    case 'reflection':
      return `⟳ reflection: ${truncate(e.learned, 50)}`;
    case 'fork':
      return `⑂ fork: ${e.label}`;
    case 'compact':
      return `⤓ compact (${e.tokensBefore} tokens)`;
    case 'model_change':
      return `⇄ → ${e.model}`;
    case 'label':
      return `★ ${e.label}`;
  }
}
