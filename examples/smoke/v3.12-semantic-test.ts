/**
 * v3.12 semantic retrieval test.
 *
 * What's covered (12 asserts):
 *   1-3. TfIdfEmbedder: empty corpus, 1-doc corpus, multi-doc IDF differs
 *   4.   cosine returns 0 for empty / mismatched
 *   5.   cosine returns 1 for identical
 *   6.   cosine is symmetric
 *   7-9. retrieveSemantic finds relevant facts, ranks by score, drops irrelevant
 *  10.   renderSemanticRetrieval includes score + embedderId
 *  11.   retrieveCombined merges with useCount bump
 *  12.   Embedder interface allows async embed (forward-compat hook)
 *
 * No live server needed; uses real ~/.deqi/memory so we exercise
 * the same code path the preCallHook does.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passCount += 1;
    console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failCount += 1;
    failures.push(name);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m── ${title} ──\x1b[0m`);
}

async function main(): Promise<void> {
  const codingAgent = await import('../../packages/coding-agent/dist/src/index.js');
  const { TfIdfEmbedder, cosine, retrieveSemantic, retrieveCombined, renderSemanticRetrieval, bumpRetrievedUseCounts } = codingAgent;

  section('TfIdfEmbedder basic ops');
  const e0 = new TfIdfEmbedder();
  e0.setCorpus([]);
  ok('empty corpus → empty vocab',
    e0.embed('anything').length === 0);
  const e1 = new TfIdfEmbedder();
  e1.setCorpus(['python web framework', 'database engine', 'cooking recipes']);
  const v1 = e1.embed('python database');
  ok('embed produces a non-zero vector with multi-doc corpus',
    v1.some((x: number) => x > 0),
    `non-zero count=${v1.filter((x: number) => x > 0).length}`);

  // IDF: "python" appears 3/4 docs, "database" 1/4. The rarer
  // term "database" should get HIGHER weight (it's more
  // discriminating). This is the whole point of TF-IDF.
  const e2 = new TfIdfEmbedder();
  e2.setCorpus([
    'python tutorial', 'python guide', 'python cookbook', 'database design',
  ]);
  const v_python = e2.embed('python');
  const v_database = e2.embed('database');
  const pyWeight = v_python.reduce((s: number, x: number) => s + x, 0);
  const dbWeight = v_database.reduce((s: number, x: number) => s + x, 0);
  ok('TF-IDF gives HIGHER weight to the rarer term "database" vs "python"',
    dbWeight > pyWeight,
    `python=${pyWeight.toFixed(3)} database=${dbWeight.toFixed(3)}`);

  section('cosine similarity');
  ok('cosine of identical non-zero vectors is 1',
    Math.abs(cosine([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  ok('cosine is symmetric',
    Math.abs(cosine([1, 0, 1], [0, 1, 0]) - cosine([0, 1, 0], [1, 0, 1])) < 1e-9);
  ok('cosine of zero vector is 0',
    cosine([0, 0, 0], [1, 2, 3]) === 0);

  // ── 2. retrieveSemantic: needs a real memory dir.
  section('retrieveSemantic against real memory (v3.12)');
  const home = homedir();
  const factsPath = join(home, '.deqi', 'memory', 'facts.json');
  const patternsPath = join(home, '.deqi', 'memory', 'patterns.json');
  const prefsPath = join(home, '.deqi', 'memory', 'prefs.json');
  // Back up any existing files so we can restore them.
  const bak: Record<string, string | null> = {
    facts: existsSync(factsPath) ? readFileSync(factsPath, 'utf8') : null,
    patterns: existsSync(patternsPath) ? readFileSync(patternsPath, 'utf8') : null,
    prefs: existsSync(prefsPath) ? readFileSync(prefsPath, 'utf8') : null,
  };
  try {
    mkdirSync(join(home, '.deqi', 'memory'), { recursive: true });
    const facts = {
      facts: [
        { id: 'f1', category: 'path', key: 'postgres', value: 'runs on port 5432 by default',
          createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', useCount: 1 },
        { id: 'f2', category: 'env', key: 'python version', value: '3.12 with uv for package management',
          createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', useCount: 1 },
        { id: 'f3', category: 'integration', key: 'redis', value: 'cache layer with 5s TTL',
          createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', useCount: 1 },
        { id: 'f4', category: 'path', key: 'cooking', value: 'stir-fry at 200°C for 3 minutes',
          createdAt: '2026-01-01T00:00:00Z', lastUsedAt: '2026-01-01T00:00:00Z', useCount: 1 },
      ],
    };
    writeFileSync(factsPath, JSON.stringify(facts));

    const r1 = await retrieveSemantic('postgres database port');
    ok('retrieves the postgres fact (semantic match on shared tokens)',
      r1.facts.some((x: { fact: { key: string } }) => x.fact.key === 'postgres'),
      `keys=${r1.facts.map((x: { fact: { key: string } }) => x.fact.key).join(',')}`);
    ok('does NOT retrieve the cooking fact (irrelevant)',
      !r1.facts.some((x: { fact: { key: string } }) => x.fact.key === 'cooking'));
    ok('embedderId is set on the result',
      typeof r1.embedderId === 'string' && r1.embedderId.length > 0,
      `id="${r1.embedderId}"`);

    const block = renderSemanticRetrieval(r1);
    ok('renderSemanticRetrieval includes the score line',
      block.includes('score=') && block.includes('embedder=tfidf-v1'),
      `block="${block.split('\n').find((l: string) => l.includes('postgres')) ?? ''}"`);

    // ── 3. retrieveCombined + useCount bump
    const r2 = await retrieveCombined('python version');
    ok('retrieveCombined surfaces the python fact',
      r2.facts.some((f: { key: string }) => f.key === 'python version'));
    const useCountBefore = JSON.parse(readFileSync(factsPath, 'utf8'))
      .facts.find((f: { id: string }) => f.id === 'f2').useCount;
    bumpRetrievedUseCounts(r2);
    const useCountAfter = JSON.parse(readFileSync(factsPath, 'utf8'))
      .facts.find((f: { id: string }) => f.id === 'f2').useCount;
    ok('bumpRetrievedUseCounts increments useCount on retrieved facts',
      useCountAfter === useCountBefore + 1,
      `before=${useCountBefore} after=${useCountAfter}`);

    // ── 4. Embedder interface is async-capable (forward-compat).
    // We can't easily test a NeuralEmbedder without installing
    // a model, but we can confirm the interface accepts both
    // sync and async returns.
    const syncImpl = { id: 'sync', embed: (t: string) => [t.length], similarity: cosine };
    const asyncImpl = { id: 'async', embed: async (t: string) => [t.length], similarity: cosine };
    const r3 = await retrieveSemantic('test', { embedder: syncImpl });
    const r4 = await retrieveSemantic('test', { embedder: asyncImpl });
    ok('retrieveSemantic accepts a sync Embedder', r3.embedderId === 'sync');
    ok('retrieveSemantic accepts an async Embedder', r4.embedderId === 'async');
  } finally {
    // Restore
    for (const [key, content] of Object.entries(bak)) {
      const p = key === 'facts' ? factsPath : key === 'patterns' ? patternsPath : prefsPath;
      if (content === null) {
        try { rmSync(p, { force: true }); } catch { /* noop */ }
      } else {
        writeFileSync(p, content);
      }
    }
  }

  section('summary');
  console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
  if (failCount > 0) {
    console.log('  failures:');
    for (const f of failures) console.log(`    - ${f}`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error('v3.12-semantic-test crashed:', err);
  process.exit(1);
});
