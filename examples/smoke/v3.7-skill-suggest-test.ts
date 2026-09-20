/**
 * v3.7 test — skill auto-suggestion.
 *
 * What's covered (~12 asserts):
 *   - listSkills returns empty when no skills dir
 *   - listSkills reads SKILL.md metadata
 *   - suggestSkills returns matches sorted by score
 *   - suggestSkills returns top N matches
 *   - exact keyword match wins
 *   - renderSkillSuggestions produces a markdown block
 *   - empty result → empty string
 *
 * No LLM, no real network.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v37-skills-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Set up skill directory with a few SKILL.md files
  const skillsDir = join(tmpHome, '.deqi', 'memory', 'skills');
  mkdirSync(join(skillsDir, 'deploy-k8s'), { recursive: true });
  writeFileSync(join(skillsDir, 'deploy-k8s', 'SKILL.md'), `# deploy-k8s

Deploy a service to Kubernetes using the project kubectl config.

Used for: production deploys, staging deploys, rolling restarts.`);
  mkdirSync(join(skillsDir, 'run-tests'), { recursive: true });
  writeFileSync(join(skillsDir, 'run-tests', 'SKILL.md'), `# run-tests

Run the project's test suite and report failures.

Used for: test runs, regression checks, CI.`);
  mkdirSync(join(skillsDir, 'git-release'), { recursive: true });
  writeFileSync(join(skillsDir, 'git-release', 'SKILL.md'), `# git-release

Cut a release: bump version, update changelog, tag, push.`);
  // A skill with no SKILL.md (should be skipped)
  mkdirSync(join(skillsDir, 'broken-skill'), { recursive: true });

  try {
    const skillMod = await import('../../packages/coding-agent/dist/src/skill-suggest.js') as unknown as {
      listSkills: () => Array<{ name: string; description: string; score: number }>;
      suggestSkills: (q: string, limit?: number) => Array<{ name: string; description: string; score: number }>;
      renderSkillSuggestions: (m: Array<{ name: string; description: string; score: number }>) => string;
    };

    section('listSkills');
    {
      const all = skillMod.listSkills();
      ok('listSkills: 3 valid skills (skips broken)', all.length === 3, `count=${all.length}`);
      ok('listSkills: includes deploy-k8s', all.some((s) => s.name === 'deploy-k8s'));
      ok('listSkills: skips broken-skill', !all.some((s) => s.name === 'broken-skill'));
      ok('listSkills: descriptions are populated', all.every((s) => s.description.length > 0));
    }

    section('suggestSkills — exact match wins');
    {
      const matches = skillMod.suggestSkills('I want to deploy to kubernetes', 3);
      ok('suggest: at least 1 match', matches.length > 0);
      ok('suggest: top match is deploy-k8s', matches[0]?.name === 'deploy-k8s', `top=${matches[0]?.name}`);
    }

    section('suggestSkills — test-related query');
    {
      const matches = skillMod.suggestSkills('run the test suite and check for failures', 3);
      ok('suggest: top match is run-tests', matches[0]?.name === 'run-tests', `top=${matches[0]?.name}`);
    }

    section('suggestSkills — non-matching query');
    {
      const matches = skillMod.suggestSkills('quantum entanglement experiment', 3);
      ok('suggest: 0 matches for unrelated query', matches.length === 0, `count=${matches.length}`);
    }

    section('suggestSkills — limit');
    {
      const matches = skillMod.suggestSkills('test', 2);
      ok('suggest: respects limit', matches.length <= 2, `count=${matches.length}`);
    }

    section('renderSkillSuggestions');
    {
      const matches = skillMod.suggestSkills('deploy to kubernetes', 1);
      const out = skillMod.renderSkillSuggestions(matches);
      if (matches.length > 0) {
        ok('render: includes "Suggested skills" header', out.includes('## Suggested skills'));
        ok('render: includes the skill name', out.includes(matches[0]!.name));
        ok('render: includes the score', out.includes('score'));
      } else {
        ok('render: no matches → empty string', out === '');
      }
    }
    {
      ok('render: empty list → empty string', skillMod.renderSkillSuggestions([]) === '');
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

main().catch((err) => { console.error('v3.7-skill-suggest-test crashed:', err); process.exit(1); });
