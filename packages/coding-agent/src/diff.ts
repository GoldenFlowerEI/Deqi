/**
 * diff.ts — line diffs, for showing what the agent actually changed.
 *
 * The harness could tell the user "Updated src/index.ts (4,201 bytes)".
 * That is not the same as showing them the four lines it replaced.
 * For an agent that edits your code, the second one is the product.
 *
 * Why not a dependency
 * --------------------
 * A diff is ~80 lines of well-understood algorithm, it has to run
 * inside a tool that already has the before and after text in hand,
 * and a wrong diff is worse than no diff. `details.diff` carries it on
 * the tool result and never enters the model's context, so nothing
 * about this is visible to the agent.
 *
 * Why the prefix/suffix trim
 * -------------------------
 * A plain LCS is O(n·m) in both time and memory. A 3,000-line file
 * with one changed line is 9,000,000 cells — enough to stall a turn.
 * Trimming the identical head and tail first reduces the same edit to
 * a handful of cells, which is the shape almost every real edit has.
 */

/**
 * Above this, the trimmed region is summarised instead of diffed.
 *
 * 1M cells is ~4 MB of Uint32 and a few tens of milliseconds. Bigger
 * than that, the common-prefix trim has already failed to save us —
 * which means the whole file was rewritten, and a line-by-line view
 * of that is not information anyone can use anyway.
 */
const LCS_CELL_BUDGET = 1_000_000;
/** Cap on rendered lines, so a whole-file rewrite cannot flood the UI. */
const MAX_LINES = 400;

export type DiffOp = 'ctx' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old file, for `ctx` and `del`. */
  oldNo?: number;
  /** 1-based line number in the new file, for `ctx` and `add`. */
  newNo?: number;
}

export interface FileDiff {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the diff was cut short — the counts stay honest. */
  truncated: boolean;
  /** Set when the file was too large to line-diff; nothing is shown. */
  tooLarge?: boolean;
}

function splitLines(text: string): string[] {
  // A trailing newline is a terminator, not a blank last line. Counting
  // it as a line makes every "added a final newline" edit show as a
  // spurious `+` on an empty line.
  const t = text.replace(/\r\n/g, '\n');
  const lines = t.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Longest common subsequence over line arrays, returned as paired
 * index lists. Classic DP table; the budget check in `diffLines`
 * keeps it from being called on anything large.
 */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i]!;
    const next = table[i + 1]!;
    for (let j = m - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

export function diffLines(oldText: string, newText: string): { lines: DiffLine[]; added: number; removed: number; truncated: boolean; tooLarge: boolean } {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  if (oldText === newText) return { lines: [], added: 0, removed: 0, truncated: false, tooLarge: false };

  // Trim the identical head and tail.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail += 1;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const lines: DiffLine[] = [];
  // Context: two lines of head and tail is enough to locate the change
  // without turning the view into a full file listing.
  const CTX = 2;
  for (let i = 0; i < Math.min(head, CTX); i += 1) {
    lines.push({ op: 'ctx', text: a[i]!, oldNo: i + 1, newNo: i + 1 });
  }
  if (head > CTX) {
    lines.push({ op: 'ctx', text: `… ${head - CTX} unchanged line(s)`, oldNo: CTX + 1, newNo: CTX + 1 });
  }

  let added = 0;
  let removed = 0;
  let truncated = false;
  let tooLarge = false;

  if (midA.length * midB.length > LCS_CELL_BUDGET) {
    // Honest rather than clever: say the change is too big to show
    // line by line, and give the counts. A wrong diff is worse.
    tooLarge = true;
    added = midB.length;
    removed = midA.length;
  } else {
    const pairs = lcsPairs(midA, midB);
    const inA = new Set(pairs.map((p) => p[0]));
    // j -> i, precomputed. A findIndex per line made this O(n²): a
    // 200-line change did 40,000 comparisons to do the same work.
    const aForB = new Map<number, number>();
    for (const [ai, bj] of pairs) aForB.set(bj, ai);

    // Emit in new-file order so the result reads top-to-bottom the way
    // the file does; a deletion is emitted before the line it displaced.
    const emittedDel = new Set<number>();
    for (let j = 0; j < midB.length; j += 1) {
      // Anything in `midA` before this surviving `midB` line was removed.
      const limit = aForB.get(j) ?? midA.length;
      for (let i = 0; i < limit; i += 1) {
        if (inA.has(i) || emittedDel.has(i)) continue;
        emittedDel.add(i);
        lines.push({ op: 'del', text: midA[i]!, oldNo: head + i + 1 });
        removed += 1;
      }
      const i = aForB.get(j);
      if (i !== undefined) {
        lines.push({ op: 'ctx', text: midA[i]!, oldNo: head + i + 1, newNo: head + j + 1 });
      } else {
        lines.push({ op: 'add', text: midB[j]!, newNo: head + j + 1 });
        added += 1;
      }
    }
    for (let i = 0; i < midA.length; i += 1) {
      if (inA.has(i) || emittedDel.has(i)) continue;
      lines.push({ op: 'del', text: midA[i]!, oldNo: head + i + 1 });
      removed += 1;
    }
  }

  if (tail > CTX) {
    lines.push({ op: 'ctx', text: `… ${tail - CTX} unchanged line(s)`, oldNo: a.length - tail + 1, newNo: b.length - tail + 1 });
  }
  for (let k = Math.max(0, tail - CTX); k < tail; k += 1) {
    const ai = a.length - tail + k;
    const bi = b.length - tail + k;
    lines.push({ op: 'ctx', text: a[ai]!, oldNo: ai + 1, newNo: bi + 1 });
  }

  if (lines.length > MAX_LINES) {
    lines.length = MAX_LINES;
    truncated = true;
  }
  return { lines, added, removed, truncated, tooLarge };
}

export function makeFileDiff(
  path: string,
  before: string | null,
  after: string,
): FileDiff {
  if (before === null) {
    const lines = splitLines(after);
    const capped = lines.slice(0, MAX_LINES);
    return {
      path,
      change: 'created',
      lines: capped.map((t, i) => ({ op: 'add' as const, text: t, newNo: i + 1 })),
      added: capped.length,
      removed: 0,
      truncated: lines.length > MAX_LINES,
    };
  }
  const d = diffLines(before, after);
  return {
    path,
    change: 'modified',
    lines: d.lines,
    added: d.added,
    removed: d.removed,
    truncated: d.truncated,
    ...(d.tooLarge ? { tooLarge: true } : {}),
  };
}
