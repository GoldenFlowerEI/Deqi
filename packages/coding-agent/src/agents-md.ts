import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, resolve } from 'node:path';

/**
 * AGENTS.md loader.
 *
 * Walks from cwd up to filesystem root, collecting AGENTS.md at every level,
 * plus the global one at ~/.deqi/AGENTS.md. Closer (more specific) files
 * are appended last so they appear at the bottom — model attention tends to
 * skew towards the end of the prompt.
 */

const GLOBAL_AGENTS = join(homedir(), '.deqi', 'AGENTS.md');
const FILENAME = 'AGENTS.md';

export interface AgentsMdLoadResult {
  /** Concatenated AGENTS.md contents, in order from most-general to most-specific. */
  content: string;
  /** Absolute paths of every file that was loaded. */
  paths: string[];
}

export async function loadAgentsMd(cwd: string): Promise<AgentsMdLoadResult> {
  const paths: string[] = [];
  const contents: string[] = [];

  // 1. Global
  if (existsSync(GLOBAL_AGENTS)) {
    try {
      const text = await readFile(GLOBAL_AGENTS, 'utf8');
      contents.push(`[Global ~/.deqi/AGENTS.md]\n${text}`);
      paths.push(GLOBAL_AGENTS);
    } catch {
      // ignore read errors silently
    }
  }

  // 2. Walk from cwd to root.
  const visited: string[] = [];
  let dir = isAbsolute(cwd) ? cwd : resolve(cwd);
  while (true) {
    if (visited.includes(dir)) break;
    visited.push(dir);
    const candidate = join(dir, FILENAME);
    if (existsSync(candidate)) {
      try {
        const text = await readFile(candidate, 'utf8');
        contents.push(`[${candidate}]\n${text}`);
        paths.push(candidate);
      } catch {
        // ignore
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return {
    content: contents.join('\n\n'),
    paths,
  };
}
