/**
 * Project state module (v3.1).
 *
 * Implements the Anthropic "long-running agents" pattern (Nov 2025):
 *   - `project.json`: project metadata + last known good state
 *   - `progress.md`: human-readable log of what each session did
 *   - `init.sh`: idempotent environment setup
 *
 * Three lifecycle modes:
 *   - `uninitialized` (no init.sh yet) → initializer agent runs first
 *   - `active` (initialized, has work) → coding agent picks up next feature
 *   - `complete` (all features.passes=true) → no-op
 *
 * All paths are absolute to avoid the cwd-relative issues the old
 * TUI had. We never write to cwd; we write to `~/.deqi/projects/<hash>/`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

// ─── Paths ──────────────────────────────────────────────────

const PROJECTS_ROOT = resolve(homedir(), '.deqi', 'projects');

/** Stable per-cwd project id (lowercase hex sha1, first 16 chars). */
export function projectIdForCwd(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 16);
}

export function projectDir(cwd: string): string {
  return join(PROJECTS_ROOT, projectIdForCwd(cwd));
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ─── Types ──────────────────────────────────────────────────

export type ProjectPhase = 'uninitialized' | 'active' | 'complete';

export interface ProjectFeature {
  id: string;
  category: 'functional' | 'non-functional';
  description: string;
  /** Concrete acceptance steps; the coding agent must run each. */
  steps: string[];
  /** Flipped to true only after all steps verified end-to-end. */
  passes: boolean;
  /** Set on the turn that flipped passes=true; for progress.md. */
  passedAt?: string;
  passedBySession?: string;
}

export interface ProjectState {
  version: 1;
  projectId: string;
  cwd: string;
  phase: ProjectPhase;
  createdAt: string;
  updatedAt: string;
  /** Single-line description of the project (set by initializer). */
  goal: string;
  features: ProjectFeature[];
  /** List of session ids that have touched this project, newest last. */
  sessions: string[];
  /** Index into `features` of the next one to work on. -1 = none. */
  nextFeatureIdx: number;
}

// ─── Load / save ────────────────────────────────────────────

const STATE_FILE = 'project.json';
const PROGRESS_FILE = 'progress.md';
const INIT_SCRIPT = 'init.sh';

export function loadProject(cwd: string): ProjectState | null {
  const file = join(projectDir(cwd), STATE_FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const obj = JSON.parse(raw) as ProjectState;
    if (obj.version !== 1) return null;
    return obj;
  } catch {
    return null;
  }
}

export function saveProject(state: ProjectState): void {
  ensureDir(projectDir(state.cwd));
  state.updatedAt = new Date().toISOString();
  const file = join(projectDir(state.cwd), STATE_FILE);
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Phase derivation ───────────────────────────────────────

/**
 * Derive the current phase from disk. Used at server start to
 * decide which prompt to use for the next session.
 */
export function derivePhase(cwd: string): ProjectPhase {
  const s = loadProject(cwd);
  if (!s) return 'uninitialized';
  if (s.phase === 'complete') return 'complete';
  if (s.features.length === 0) return 'uninitialized';
  if (s.features.every((f) => f.passes)) return 'complete';
  return 'active';
}

// ─── Progress.md append-only log ────────────────────────────

export function appendProgress(cwd: string, sessionId: string, lines: string[]): void {
  const dir = projectDir(cwd);
  ensureDir(dir);
  const file = join(dir, PROGRESS_FILE);
  const ts = new Date().toISOString();
  const header = `\n## ${ts} · session ${sessionId.slice(0, 8)}\n`;
  const body = lines.map((l) => `- ${l}`).join('\n') + '\n';
  // If file doesn't exist, add a top header.
  if (!existsSync(file)) {
    writeFileSync(file, `# progress\n\nPersistent log of agent work on this project. Most recent entries are at the bottom.\n`, 'utf-8');
  }
  writeFileSync(file, readFileSync(file, 'utf-8') + header + body, 'utf-8');
}

export function readProgress(cwd: string): string {
  const file = join(projectDir(cwd), PROGRESS_FILE);
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf-8');
}

// ─── init.sh (idempotent) ────────────────────────────────────

export function writeInitScript(cwd: string, body: string): void {
  const dir = projectDir(cwd);
  ensureDir(dir);
  const file = join(dir, INIT_SCRIPT);
  writeFileSync(file, body, 'utf-8');
}

export function readInitScript(cwd: string): string | null {
  const file = join(projectDir(cwd), INIT_SCRIPT);
  if (!existsSync(file)) return null;
  return readFileSync(file, 'utf-8');
}

// ─── Project lifecycle helpers ──────────────────────────────

/** Initialize a fresh project from a user goal. Idempotent. */
export function initProject(cwd: string, goal: string, features: Omit<ProjectFeature, 'passes' | 'passedAt' | 'passedBySession'>[]): ProjectState {
  const existing = loadProject(cwd);
  if (existing) return existing;
  const now = new Date().toISOString();
  const builtFeatures: ProjectFeature[] = features.map((f, i) => ({
    id: f.id ?? `feat_${String(i + 1).padStart(3, '0')}`,
    category: f.category,
    description: f.description,
    steps: f.steps,
    passes: false,
  }));
  const state: ProjectState = {
    version: 1,
    projectId: projectIdForCwd(cwd),
    cwd,
    phase: 'active',
    createdAt: now,
    updatedAt: now,
    goal,
    features: builtFeatures,
    sessions: [],
    nextFeatureIdx: builtFeatures.findIndex((f) => !f.passes),
  };
  saveProject(state);
  return state;
}

/**
 * Pick the next feature for a coding agent to work on. Returns null
 * if everything is done. Skips features already passing.
 */
export function pickNextFeature(state: ProjectState): ProjectFeature | null {
  return state.features.find((f) => !f.passes) ?? null;
}

/**
 * Mark a feature as passing. Updates updatedAt. Adds the session
 * to the project's session log.
 */
export function markFeaturePass(state: ProjectState, featureId: string, sessionId: string): void {
  const f = state.features.find((x) => x.id === featureId);
  if (!f || f.passes) return;
  f.passes = true;
  f.passedAt = new Date().toISOString();
  f.passedBySession = sessionId;
  if (!state.sessions.includes(sessionId)) state.sessions.push(sessionId);
  if (state.features.every((x) => x.passes)) {
    state.phase = 'complete';
  }
  state.nextFeatureIdx = state.features.findIndex((x) => !x.passes);
  saveProject(state);
}

export { PROJECTS_ROOT };
