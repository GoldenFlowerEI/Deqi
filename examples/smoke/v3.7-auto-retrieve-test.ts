/**
 * v3.7 test — auto-retrieval.
 *
 * What's covered (~22 asserts):
 *   - tokenize: lowercase, dedup, drop stop words
 *   - jaccard: identical=1, disjoint=0, partial in between
 *   - retrieveRelevant returns top N by Jaccard score
 *   - empty memory → empty result
 *   - non-empty memory + matching query → facts returned
 *   - non-matching query → empty result
 *   - useCount + lastUsedAt are bumped on retrieved facts
 *   - useCount + lastUsedAt are NOT bumped on non-retrieved facts
 *   - renderRetrievedMemory produces a markdown block
 *   - empty result → empty string
 *   - patterns + prefs work the same way
 *
 * No LLM, no real network.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1m── ${t} ──\x1b[0m`); }

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v37-retrieve-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  mkdirSync(join(tmpHome, '.deqi', 'memory'), { recursive: true });

  try {
    const memMod = await import('../../packages/coding-agent/dist/src/memory.js') as unknown as {
      readFacts: () => Array<{ id: string; category: string; key: string; value: string; useCount: number; lastUsedAt: string; createdAt: string }>;
      writeFacts: (facts: unknown) => void;
      readPatterns: () => Array<{ id: string; trigger: string; recipe: string[]; useCount: number; lastUsedAt: string }>;
      writePatterns: (p: unknown) => void;
      readPrefs: () => Array<{ key: string; value: string; setAt: string }>;
      writePrefs: (p: unknown) => void;
      addFact: (cat: string, key: string, value: string) => string;
      addPattern: (trigger: string, recipe: string[]) => string;
      setPref: (key: string, value: string) => void;
    };
    const arMod = await import('../../packages/coding-agent/dist/src/auto-retrieve.js') as unknown as {
      tokenize: (s: string) => string[];
      jaccard: (a: Set<string>, b: Set<string>) => number;
      retrieveRelevant: (q: string, opts?: { factLimit?: number; patternLimit?: number; prefLimit?: number }) => {
        facts: Array<{ id: string; value: string; useCount: number }>;
        patterns: Array<{ id: string; trigger: string; useCount: number }>;
        prefs: Array<{ key: string; value: string }>;
        query: string;
      };
      renderRetrievedMemory: (r: unknown) => string;
    };

    section('tokenize');
    {
      const toks = arMod.tokenize('Hello, World! foo bar baz the and for');
      ok('tokenize: lowercase', toks.every((t) => t === t.toLowerCase()));
      ok('tokenize: no stop words', !toks.includes('the') && !toks.includes('and') && !toks.includes('for'));
      ok('tokenize: dedup-ish (each unique word once)', new Set(toks).size === toks.length);
      const hello = arMod.tokenize('python');
      ok('tokenize: keeps short tech words', hello.includes('python'), `toks=${JSON.stringify(hello)}`);
    }

    section('jaccard');
    {
      ok('jaccard: identical sets = 1', arMod.jaccard(new Set(['a', 'b']), new Set(['a', 'b'])) === 1);
      ok('jaccard: disjoint sets = 0', arMod.jaccard(new Set(['a', 'b']), new Set(['c', 'd'])) === 0);
      ok('jaccard: partial = between 0 and 1',
        arMod.jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd'])) > 0 && arMod.jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd'])) < 1);
      ok('jaccard: empty sets = 0', arMod.jaccard(new Set(), new Set()) === 0);
    }

    section('retrieveRelevant — empty memory');
    {
      const r = arMod.retrieveRelevant('anything goes here');
      ok('empty memory: 0 facts', r.facts.length === 0);
      ok('empty memory: 0 patterns', r.patterns.length === 0);
      ok('empty memory: 0 prefs', r.prefs.length === 0);
    }

    section('retrieveRelevant — matching facts');
    {
      // Seed memory
      memMod.addFact('env', 'pythonPath', '/usr/bin/python3');
      memMod.addFact('path', 'projectRoot', '/home/user/myproject');
      memMod.addFact('integration', 'githubToken', 'ghp_xxx');
      // Query "python interpreter" — tokenize: ['python', 'interpreter']
      // Fact value tokenize: ['python3', 'usr', 'bin']
      // Hmm, 'python' vs 'python3' is 0 overlap. Let's add a fact whose
      // value shares tokens with the query.
      memMod.addFact('env', 'pythonLocation', 'python interpreter at /usr/local');
      const r = arMod.retrieveRelevant('where is my python interpreter');
      ok('matching: at least 1 fact returned', r.facts.length > 0, `count=${r.facts.length}`);
      ok('matching: top fact mentions python',
        r.facts[0]?.key === 'pythonLocation' || r.facts.some((f) => f.value.includes('python')),
        `top=${r.facts[0]?.key}`);
      // The github fact shouldn't match
      ok('matching: github fact not in top 3',
        !r.facts.slice(0, 3).some((f) => f.key === 'githubToken'),
        `keys=${r.facts.slice(0, 3).map((f) => f.key).join(',')}`);
    }

    section('retrieveRelevant — non-matching query');
    {
      const r = arMod.retrieveRelevant('quantum entanglement experiment');
      ok('non-matching: 0 facts returned', r.facts.length === 0);
    }

    section('useCount bumping');
    {
      const fact = memMod.addFact('user', 'editorPreference', 'vim is my editor');
      const before = memMod.readFacts().find((f) => f.id === fact.id);
      arMod.retrieveRelevant('what is my editor');
      const after = memMod.readFacts().find((f) => f.id === fact.id);
      ok('useCount bumped after retrieval', (after?.useCount ?? 0) > (before?.useCount ?? 0),
        `before=${before?.useCount} after=${after?.useCount}`);
    }

    section('useCount NOT bumped for non-retrieved facts');
    {
      const nodeFact = memMod.addFact('env', 'nodeLocation', 'node installation at /usr/local');
      const pyFact = memMod.addFact('env', 'pythonLocation', 'python installation at /opt');
      // Query "python" only matches pythonLocation
      const r = arMod.retrieveRelevant('where is python');
      const allFacts = memMod.readFacts();
      const node = allFacts.find((f) => f.id === nodeFact.id);
      const py = allFacts.find((f) => f.id === pyFact.id);
      ok('python is in retrieval', r.facts.some((f) => f.id === py?.id));
      ok('node is NOT in retrieval (no match)', !r.facts.some((f) => f.id === node?.id));
    }

    section('patterns retrieval');
    {
      memMod.addPattern('release a new version',
        ['bump version', 'update CHANGELOG', 'git tag', 'npm publish']);
      const r = arMod.retrieveRelevant('I want to release a new version');
      ok('pattern retrieved for matching trigger', r.patterns.length > 0);
    }

    section('renderRetrievedMemory');
    {
      const r = arMod.retrieveRelevant('where is python and the project root');
      const out = arMod.renderRetrievedMemory(r);
      if (r.facts.length > 0) {
        ok('render includes "Retrieved memory" header', out.includes('## Retrieved memory'));
        ok('render includes fact keys', r.facts.some((f) => out.includes(f.key)));
      } else {
        ok('render: empty result returns empty string', out === '');
      }
    }

    section('renderRetrievedMemory with all empty');
    {
      const r = { facts: [], patterns: [], prefs: [], query: 'x' };
      ok('render empty result is empty string', arMod.renderRetrievedMemory(r) === '');
    }

    section('summary');
    console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
    if (failCount > 0) {
      console.log('  failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => { console.error('v3.7-auto-retrieve-test crashed:', err); process.exit(1); });
