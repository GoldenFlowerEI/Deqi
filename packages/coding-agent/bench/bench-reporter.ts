/**
 * v4.3: bench reporter — turn runSuite() output into a markdown
 * report and compare two reports for regressions.
 *
 * The bench harness (`bench-harness.ts`) already runs cases. v4.3
 * adds:
 *   - renderMarkdownReport() — human-readable summary suitable
 *     for pasting into a GitHub issue or release notes
 *   - compareReports() — diff two reports; returns regressions
 *     (pass→fail) and fixes (fail→pass)
 *   - BenchSummary — the structured form both functions read
 *
 * These three together let CI run the bench on every PR, post
 * a markdown comment, and gate releases on "no regressions vs
 * the last green run".
 */

import type { BenchResult } from './bench-harness.js';

export interface BenchSummary {
  total: number;
  pass: number;
  fail: number;
  results: BenchResult[];
  /** v4.3: optional label (e.g. commit SHA, model id, branch). */
  label?: string;
  /** v4.3: ISO timestamp when the run finished. */
  finishedAt?: string;
  /** v4.3: total wall-clock duration in ms. */
  durationMs?: number;
}

export interface ComparisonReport {
  /** Cases that passed before but now fail. */
  regressions: Array<{ name: string; before: string; after: string }>;
  /** Cases that failed before but now pass. */
  fixes: Array<{ name: string; before: string; after: string }>;
  /** v4.3: cases in `after` that were not in `before` (newly
   *  added). Failures here are also regressions in spirit —
   *  "the suite gained a failing case" — but we surface them
   *  separately so the user can decide. */
  newCases: Array<{ name: string; after: string; pass: boolean }>;
  /** pass/fail counts before vs after. */
  delta: { beforePass: number; afterPass: number; beforeFail: number; afterFail: number };
}

/** v4.3: flatten a result's `details` array to a single string. */
function detailsToDetail(r: BenchResult): string {
  return r.details.join('; ');
}

/**
 * v4.3: render a bench summary as markdown. The output is meant
 * to be posted as a PR comment or pasted into a release note.
 */
export function renderMarkdownReport(s: BenchSummary): string {
  const passRate = s.total > 0 ? ((s.pass / s.total) * 100).toFixed(1) : '0.0';
  const lines: string[] = [];
  lines.push(`# Bench report${s.label ? ` — ${s.label}` : ''}`);
  if (s.finishedAt) lines.push(`_finished: ${s.finishedAt}_`);
  if (s.durationMs !== undefined) {
    lines.push(`_duration: ${(s.durationMs / 1000).toFixed(1)}s_`);
  }
  lines.push('');
  lines.push(`**Total:** ${s.total}    **Pass:** ${s.pass}    **Fail:** ${s.fail}    **Pass rate:** ${passRate}%`);
  lines.push('');
  lines.push('| Case | Pass | Detail |');
  lines.push('| --- | --- | --- |');
  for (const r of s.results) {
    const status = r.pass ? '✅' : '❌';
    const detail = detailsToDetail(r).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lines.push(`| ${r.name} | ${status} | ${detail} |`);
  }
  if (s.fail > 0) {
    lines.push('');
    lines.push(`## Failures (${s.fail})`);
    for (const r of s.results.filter((x) => !x.pass)) {
      lines.push(`- **${r.name}** — ${detailsToDetail(r)}`);
    }
  }
  return lines.join('\n');
}

/**
 * v4.3: diff two bench summaries. Regressions are pass→fail;
 * fixes are fail→pass. Cases that are unchanged (both pass or
 * both fail) are not in the report.
 */
export function compareReports(before: BenchSummary, after: BenchSummary): ComparisonReport {
  const beforeByName = new Map<string, BenchResult>(before.results.map((r) => [r.name, r]));
  const afterByName = new Map<string, BenchResult>(after.results.map((r) => [r.name, r]));
  const regressions: ComparisonReport['regressions'] = [];
  const fixes: ComparisonReport['fixes'] = [];
  const newCases: ComparisonReport['newCases'] = [];
  for (const [name, a] of afterByName) {
    const b = beforeByName.get(name);
    if (!b) {
      newCases.push({ name, after: detailsToDetail(a), pass: a.pass });
      continue;
    }
    if (b.pass && !a.pass) {
      regressions.push({ name, before: detailsToDetail(b), after: detailsToDetail(a) });
    } else if (!b.pass && a.pass) {
      fixes.push({ name, before: detailsToDetail(b), after: detailsToDetail(a) });
    }
  }
  return {
    regressions,
    fixes,
    newCases,
    delta: {
      beforePass: before.pass,
      afterPass: after.pass,
      beforeFail: before.fail,
      afterFail: after.fail,
    },
  };
}

/**
 * v4.3: short summary line for the CLI / log output.
 */
export function summaryLine(s: BenchSummary): string {
  const rate = s.total > 0 ? ((s.pass / s.total) * 100).toFixed(0) : '0';
  return `bench${s.label ? `(${s.label})` : ''}: ${s.pass}/${s.total} pass (${rate}%) in ${s.durationMs !== undefined ? `${(s.durationMs / 1000).toFixed(1)}s` : '?'}`;
}
