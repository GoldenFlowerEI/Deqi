/**
 * v3.7: skill auto-suggestion (Hermes-inspired).
 *
 * At the start of every Agent.run() (debounced like auto-retrieval),
 * the harness reads the skills directory and ranks each skill's
 * description against the user prompt. Top N matches are injected
 * as a `## Suggested skills` block so the model knows what helpers
 * it has without an explicit `skill list` call.
 *
 * v3.7 scoring: Jaccard similarity between the prompt tokens and
 * the skill description tokens. (No embeddings yet; deferred.)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_ROOT } from './memory.js';
import { tokenize, jaccard } from './auto-retrieve.js';

export interface SkillMatch {
  name: string;
  description: string;
  score: number;
}

const SKILLS_DIR_NAME = 'skills';

function readSkillMeta(name: string): { description: string } | null {
  const dir = join(MEMORY_ROOT, SKILLS_DIR_NAME, name);
  const mdPath = join(dir, 'SKILL.md');
  if (!existsSync(mdPath)) return null;
  try {
    const text = readFileSync(mdPath, 'utf-8');
    // First H1 is the title; first paragraph is the description.
    const lines = text.split('\n');
    const description: string[] = [];
    let inDescription = false;
    for (const line of lines) {
      if (line.startsWith('# ')) continue;
      if (line.trim() === '') {
        if (inDescription) break;
        continue;
      }
      description.push(line.trim());
      inDescription = true;
      if (description.join(' ').length > 200) break;
    }
    return { description: description.join(' ').slice(0, 200) };
  } catch {
    return null;
  }
}

export function listSkills(): SkillMatch[] {
  const dir = join(MEMORY_ROOT, SKILLS_DIR_NAME);
  if (!existsSync(dir)) return [];
  const out: SkillMatch[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch { continue; }
    const meta = readSkillMeta(name);
    if (meta) {
      out.push({ name, description: meta.description, score: 0 });
    }
  }
  return out;
}

export function suggestSkills(query: string, limit = 3): SkillMatch[] {
  const all = listSkills();
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) {
    return all.slice(0, limit);
  }
  return all
    .map((s) => ({ ...s, score: jaccard(queryTokens, new Set(tokenize(`${s.name} ${s.description}`))) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Render the suggested skills as a markdown block for the system prompt. */
export function renderSkillSuggestions(matches: SkillMatch[]): string {
  if (matches.length === 0) return '';
  const lines: string[] = [];
  lines.push('## Suggested skills (auto-matched to this turn)');
  for (const m of matches) {
    lines.push(`- **${m.name}** _(score ${m.score.toFixed(2)})_: ${m.description}`);
  }
  lines.push('');
  lines.push('Use `skill run <name>` to invoke any of these.');
  return lines.join('\n');
}
