/**
 * Constitution loader.
 *
 * Reads the constitution text in this priority order:
 *   1. $Deqi_CONSTITUTION env var (path to a custom file)
 *   2. ~/.deqi/constitution.md (per-user override)
 *   3. <project>/packages/coding-agent/constitution.md (built-in default)
 *   4. An inline minimum set (last-resort fallback)
 *
 * The constitution is a single markdown string. The harness
 * prepends it to the system prompt; a `constitution` tool exposes
 * the list of principles the agent can re-read on demand.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_CONSTITUTION = `# Deqi Constitution (default)\n\n- Read before write.\n- Prefer narrow tools over general ones.\n- Surface uncertainty rather than guess.\n- Verify before claiming.\n- Do not exceed the user's scope.\n- Composition over cleverness.\n- Name the consequence, not the rule.\n- Honor the inner layer.\n- Wu-wei: do not impose.\n- The Golden Flower unfolds by being seen correctly.\n`;

let cached: { text: string; source: string } | null = null;

export function loadConstitution(): { text: string; source: string } {
  if (cached) return cached;
  // 1. env var
  const envPath = process.env.Deqi_CONSTITUTION;
  if (envPath && existsSync(envPath)) {
    cached = { text: readFileSync(envPath, 'utf8'), source: envPath };
    return cached;
  }
  // 2. user home
  const homePath = resolve(homedir(), '.deqi', 'constitution.md');
  if (existsSync(homePath)) {
    cached = { text: readFileSync(homePath, 'utf8'), source: homePath };
    return cached;
  }
  // 3. built-in default (next to this source file)
  const here = dirname(fileURLToPath(import.meta.url));
  const builtinPath = resolve(here, '..', 'constitution.md');
  if (existsSync(builtinPath)) {
    cached = { text: readFileSync(builtinPath, 'utf8'), source: builtinPath };
    return cached;
  }
  // 4. inline fallback
  cached = { text: FALLBACK_CONSTITUTION, source: '(inline fallback)' };
  return cached;
}

/** Extract a list of principle lines from the constitution text. */
export function listPrinciples(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(#+\s+)?\d+\.\s/.test(l) || /^- /.test(l))
    .map((l) => l.replace(/^(#+\s+)?(\d+\.\s|-\s)/, '').trim())
    .filter((l) => l.length > 0);
}

/** For tests: reset the cache. */
export function _resetConstitutionCache(): void {
  cached = null;
}
