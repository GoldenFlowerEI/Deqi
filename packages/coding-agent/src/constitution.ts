/**
 * Constitution loader.
 *
 * Reads the constitution text in this priority order:
 *   1. $DEQI_CONSTITUTION env var (path to a custom file)
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

/** Directory of this module, regardless of src/ vs dist/src/. */
const here = dirname(fileURLToPath(import.meta.url));

export function loadConstitution(): { text: string; source: string } {
  if (cached) return cached;
  // 1. env var
  const envPath = process.env.DEQI_CONSTITUTION;
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
  // 3. built-in default.
  //
  //    v0.3: this used to be a single `resolve(here, '..', 'constitution.md')`.
  //    That silently broke in production. The compiled module lives at
  //    `dist/src/constitution.js`, so `'..'` resolves to `dist/constitution.md`
  //    — and `tsc` does not copy .md files into dist. The loader therefore fell
  //    through to the inline fallback, so the agent was running on the 10 bare
  //    one-line titles instead of the real 72-line constitution with each
  //    principle's reasoning.
  //
  //    Fix: walk up from the module directory looking for constitution.md.
  //    Works from `src/` (tsx / dev) and from `dist/src/` (compiled) alike,
  //    and survives a layout change better than a fixed number of `..` hops.
  const builtinPath = findUp(here, 'constitution.md');
  if (builtinPath) {
    cached = { text: readFileSync(builtinPath, 'utf8'), source: builtinPath };
    return cached;
  }
  // 4. inline fallback
  cached = { text: FALLBACK_CONSTITUTION, source: '(inline fallback)' };
  return cached;
}

/**
 * Walk up from `startDir` looking for `fileName`, stopping at the
 * filesystem root. Returns the first absolute path that exists, or
 * null.
 *
 * Used to locate the built-in constitution.md regardless of whether
 * we are running from `src/` (tsx / dev) or `dist/src/` (compiled).
 * Bounded to 6 levels so a misconfigured install can't walk the
 * entire drive.
 */
function findUp(startDir: string, fileName: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i += 1) {
    const candidate = resolve(dir, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // hit the filesystem root
    dir = parent;
  }
  return null;
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
