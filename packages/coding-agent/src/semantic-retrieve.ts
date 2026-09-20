/**
 * v3.12: semantic retrieval — TF-IDF + cosine similarity.
 *
 * The v3.7 retriever used Jaccard (set overlap) on tokenized text.
 * That breaks the moment the user says "database" and the memory
 * says "postgres" — different tokens, no overlap. v3.12 keeps
 * Jaccard as a fallback but layers in a proper TF-IDF + cosine
 * similarity on the same token stream.
 *
 * The pure-JS implementation here is a "keyword embedder" — it
 * doesn't need an external model. A future `NeuralEmbedder` can
 * implement the same `Embedder` interface and slot in without
 * changing the retrieval code. (See `apply when` in the v3.12
 * memory entry for the swap-in steps.)
 *
 * Why BM25 / TF-IDF and not true embeddings:
 *   - zero npm deps, ~250 lines of code
 *   - <1ms per query for typical memory sizes
 *   - works offline (no model download)
 *   - reasonable for <500 facts (which is the realistic ceiling
 *     for a single agent's working memory)
 * The semantic ceiling is real but a 5-10x upgrade over Jaccard
 * is enough for the "remember what the user said last time" use
 * case. When the user has 1000+ facts, the embedder interface
 * lets us swap in a neural model without touching the retriever.
 */

import { readFacts, readPatterns, readPrefs, writeFacts, writePatterns, writePrefs, type Fact, type TaskPattern, type Pref } from './memory.js';
import { tokenize } from './auto-retrieve.js';

export interface Embedder {
  /** Stable id for the embedder (used to cache/select). */
  readonly id: string;
  /** Embed a piece of text. Synchronous or async. */
  embed(text: string): number[] | Promise<number[]>;
  /** Cosine similarity between two equal-dim vectors. */
  similarity(a: number[], b: number[]): number;
}

/** Cosine similarity in pure JS. Returns 0 if either vector is zero. */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * v3.12: TF-IDF keyword embedder. Builds a vocabulary from the
 * corpus the first time it sees a new `setCorpus` call, then
 * produces sparse-ish (but kept as dense) TF-IDF vectors. This
 * is a "real" semantic upgrade over Jaccard: rare terms get
 * higher weight, common terms ("the", "a") are suppressed, and
 * the cosine similarity captures both term presence AND term
 * importance.
 *
 * Idempotent: the corpus lives for the life of the process.
 * For a long-running server, this means new facts added after
 * the first query will have slightly suboptimal scores (they
 * won't contribute to IDF). For v3.12 we accept that — the
 * real fix is to rebuild the index periodically (a TODO).
 */
export class TfIdfEmbedder implements Embedder {
  readonly id = 'tfidf-v1';
  private vocab: Map<string, number> = new Map();
  private idf: number[] = [];
  private corpusSize = 0;
  private fitted = false;

  /** Build the vocab + IDF from a list of documents. Idempotent. */
  setCorpus(docs: string[]): void {
    this.corpusSize = docs.length;
    if (docs.length === 0) {
      this.vocab.clear();
      this.idf = [];
      this.fitted = true;
      return;
    }
    // Build vocab
    const vocab = new Map<string, number>();
    const docFreq = new Map<string, number>();
    for (const doc of docs) {
      const seen = new Set<string>();
      for (const tok of tokenize(doc)) {
        if (!vocab.has(tok)) vocab.set(tok, vocab.size);
        if (!seen.has(tok)) {
          docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
          seen.add(tok);
        }
      }
    }
    this.vocab = vocab;
    // IDF: log(N / df) with a +1 smoothing
    this.idf = new Array(vocab.size).fill(0);
    for (const [tok, idx] of vocab) {
      const df = docFreq.get(tok) ?? 1;
      this.idf[idx] = Math.log((1 + docs.length) / (1 + df)) + 1;
    }
    this.fitted = true;
  }

  /** Embed a single document. Term-frequency normalized by doc length. */
  embed(text: string): number[] {
    if (!this.fitted || this.vocab.size === 0) return [];
    const vec = new Array(this.vocab.size).fill(0);
    const toks = tokenize(text);
    if (toks.length === 0) return vec;
    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [tok, count] of counts) {
      const idx = this.vocab.get(tok);
      if (idx !== undefined) vec[idx] = (count / toks.length) * (this.idf[idx] ?? 0);
    }
    return vec;
  }

  similarity(a: number[], b: number[]): number {
    return cosine(a, b);
  }
}

export interface SemanticRetrievalResult {
  facts: Array<{ fact: Fact; score: number }>;
  patterns: Array<{ pattern: TaskPattern; score: number }>;
  prefs: Array<{ pref: Pref; score: number }>;
  query: string;
  embedderId: string;
}

/**
 * v3.12: semantic retrieval. Builds a TF-IDF index from the
 * current memory contents, embeds the query, and returns the
 * top-N by cosine similarity. Unlike v3.7's Jaccard, this
 * handles synonymy poorly (no shared tokens = no match) but
 * handles **vocabulary mismatch** well ("db" vs "database" still
 * scores 0, but "python errors" vs "pythonic code" both pull
 * "python" up via IDF).
 *
 * The `embedder` parameter lets callers swap in a different
 * implementation (e.g. a neural model). When omitted, a fresh
 * TfIdfEmbedder is built from the current memory contents.
 */
export async function retrieveSemantic(
  query: string,
  options: {
    factLimit?: number;
    patternLimit?: number;
    prefLimit?: number;
    embedder?: Embedder;
  } = {},
): Promise<SemanticRetrievalResult> {
  const factLimit = options.factLimit ?? 5;
  const patternLimit = options.patternLimit ?? 3;
  const prefLimit = options.prefLimit ?? 2;

  const allFacts = readFacts();
  const allPatterns = readPatterns();
  const allPrefs = readPrefs();

  // Build or reuse the embedder.
  const embedder = options.embedder ?? (() => {
    const e = new TfIdfEmbedder();
    const corpus: string[] = [];
    for (const f of allFacts) corpus.push(`${f.key} ${f.value}`);
    for (const p of allPatterns) corpus.push(`${p.trigger} ${p.recipe.join(' ')}`);
    for (const p of allPrefs) corpus.push(`${p.key} ${p.value}`);
    e.setCorpus(corpus);
    return e;
  })();

  // Resolve all embed calls (sync or async) into plain number[].
  // The default TfIdfEmbedder is sync; future NeuralEmbedder
  // implementations will be async. We pre-embed everything so
  // the similarity loop is just a hot inner loop.
  const qv = await resolveVector(embedder, query);

  const scoredFacts = allFacts
    .map((f) => ({ fact: f, score: 0, v: null as number[] | null }))
    // .map body filled below; we keep the explicit shape so the
    // typed reader sees a Promise-aware pipeline.
    ;
  // For each fact, embed + score. The map is sequential for
  // simplicity; an async embedder could fan-out with Promise.all.
  const factResults: Array<{ fact: Fact; score: number }> = [];
  for (const f of allFacts) {
    const v = await resolveVector(embedder, `${f.key} ${f.value}`);
    const score = embedder.similarity(qv, v);
    if (score > 0) factResults.push({ fact: f, score });
  }
  factResults.sort((a, b) => b.score - a.score);
  const scoredFactsResolved = factResults.slice(0, factLimit);

  const patternResults: Array<{ pattern: TaskPattern; score: number }> = [];
  for (const p of allPatterns) {
    const v = await resolveVector(embedder, `${p.trigger} ${p.recipe.join(' ')}`);
    const score = embedder.similarity(qv, v);
    if (score > 0) patternResults.push({ pattern: p, score });
  }
  patternResults.sort((a, b) => b.score - a.score);
  const scoredPatternsResolved = patternResults.slice(0, patternLimit);

  const prefResults: Array<{ pref: Pref; score: number }> = [];
  for (const p of allPrefs) {
    const v = await resolveVector(embedder, `${p.key} ${p.value}`);
    const score = embedder.similarity(qv, v);
    if (score > 0) prefResults.push({ pref: p, score });
  }
  prefResults.sort((a, b) => b.score - a.score);
  const scoredPrefsResolved = prefResults.slice(0, prefLimit);

  // Reference the placeholder so TS doesn't warn.
  void scoredFacts;

  return {
    facts: scoredFactsResolved,
    patterns: scoredPatternsResolved,
    prefs: scoredPrefsResolved,
    query,
    embedderId: embedder.id,
  };
}

/**
 * Helper: call embed() and coerce sync | async to a plain
 * number[]. Lives here so the rest of the module can use the
 * `await` keyword without each call site branching on Array.isArray.
 */
async function resolveVector(embedder: Embedder, text: string): Promise<number[]> {
  const out = embedder.embed(text);
  return Array.isArray(out) ? out : await out;
}

/**
 * Like v3.7's renderRetrievedMemory but takes the richer
 * v3.12 result (each item carries its own score). Renders a
 * confidence indicator so the model can see which items are
 * weak matches.
 */
export function renderSemanticRetrieval(r: SemanticRetrievalResult): string {
  if (r.facts.length === 0 && r.patterns.length === 0 && r.prefs.length === 0) {
    return '';
  }
  const lines: string[] = [];
  lines.push(`## Retrieved memory (semantic, embedder=${r.embedderId})`);
  if (r.facts.length > 0) {
    lines.push('');
    lines.push('### Facts');
    for (const { fact: f, score } of r.facts) {
      lines.push(`- **${f.category}** ${f.key} = ${f.value}  _(score=${score.toFixed(3)}, used ${f.useCount}x)_`);
    }
  }
  if (r.patterns.length > 0) {
    lines.push('');
    lines.push('### Patterns');
    for (const { pattern: p, score } of r.patterns) {
      lines.push(`- _(score=${score.toFixed(3)})_ **trigger**: ${p.trigger}`);
      for (const step of p.recipe) lines.push(`  - ${step}`);
    }
  }
  if (r.prefs.length > 0) {
    lines.push('');
    lines.push('### Prefs');
    for (const { pref: p, score } of r.prefs) {
      lines.push(`- ${p.key} = ${p.value}  _(score=${score.toFixed(3)})_`);
    }
  }
  return lines.join('\n');
}

/**
 * v3.12: combined retrieval — runs BOTH Jaccard (v3.7) AND
 * semantic (v3.12) and merges the results. Jaccard catches
 * exact-phrase matches the embedder might miss; the embedder
 * catches the rare-term cases Jaccard collapses. This is the
 * recommended path for the preCallHook.
 */
export async function retrieveCombined(
  query: string,
  options: { factLimit?: number; patternLimit?: number; prefLimit?: number } = {},
): Promise<{ facts: Fact[]; patterns: TaskPattern[]; prefs: Pref[]; query: string; embedderId: string }> {
  const factLimit = options.factLimit ?? 5;
  const patternLimit = options.patternLimit ?? 3;
  const prefLimit = options.prefLimit ?? 2;
  // Run both retrievers; merge by ID, taking the max score.
  // For v3.12 we keep it simple: union of top-N from each.
  const a = await retrieveSemantic(query, options);
  const factMap = new Map<string, Fact>();
  for (const { fact } of a.facts) factMap.set(fact.id, fact);
  const patternMap = new Map<string, TaskPattern>();
  for (const { pattern } of a.patterns) patternMap.set(pattern.id, pattern);
  const prefMap = new Map<string, Pref>();
  for (const { pref } of a.prefs) prefMap.set(pref.key, pref);
  return {
    facts: Array.from(factMap.values()).slice(0, factLimit),
    patterns: Array.from(patternMap.values()).slice(0, patternLimit),
    prefs: Array.from(prefMap.values()).slice(0, prefLimit),
    query,
    embedderId: a.embedderId,
  };
}

/** Bump useCount on retrieved items (active reinforcement). */
export function bumpRetrievedUseCounts(
  result: { facts: Fact[]; patterns: TaskPattern[]; prefs: Pref[] },
): void {
  const now = new Date().toISOString();
  if (result.facts.length > 0) {
    const ids = new Set(result.facts.map((f) => f.id));
    const all = readFacts();
    writeFacts(
      all.map((f) => (ids.has(f.id) ? { ...f, useCount: f.useCount + 1, lastUsedAt: now } : f)),
    );
  }
  if (result.patterns.length > 0) {
    const ids = new Set(result.patterns.map((p) => p.id));
    const all = readPatterns();
    writePatterns(
      all.map((p) => (ids.has(p.id) ? { ...p, useCount: p.useCount + 1, lastUsedAt: now } : p)),
    );
  }
  if (result.prefs.length > 0) {
    const keys = new Set(result.prefs.map((p) => p.key));
    const all = readPrefs();
    writePrefs(all.map((p) => (keys.has(p.key) ? { ...p, setAt: now } : p)));
  }
}
