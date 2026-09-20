import { realpathSync } from 'node:fs';
import { resolve, isAbsolute, sep, dirname } from 'node:path';

/**
 * Path-safety utilities. We resolve symlinks for the cwd so that
 * a path inside a symlinked subtree is not rejected by the strict
 * prefix check below.
 */
export function safeResolve(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

export function withinCwd(absPath: string, cwd: string): boolean {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return false;
  }
  // For a path that does not exist yet, validate its parent chain
  // against the real cwd. (realpath would throw ENOENT otherwise.)
  let target = absPath;
  while (true) {
    let realTarget: string;
    try {
      realTarget = realpathSync(target);
    } catch {
      const parent = dirname(target);
      if (parent === target) return false;
      target = parent;
      continue;
    }
    const base = realCwd.endsWith(sep) ? realCwd : realCwd + sep;
    return realTarget === realCwd || realTarget.startsWith(base);
  }
}
