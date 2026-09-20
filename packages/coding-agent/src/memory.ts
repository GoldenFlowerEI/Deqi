/**
 * v3.2: Three-layer long-term memory.
 *
 * Inspired by Generative Agents (Park 2023) + RAMPART (2026) + the
 * Anthropic memory model. The pattern is:
 *
 *   facts.json    — small, stable, low churn (env, paths, integrations)
 *   prefs.json    — user preferences (model, tone, schedule)
 *   patterns.json — recurring task patterns the user often asks for
 *   skills/       — directory of reusable sub-workflows (SKILL.md + run.sh)
 *
 * The "active forgetting" principle: memory should decay unless
 * reinforced. We tag every fact/pattern with a `lastUsedAt` and
 * `useCount`; future sessions will down-rank untouched entries.
 * The TODO is to actually do the decay — for v3.2 we just record
 * the metadata so v3.3 can act on it.
 *
 * Cross-session: this module is the source of truth. The `memory`
 * tool (v3.2) reads/writes here. The system prompt (v3.1 builder)
 * retrieves top-K relevant facts at session start.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const MEMORY_ROOT = resolve(homedir(), '.deqi', 'memory');
const FACTS_FILE = 'facts.json';
const PREFS_FILE = 'prefs.json';
const PATTERNS_FILE = 'patterns.json';
const SKILLS_DIR = 'skills';

// ─── Types ──────────────────────────────────────────────────

export interface Fact {
  id: string;
  /** 'env' | 'path' | 'integration' | 'user' | 'project' */
  category: 'env' | 'path' | 'integration' | 'user' | 'project';
  key: string;
  value: string;
  createdAt: string;
  lastUsedAt: string;
  useCount: number;
  /** Optional confidence 0..1. Future use. */
  confidence?: number;
}

export interface Pref {
  key: string;
  value: string;
  setAt: string;
}

export interface TaskPattern {
  id: string;
  /** Free-text description of when this pattern applies. */
  trigger: string;
  /** What to do — usually a plan / steps outline. */
  recipe: string[];
  useCount: number;
  lastUsedAt: string;
}

export interface FactsFile {
  version: 1;
  facts: Fact[];
}

export interface PrefsFile {
  version: 1;
  prefs: Pref[];
}

export interface PatternsFile {
  version: 1;
  patterns: TaskPattern[];
}

// ─── Helpers ───────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

function genId(): string {
  return randomBytes(4).toString('hex');
}

// ─── Facts ─────────────────────────────────────────────────

export function readFacts(): Fact[] {
  const file = join(MEMORY_ROOT, FACTS_FILE);
  return readJson<FactsFile>(file, { version: 1, facts: [] }).facts;
}

export function writeFacts(facts: Fact[]): void {
  const file = join(MEMORY_ROOT, FACTS_FILE);
  writeJson(file, { version: 1, facts });
}

export function addFact(category: Fact['category'], key: string, value: string): Fact {
  const facts = readFacts();
  // Idempotent on key+category: update the existing fact rather than duplicating.
  const existing = facts.find((f) => f.category === category && f.key === key);
  const now = new Date().toISOString();
  if (existing) {
    existing.value = value;
    existing.lastUsedAt = now;
    existing.useCount += 1;
    writeFacts(facts);
    return existing;
  }
  const f: Fact = {
    id: genId(),
    category,
    key,
    value,
    createdAt: now,
    lastUsedAt: now,
    useCount: 1,
  };
  facts.push(f);
  writeFacts(facts);
  return f;
}

export function findFact(category: Fact['category'], key: string): Fact | null {
  return readFacts().find((f) => f.category === category && f.key === key) ?? null;
}

export function searchFacts(query: string, limit = 10): Fact[] {
  const q = query.toLowerCase();
  const all = readFacts();
  const hits = all
    .map((f) => {
      const hay = `${f.category} ${f.key} ${f.value}`.toLowerCase();
      const score = q.split(/\s+/).filter(Boolean).reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      return { f, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (hits.length === 0) return [];
  // Bump useCount + lastUsedAt on the matched facts (so future
  // searches naturally rank actively-used facts higher) and
  // PERSIST the bump.
  const now = new Date().toISOString();
  for (const { f } of hits) {
    f.lastUsedAt = now;
    f.useCount += 1;
  }
  writeFacts(all);
  return hits.map((x) => x.f);
}

export function deleteFact(id: string): void {
  const facts = readFacts().filter((f) => f.id !== id);
  writeFacts(facts);
}

// ─── Prefs ─────────────────────────────────────────────────

export function readPrefs(): Pref[] {
  const file = join(MEMORY_ROOT, PREFS_FILE);
  return readJson<PrefsFile>(file, { version: 1, prefs: [] }).prefs;
}

export function writePrefs(prefs: Pref[]): void {
  const file = join(MEMORY_ROOT, PREFS_FILE);
  writeJson(file, { version: 1, prefs });
}

export function setPref(key: string, value: string): Pref {
  const prefs = readPrefs();
  const existing = prefs.find((p) => p.key === key);
  if (existing) {
    existing.value = value;
    existing.setAt = new Date().toISOString();
    writePrefs(prefs);
    return existing;
  }
  const p: Pref = { key, value, setAt: new Date().toISOString() };
  prefs.push(p);
  writePrefs(prefs);
  return p;
}

export function getPref(key: string): string | null {
  return readPrefs().find((p) => p.key === key)?.value ?? null;
}

// ─── Patterns ──────────────────────────────────────────────

export function readPatterns(): TaskPattern[] {
  const file = join(MEMORY_ROOT, PATTERNS_FILE);
  return readJson<PatternsFile>(file, { version: 1, patterns: [] }).patterns;
}

export function writePatterns(patterns: TaskPattern[]): void {
  const file = join(MEMORY_ROOT, PATTERNS_FILE);
  writeJson(file, { version: 1, patterns });
}

export function addPattern(trigger: string, recipe: string[]): TaskPattern {
  const patterns = readPatterns();
  // Idempotent on trigger: if we already have it, bump useCount.
  const existing = patterns.find((p) => p.trigger === trigger);
  if (existing) {
    existing.recipe = recipe.length ? recipe : existing.recipe;
    existing.useCount += 1;
    existing.lastUsedAt = new Date().toISOString();
    writePatterns(patterns);
    return existing;
  }
  const p: TaskPattern = {
    id: genId(),
    trigger,
    recipe,
    useCount: 1,
    lastUsedAt: new Date().toISOString(),
  };
  patterns.push(p);
  writePatterns(patterns);
  return p;
}

export function searchPatterns(query: string, limit = 5): TaskPattern[] {
  const q = query.toLowerCase();
  const all = readPatterns();
  const hits = all
    .map((p) => {
      const hay = `${p.trigger} ${p.recipe.join(' ')}`.toLowerCase();
      const score = q.split(/\s+/).filter(Boolean).reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (hits.length === 0) return [];
  const now = new Date().toISOString();
  for (const { p } of hits) {
    p.useCount += 1;
    p.lastUsedAt = now;
  }
  writePatterns(all);
  return hits.map((x) => x.p);
}

// ─── Skills (directory of SKILL.md + optional run.sh) ─────

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  hasRun: boolean;
}

export function readSkills(): SkillMeta[] {
  const dir = join(MEMORY_ROOT, SKILLS_DIR);
  if (!existsSync(dir)) return [];
  const out: SkillMeta[] = [];
  for (const name of readdirSync(dir)) {
    const sd = join(dir, name);
    try {
      if (!statSync(sd).isDirectory()) continue;
    } catch { continue; }
    const skillMd = join(sd, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const text = readFileSync(skillMd, 'utf-8');
    const desc = text.split('\n').find((l) => l.startsWith('description:'))?.replace(/^description:\s*/, '')?.trim() ?? '';
    out.push({ name, description: desc, dir: sd, hasRun: existsSync(join(sd, 'run.sh')) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function readSkill(name: string): { meta: SkillMeta; body: string } | null {
  const meta = readSkills().find((s) => s.name === name);
  if (!meta) return null;
  return { meta, body: readFileSync(join(meta.dir, 'SKILL.md'), 'utf-8') };
}

export function writeSkill(name: string, body: string, runScript?: string): SkillMeta {
  const sd = join(MEMORY_ROOT, SKILLS_DIR, name);
  ensureDir(sd);
  writeFileSync(join(sd, 'SKILL.md'), body, 'utf-8');
  if (runScript !== undefined) {
    writeFileSync(join(sd, 'run.sh'), runScript, 'utf-8');
  }
  return { name, description: '', dir: sd, hasRun: existsSync(join(sd, 'run.sh')) };
}

export { MEMORY_ROOT };

// ─── v3.9: bundled skills ─────────────────────────────────────────

export interface BundledSkill {
  name: string;
  description: string;
  body: string;
}

/**
 * Pre-installed skills shipped with the package. Inlined here
 * (not loaded from a JSON file) so they survive the tsc build
 * without a postbuild copy step. On first run the server copies
 * any that are missing into `~/.deqi/memory/skills/<name>/SKILL.md`.
 * User-edited skills are NEVER overwritten (we only write to a
 * missing dir). Modeled on common Deqi workflows: commit, release,
 * test, lint.
 */
const BUNDLED_SKILLS: BundledSkill[] = [
  {
    name: 'commit-message',
    description: 'Generate a conventional-commit message from the staged diff.',
    body: [
      '# commit-message',
      '',
      'Generate a `type(scope): summary` conventional-commit message from the current `git diff --staged`.',
      '',
      'Steps:',
      '1. Run `git diff --staged --stat` to see what is in this commit.',
      '2. Run `git diff --staged` to see the full diff.',
      '3. Classify: feat | fix | refactor | docs | test | chore | build | ci | perf | style.',
      '4. Pick a `scope` from the touched paths (or omit if cross-cutting).',
      '5. Write a one-line summary (50 chars max, no period) and a wrapped body explaining WHY.',
      '6. Show the message to the user, then run `git commit -F-` with the message on stdin (after explicit OK).',
      '',
      'Edge cases:',
      '- Empty staged diff → say so, ask what to stage.',
      '- Multiple unrelated changes → suggest splitting into multiple commits.',
      '- Breaking change → add `BREAKING CHANGE:` footer with a migration note.',
    ].join('\n'),
  },
  {
    name: 'release',
    description: 'Cut a release: bump version, update CHANGELOG, tag, push, post a release note.',
    body: [
      '# release',
      '',
      'Cut a release: bump version, update CHANGELOG.md, create a git tag, push to remote, post a release note.',
      '',
      'Steps:',
      '1. Confirm the release version with the user. Default: bump the minor version (X.Y.Z → X.(Y+1).0).',
      '2. Find every package.json in the repo and bump the version field. Use `edit`, not `write`.',
      '3. Update CHANGELOG.md: add a new section with the bumped version, today\'s date, and a bullet list of commits since the last tag (`git log v<prev>..HEAD --oneline`).',
      '4. Run `git add -A && git commit -m \'release: v<X.Y.Z>\'`.',
      '5. Run `git tag -a v<X.Y.Z> -m \'v<X.Y.Z>\'`.',
      '6. Run `git push --follow-tags`.',
      '7. If a Slack/Discord webhook is configured, post a release note. Otherwise just report the new version + tag to the user.',
      '',
      'Edge cases:',
      '- Uncommitted changes → commit them first or ask.',
      '- Detached HEAD → ask the user which branch to release from.',
      '- Existing tag at the same version → bump again.',
    ].join('\n'),
  },
  {
    name: 'test',
    description: 'Detect the test command, run it, and report pass/fail counts.',
    body: [
      '# test',
      '',
      'Detect and run the project\'s test suite. Report pass/fail counts and surface failures.',
      '',
      'Steps:',
      '1. Detect: read package.json `scripts.test` (Node), look for pytest/tox/nox (Python), look for `go test ./...`, `cargo test`, `make test`, etc.',
      '2. If nothing detected, ask the user which test command to run.',
      '3. Run the command with `bash`. Use a 5-minute timeout for fast suites, 30-minute for full.',
      '4. Parse the output for pass/fail counts (most runners print them).',
      '5. If there are failures, capture the first 5 in full and summarize the rest.',
      '6. Report: total, pass, fail, skip, duration, and the top 5 failure signatures.',
      '',
      'Edge cases:',
      '- No test framework detected → say so and suggest a setup.',
      '- Tests crash the runner → report the crash separately from test failures.',
      '- Long output → tail the last 200 lines + the first 20 lines.',
    ].join('\n'),
  },
  {
    name: 'lint',
    description: "Run the project's linter and apply auto-fixes when possible.",
    body: [
      '# lint',
      '',
      "Run the project's linter and apply auto-fixes for safe rules.",
      '',
      'Steps:',
      '1. Detect: read package.json for eslint/biome/prettier, look for .ruff.toml / pyproject.toml [tool.ruff], .golangci.yml, etc.',
      '2. Run the lint command. For ESLint/Biome, prefer `lint --fix` so safe fixes are auto-applied.',
      '3. For each remaining error, summarize the file:line and the rule, then ask the user before manually editing.',
      '4. If no errors: report the run was clean and stop.',
      '5. If errors: offer to fix them one by one. Do not mass-edit without explicit OK.',
      '',
      'Edge cases:',
      '- No linter configured → suggest installing one (biome is the fastest).',
      '- Lint command fails to even start (missing dep) → report the missing dep.',
      '- Hundreds of errors → batch them by rule and offer a per-rule fix plan instead of one-by-one.',
    ].join('\n'),
  },
  // ─── v5.1: product-management skills ─────────────────────────────
  // v5.0 added the "principles-only" system prompt. v5.1 adds the
  // operational layer: real PM workflow skills that ship with the
  // package (not just land in ~/.deqi/memory/skills on one machine).
  // These four are the starting set; more can be appended later.
  {
    name: 'product-prioritization',
    description: 'Score a feature list with RICE + MoSCoW + Kano. Output a ranked table with rationale.',
    body: [
      '# product-prioritization',
      '',
      'Score a feature list with **RICE**, then sanity-check with **MoSCoW**, and surface the *latent* needs with **Kano**. Output a single ranked table with rationale.',
      '',
      'When to use:',
      '- The user has 3+ candidate features and needs to pick what to build next.',
      '- A roadmap conversation is happening and someone says "should we do X or Y first?"',
      '- A stakeholder asks "why this and not that?" — you need a defensible answer.',
      '',
      'When NOT to use:',
      '- The list has fewer than 3 items — just gut-rank them.',
      '- The user is asking about a single decision (use prd-template instead).',
      '- The decision is architectural and irreversible (use a tech design doc, not a priority list).',
      '',
      'Steps:',
      '1. **Confirm the goal.** Ask the user to state the current quarter\'s North Star metric in one sentence. If they can\'t, ask "what would make the next 30 days feel like a win?" and use that.',
      '2. **List the candidates.** Pull from the user\'s input, or scan the open issues / recent memory / this conversation. Cap at 15.',
      '3. **RICE score each (per quarter, not per year):**',
      '   - **R** each *t*oday: how many real users will hit this in the next 90 days? (Reach)',
      '   - **I** how much does it move the goal? 3 = transformational, 2 = meaningful, 1 = incremental, 0.5 = nice-to-have, 0.25 = barely measurable. (Impact)',
      '   - **C** onfidence: how sure are you of R and I? 100% = you have data, 80% = reasonable estimate, 50% = gut feel. (Confidence)',
      '   - **E** ffort: person-weeks for one engineer to ship end-to-end (including tests, docs, edge cases). Be honest — round up. (Effort)',
      '   - Score = (R × I × C) / E. Higher is better.',
      '4. **Sanity-check with MoSCoW.** For each item, force a category: Must / Should / Could / Won\'t. MoSCoW is intentionally a discussion trigger, not a math step. Push back on the user if the RICE ranking disagrees with the MoSCoW category — usually one of the inputs is wrong.',
      '5. **Kano pass.** Tag each item with one of: Basic (must have, no delight), Performance (more is better, linear), Excitement (unexpected, high delight), Indifferent (nobody cares), Reverse (some users actively dislike). If something scores high on RICE but is tagged Reverse, raise the flag.',
      '6. **Output a single Markdown table** sorted by RICE score. Columns: Feature, R, I, C, E, Score, MoSCoW, Kano, Why-now. The "Why-now" column is mandatory — if you can\'t write it, the item probably doesn\'t belong on the list.',
      '7. **Recommend the top 3** in prose. The recommendation is the deliverable, not the table.',
      '',
      'Edge cases:',
      '- Tied scores → tiebreaker = Kano Excitement > Performance > Basic. (A delight feature that ties a basic one goes first.)',
      '- User rejects the recommendation → ask which input was wrong, don\'t re-run the math.',
      '- 1-2 items dominate with RICE ≥ 5x the median → they probably aren\'t the same *kind* of work; ask the user if they should be one feature or two.',
      '- "I don\'t have data for R" → drop to confidence=50%, score anyway. The framework is more useful than the data.',
      '- Features that depend on each other → list the dependency in the "Why-now" column and score the smaller one first.',
    ].join('\n'),
  },
  {
    name: 'prd-template',
    description: 'Write a one-page PRD defensible in a 15-min review with eng + design + stakeholder.',
    body: [
      '# prd-template',
      '',
      'Write a one-page PRD for a single feature. The page must be defensible in a 15-minute review with a senior engineer, a designer, and a stakeholder. If it can\'t survive that, it\'s not ready.',
      '',
      'When to use:',
      '- A feature is moving from "idea" to "scoping" — before any design or build work starts.',
      '- The user is going to write multiple PRDs in a row and wants a consistent format.',
      '- A stakeholder says "what does the team actually plan to ship?" — they want a PRD, not a one-pager.',
      '',
      'When NOT to use:',
      '- A bug fix or incident response (use the bug template / postmortem instead).',
      '- An experiment hypothesis (use ab-test-design).',
      '- A research spike / exploration task (use the doc-as-you-go style, not this template).',
      '',
      'Steps:',
      '1. **Title** — one noun phrase. "Recursive Recipe Library", not "Add a way to share recipes".',
      '2. **Problem** (3 sentences max) — *what* is wrong or missing, for *whom*, and *how often*. If you can\'t quantify the "how often" with a number or an example, you\'re not done.',
      '3. **For whom** — 1-3 user archetypes. Use the names from the user-model layer or your own research; not "all users". One-line job-to-be-done for each.',
      '4. **Goal / non-goals** — one measurable goal, 2-4 non-goals. Non-goals are more important than goals: they\'re what you\'re *not* spending the next 6 weeks on.',
      '5. **User experience** (1 paragraph) — walk through the primary flow as a user would see it. Reference the desktop / web / CLI surface it touches. If it spans multiple surfaces, name the entry point.',
      '6. **Acceptance criteria** (5-10 bullets) — each is a single, testable statement. Use the pattern "WHEN <action> THEN <observable outcome>". If a bullet has an "and", split it.',
      '7. **North Star + counter-metrics** — one number that should move (the goal), one number that should NOT move (the guardrail). Counter-metrics are how you catch "we shipped it and broke trust".',
      '8. **Open questions** — every assumption the team hasn\'t validated yet, with an owner or a deadline. If there are zero open questions, the PRD is probably either trivial or premature.',
      '9. **Rollout** — gradual (10% / 50% / 100%) or all-at-once? Feature flag? Reversible if we ship a bad version?',
      '10. **Out of scope (v1)** — features that came up while writing the PRD but are explicitly deferred. Listing them prevents the meeting-loop where the same idea comes back next week.',
      '',
      'Edge cases:',
      '- PRD > 1 page → cut. Move long discussion to a linked appendix.',
      '- "Out of scope" growing > 5 items → the scope is too big. Split the PRD.',
      '- No counter-metric → ask "if this shipped and the goal moved, what else might also have moved?" until something breaks.',
      '- The "for whom" includes a user you haven\'t talked to → add an open question for that.',
      '- Acceptance criteria that read like design specs ("uses a blue button") → rewrite as outcomes ("the user can complete X in Y seconds").',
    ].join('\n'),
  },
  {
    name: 'competitor-scan',
    description: 'Build a structured comparison of the last 30 days from N direct competitors (changelogs, blogs).',
    body: [
      '# competitor-scan',
      '',
      'Build a structured comparison of the last 30 days of public changes from N direct competitors. Use `delegate` or `subagent` to scrape changelogs in parallel, then synthesize into a single table.',
      '',
      'When to use:',
      '- The user says "what are Cursor / Claude Code / Aider / goose doing this month?"',
      '- A roadmap decision depends on a competitor catching up to (or pulling away from) us on a specific axis.',
      '- Quarterly planning: "where are we gaining, where are we losing?"',
      '',
      'When NOT to use:',
      '- You need a deep architecture review of one competitor (read their code instead).',
      '- The user wants marketing positioning (this is engineering signal, not copy).',
      '- The competitor\'s changelog is private / paywalled (use a different research method).',
      '',
      'Steps:',
      '1. **Pick the competitors.** Default: 4-6 direct competitors in the same product category. For an AI coding agent, default set is: Claude Code, Cursor, Cline, Aider, Continue, goose, Codex CLI. Edit if the user specifies a narrower/wider set.',
      '2. **Pick the sources.** Default per competitor:',
      '   - GitHub releases / CHANGELOG.md',
      '   - Official blog (if any)',
      '   - Their public docs (for behavior changes, not just version bumps)',
      '3. **Spawn one subagent per competitor** in parallel using `delegate` with `maxConcurrency = 4`. Each subagent\'s prompt: "Fetch the last 30 days of changes from <source>. Return a bulleted list: date, change, link, impact category (perf / UX / new feature / pricing / deprecation)."',
      '4. **Wait for the synthesis.** The main agent collects the 4-6 bulleted lists, deduplicates overlap (e.g. multiple competitors shipping "MCP support" the same week), and builds a single Markdown table.',
      '5. **Add the Deqi column.** Look at our own recent memory entries / MEMORY.md / git log for the last 30 days; for each competitor row, mark whether we shipped something equivalent. This is the "are we keeping up" signal.',
      '6. **Output the table.** Columns: Date, Competitor, Change, Link, Impact, Deqi-equivalent (Y/N/Partial/WIP). Sort by date desc.',
      '7. **Surface the 3 patterns** in prose: "the entire category is shipping X this month" / "competitor Y is the only one with Z" / "we\'re 2-3 weeks behind on W". The patterns are the deliverable, not the table.',
      '',
      'Edge cases:',
      '- Competitor has no public changelog → fall back to GitHub release tags + commit log on their main repo. Note the source quality in the row.',
      '- Subagent fails to fetch (rate-limit / 404) → retry once with a different source, then mark the row "data unavailable" and move on. Don\'t fail the whole scan.',
      '- 30-day window is too short for a slow-moving competitor → extend to 90 days for them, note the window in the table header.',
      '- Two competitors ship the same thing on the same day → deduplicate but keep both as separate rows for the "pattern" signal.',
      '- A change is mentioned in 3 different sources with different wording → pick the most concrete (the GitHub release notes, not the marketing blog).',
    ].join('\n'),
  },
  {
    name: 'user-story',
    description: 'Break a feature into small user stories with Gherkin acceptance criteria. S/M/L estimates.',
    body: [
      '# user-story',
      '',
      'Take a feature description and break it into small user stories. Each story fits in one sprint, has a clear acceptance test, and is independent of the others where possible. Use the "As a / I want / so that" + Gherkin (Given/When/Then) format.',
      '',
      'When to use:',
      '- The user has a PRD (or the prd-template output) and wants to break it into shippable units.',
      '- Sprint planning: "we agreed to build X, what are the stories?"',
      '- A junior engineer is going to pick up a story tomorrow and needs enough context to start.',
      '',
      'When NOT to use:',
      '- The feature is one PR (just write the PR description, not stories).',
      '- The work is research / exploration (stories don\'t help; use a spike doc).',
      '- The user is going to do the work themselves this afternoon (a TODO list is enough).',
      '',
      'Steps:',
      '1. **Read the source.** PRD, conversation, or `prd-template` output. If none, ask the user to describe the feature in 2-3 sentences before continuing.',
      '2. **List the user roles.** Pull from the PRD\'s "for whom" section. If absent, list 1-3 roles. Each story belongs to exactly one role.',
      '3. **Walk the primary flow.** Trace the happy path end-to-end as the user would experience it. Mark the moments where the user makes a decision, sees new information, or transitions between surfaces (web → desktop → mobile).',
      '4. **Split at decision points.** A story is too big if it crosses 2+ decision points. Split there. A story is too small if it\'s purely mechanical and doesn\'t have a testable outcome.',
      '5. **Write each story** in this format:',
      '   - **Title** — verb-led. "User installs a recipe from a registry", not "Recipe install".',
      '   - **As a** [role] **I want** [action] **so that** [outcome].',
      '   - **Acceptance criteria** (3-6 Gherkin scenarios):',
      '     - **Given** [precondition]',
      '     - **When** [action]',
      '     - **Then** [observable outcome]',
      '   - **Out of scope** — 1-3 bullets, so the engineer doesn\'t expand the story mid-sprint.',
      '   - **Estimate** — S/M/L. If you can\'t estimate it, the story is too vague.',
      '6. **Reorder by dependency.** Stories at the top of the list are unblocks for the ones below. If two stories have no dependency, note them as "parallelizable".',
      '7. **Output as a single Markdown document** with one H2 per story.',
      '',
      'Edge cases:',
      '- Story > 3 days of work → split, or note it as "spike" and book a separate design doc.',
      '- Story has no clear "so that" → the user benefit is unclear; ask the user "if this didn\'t exist, what would the user do today instead?" The answer is the so-that.',
      '- Acceptance criteria are all positive ("when X then works") → add at least one negative ("when Y then shows an error and doesn\'t crash").',
      '- A story only matters after another story ships → mark it as "post-MVP" and move to a separate backlog section in the doc.',
      '- Same role has 5+ stories → check if the role is too broad; "developer" should probably be split into "first-time user" / "power user" / "admin".',
      '- Estimate is L for > 30% of stories → the design is too vague. Step back to a design doc.',
    ].join('\n'),
  },
];

export function installBundledSkills(opts: { force?: boolean } = {}): { installed: string[]; skipped: string[] } {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const s of BUNDLED_SKILLS) {
    const dir = join(MEMORY_ROOT, SKILLS_DIR, s.name);
    const md = join(dir, 'SKILL.md');
    if (existsSync(md) && !opts.force) {
      skipped.push(s.name);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(md, s.body, 'utf-8');
    installed.push(s.name);
  }
  return { installed, skipped };
}
