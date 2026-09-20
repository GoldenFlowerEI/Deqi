/**
 * v3.7: active memory auto-retrieval (Hermes-inspired).
 *
 * At the start of every Agent.run() (first turn only, debounced),
 * the harness pulls top-N relevant facts/patterns from the memory
 * store and injects them as a `## Retrieved memory` block in the
 * system prompt (or the next user message — the integration site
 * decides).
 *
 * v3.7 scoring: simple keyword overlap (lowercase + word split +
 * Jaccard-like). No embeddings yet (deferred). The score is
 * computed from:
 *   - fact.value + fact.key  (for facts)
 *   - pattern.trigger + pattern.recipe joined  (for patterns)
 *   - pref.key + pref.value  (for prefs, low weight — prefs are
 *     usually global, not query-specific)
 *
 * The "active forgetting" principle: we bump useCount on each
 * retrieved item so frequently-relevant items bubble up over time.
 */

import { readFacts, readPatterns, readPrefs, writeFacts, writePatterns, writePrefs, type Fact, type TaskPattern, type Pref } from './memory.js';

export interface RetrievalResult {
  facts: Fact[];
  patterns: TaskPattern[];
  prefs: Pref[];
  query: string;
}

/** Tokenize: lowercase, split on non-word, dedup, drop stop words. */
const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'this', 'that', 'it', 'its', 'if', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'i', 'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your', 'their']);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_-]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w));
}

/** Jaccard similarity: |A ∩ B| / |A ∪ B| */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function scoreText(queryTokens: Set<string>, haystack: string): number {
  if (haystack.length === 0) return 0;
  const hayTokens = new Set(tokenize(haystack));
  return jaccard(queryTokens, hayTokens);
}

/**
 * Retrieve top-N relevant items from the memory store.
 * Bumps useCount on retrieved items (so frequently-relevant items
 * bubble up). Returns the matches; the caller decides how to
 * surface them.
 */
export function retrieveRelevant(
  query: string,
  options: { factLimit?: number; patternLimit?: number; prefLimit?: number } = {},
): RetrievalResult {
  const factLimit = options.factLimit ?? 3;
  const patternLimit = options.patternLimit ?? 2;
  const prefLimit = options.prefLimit ?? 1;
  const queryTokens = new Set(tokenize(query));

  const allFacts = readFacts();
  const allPatterns = readPatterns();
  const allPrefs = readPrefs();

  // Score
  const factScores = allFacts
    .map((f) => ({ f, score: scoreText(queryTokens, `${f.key} ${f.value}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, factLimit);
  const patternScores = allPatterns
    .map((p) => ({ p, score: scoreText(queryTokens, `${p.trigger} ${p.recipe.join(' ')}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, patternLimit);
  // Prefs are global; only include if they explicitly match
  const prefScores = allPrefs
    .map((p) => ({ p, score: scoreText(queryTokens, `${p.key} ${p.value}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, prefLimit);

  const facts = factScores.map((x) => x.f);
  const patterns = patternScores.map((x) => x.p);
  const prefs = prefScores.map((x) => x.p);

  // Bump useCount + lastUsedAt for retrieved items (active reinforcement)
  const now = new Date().toISOString();
  if (facts.length > 0) {
    const updated = allFacts.map((f: Fact) =>
      facts.some((r) => r.id === f.id)
        ? { ...f, useCount: f.useCount + 1, lastUsedAt: now }
        : f,
    );
    writeFacts(updated);
  }
  if (patterns.length > 0) {
    const updated = allPatterns.map((p: TaskPattern) =>
      patterns.some((r) => r.id === p.id)
        ? { ...p, useCount: p.useCount + 1, lastUsedAt: now }
        : p,
    );
    writePatterns(updated);
  }
  if (prefs.length > 0) {
    const updated = allPrefs.map((p: Pref) =>
      prefs.some((r) => r.key === p.key)
        ? { ...p, setAt: now }
        : p,
    );
    writePrefs(updated);
  }

  return { facts, patterns, prefs, query };
}

/** Render the retrieved items as a markdown block for the system prompt. */
export function renderRetrievedMemory(r: RetrievalResult): string {
  if (r.facts.length === 0 && r.patterns.length === 0 && r.prefs.length === 0) {
    return '';
  }
  const lines: string[] = [];
  lines.push('## Retrieved memory (auto-pulled for this turn)');
  if (r.facts.length > 0) {
    lines.push('');
    lines.push('### Facts');
    for (const f of r.facts) {
      lines.push(`- **${f.category}** ${f.key} = ${f.value}  _(used ${f.useCount}x)_`);
    }
  }
  if (r.patterns.length > 0) {
    lines.push('');
    lines.push('### Patterns');
    for (const p of r.patterns) {
      lines.push(`- **trigger**: ${p.trigger}`);
      for (const step of p.recipe) lines.push(`  - ${step}`);
    }
  }
  if (r.prefs.length > 0) {
    lines.push('');
    lines.push('### Prefs');
    for (const p of r.prefs) {
      lines.push(`- ${p.key} = ${p.value}`);
    }
  }
  return lines.join('\n');
}
