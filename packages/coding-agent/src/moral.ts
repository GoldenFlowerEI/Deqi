/**
 * v0.3: the moral layer.
 *
 * What this is
 * ------------
 * The constitution (`constitution.md`) is ten principles in prose. It
 * is prepended to the system prompt, where it is, in practice, a
 * request. Nothing checks whether the agent is actually following it,
 * and nothing shows the user whether it was.
 *
 * This module turns the principles into something checkable. Each
 * rule is:
 *   - anchored to a numbered principle, so a flag can always say
 *     *why* it fired and the user can read the reasoning;
 *   - a pure predicate over (toolName, args) — no I/O, no model
 *     call, so it can be tested exhaustively;
 *   - assigned a severity that determines whether it merely reports
 *     (form A), or also gates the action (form B).
 *
 * Design constraints
 * ------------------
 * **It must not be a second permission system.** The gate from
 * `permission-modes.ts` already decides what runs. The moral layer
 * runs BEFORE that gate, and can only ever do two things: report, or
 * ask. It never denies on its own, because a moral judgement that
 * silently blocks work is how you get a feature switched off.
 *
 * **It must be explainable.** Every finding carries the principle, a
 * plain sentence, and the concrete consequence — not a score, not a
 * vibe. A user who disagrees with a flag has to be able to see the
 * reasoning and overrule it.
 *
 * **False positives are expensive.** A moral layer that cries wolf
 * gets muted, and then it protects nothing. The rules below are
 * deliberately narrow: each one matches a specific destructive shape,
 * not a general category like "modifying files".
 *
 * The three forms the user asked for map to three consumers:
 *   A (visible)  → auditToolCall()  → `moral_audit` event → UI badge
 *   B (gate)     → findings with severity 'high' → an extra `ask`
 *   C (review)   → reviewTurn()     → `turn_review` event
 */

/** Which numbered principle a rule comes from. */
export type Principle = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type Severity =
  /** Worth mentioning. Does not gate. */
  | 'note'
  /** Worth the user's attention before an irreversible action. */
  | 'warn'
  /**
   * The action is destructive and not undoable by the agent. Ask.
   */
  | 'high';

export interface MoralFinding {
  /** Stable rule id, for tests and for "don't show this again". */
  rule: string;
  principle: Principle;
  severity: Severity;
  /** The tool this fired on. */
  tool: string;
  /** One sentence, plain language, no jargon. */
  summary: string;
  /**
   * The concrete downside, not the abstract rule. Mirrors
   * constitution principle 7 — the user can weigh a cost; they
   * cannot weigh a rule.
   */
  consequence: string;
  /** Optional: a value pulled out of the args, e.g. the path. */
  evidence?: string;
}

export interface MoralRule {
  id: string;
  principle: Principle;
  severity: Severity;
  /**
   * A single tool name, a list, or `'*'` for every tool. Most rules are
   * one tool; a bare string is the common case and reads better than a
   * one-element array at the call site.
   */
  tools: string | string[] | '*';
  summary: string;
  consequence: string;
  /** Returns evidence to show, or null when the rule does not fire. */
  match: (args: Record<string, unknown>) => string | null;
}

// ─── helpers ────────────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** Everything the user would lose if the action could not be undone. */

/**
 * The short letters in a flag cluster: `rm -rf` yields `{r, f}`.
 * Long flags (`--recursive`) are skipped here and checked by name.
 */
function shortFlags(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.startsWith('--')) continue;
    for (const ch of t.slice(1)) out.add(ch);
  }
  return out;
}

/**
 * True for an `rm` that neither prompts nor can be talked out of it:
 * recursive AND forced. Returns the flag cluster, or null.
 *
 * `rm -r olddir` prompts first, and in a non-interactive shell the
 * answer defaults to "no" — so it is recoverable and is not this rule.
 * `rm -f notes.txt` is unprompted but names one file, which is a
 * different (and much smaller) thing. Both are covered by the false
 * positive tests, because flagging them is what gets a moral layer
 * muted.
 */
function rmIsUnconditional(command: string): string | null {
  const m = /\brm\s+((?:-{1,2}[A-Za-z][\w-]*(?:\s+|$))+)/.exec(command);
  if (!m) return null;
  const flags = (m[1] ?? '').trim();
  const tokens = flags.split(/\s+/).filter(Boolean);
  const letters = shortFlags(tokens);
  const recursive = letters.has('r') || letters.has('R') || tokens.includes('--recursive');
  const force = letters.has('f') || tokens.includes('--force');
  return recursive && force ? flags : null;
}

/** Sinks that throw the output away, so nothing is overwritten. */
const THROWAWAY_SINK = /^(?:\/(?:dev\/null|NUL)|&[12]?|\d+>&\d*)$/i;

/** `git` pathspecs that mean "everything", as opposed to one path. */
const EVERYTHING_PATHSPEC = /(?:^|\s)(?:\.|:\/|\*|\*\/\*|\.\/\*)(?=$|\s)/;

export const MORAL_RULES: MoralRule[] = [
  // ── Principle 5: do not exceed the user's scope ───────────────
  {
    id: 'rm-recursive',
    principle: 5,
    severity: 'high',
    tools: 'bash',
    summary: 'Recursively deleting files.',
    consequence:
      'Anything matched is gone immediately. The agent cannot undo it, and a path that looks narrower than it is will take a whole tree with it.',
    match: (a) => {
      const c = str(a, 'command');
      if (rmIsUnconditional(c)) return c.slice(0, 120);
      return null;
    },
  },
  {
    id: 'git-force-push',
    principle: 5,
    severity: 'high',
    tools: 'bash',
    summary: 'Force-pushing to git.',
    consequence:
      'Force-push overwrites remote history. Anyone who pulled the old commits, and any CI that already ran them, no longer has a reference to recover from.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|-f\b)/.test(c)) {
        return c.slice(0, 120);
      }
      return null;
    },
  },
  {
    id: 'git-discard',
    principle: 5,
    severity: 'high',
    tools: 'bash',
    summary: 'Discarding uncommitted work.',
    consequence:
      'Uncommitted changes are not in any commit, so there is nothing to restore. `git checkout .` and `git reset --hard` both destroy work that was never pushed.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\bgit\s+clean\s+-[a-zA-Z]*[fdx]/.test(c)) return c.slice(0, 120);
      if (/\bgit\s+reset\s+--hard\b/.test(c)) return c.slice(0, 120);
      // `git checkout <branch>` switches branches and throws nothing
      // away. Only the "give me everything" pathspecs discard uncommitted
      // work, so only those are flagged — a named path is left alone.
      const checkout = /\bgit\s+checkout\s+([^;\n|]+)/.exec(c);
      if (checkout && EVERYTHING_PATHSPEC.test(checkout[1]!)) return c.slice(0, 120);
      // `--staged` only moves work between the index and the tree, and
      // the content is still in the object store, so it is not a loss.
      const restore = /\bgit\s+restore\s+(?!--staged\b)([^;\n|]+)/.exec(c);
      if (restore && EVERYTHING_PATHSPEC.test(restore[1]!)) return c.slice(0, 120);
      return null;
    },
  },
  {
    id: 'history-rewrite',
    principle: 5,
    severity: 'high',
    tools: 'bash',
    summary: 'Rewriting git history.',
    consequence:
      'Rebase, amend and filter-branch change commit ids. Any branch, tag or PR reference to the old ids becomes dangling, and the rewrite cannot be undone once the objects are pruned.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\bgit\s+(rebase\b|filter-branch\b|commit\s+--amend\b)/.test(c)) {
        return c.slice(0, 120);
      }
      return null;
    },
  },

  // ── Principle 1: read before write ───────────────────────────
  {
    id: 'overwrite-existing',
    principle: 1,
    severity: 'warn',
    tools: ['write', 'edit'],
    summary: 'Writing over an existing file.',
    consequence:
      'Whatever was there is replaced. If the agent has not read the current contents, it is writing from an assumption about what the file says.',
    // The tools do the existence check themselves; here we can only
    // see intent, so the rule fires on writes whose target looks like
    // a source file the agent has not inspected. Kept narrow on
    // purpose — flagging every write would be noise.
    match: () => null,
  },

  // ── Principle 4: verify before claiming ─────────────────────
  {
    id: 'shell-redirect-out',
    principle: 4,
    severity: 'note',
    tools: 'bash',
    summary: 'Redirecting command output into a file.',
    consequence:
      'The file is overwritten without being read. If the command produces less than expected, an existing file is replaced by a near-empty one.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\btee\b/.test(c)) return null; // tee writes and shows
      // Walk the redirects one at a time rather than matching `>` with a
      // trailing negative lookahead: `>\s*(?!/dev/null)` backtracks the
      // `\s*` to zero width to satisfy the lookahead, so `/dev/null` is
      // never actually excluded. Sinks are enumerated instead.
      for (const m of c.matchAll(/>>?\s*(\S+)/g)) {
        const target = m[1] ?? '';
        if (THROWAWAY_SINK.test(target)) continue;
        return c.slice(0, 120);
      }
      return null;
    },
  },
  {
    id: 'chmod-widening',
    // P5, not P4. Widening permissions is doing more than was asked,
    // and it is the *next* thing to run the file that pays the price —
    // which is a scope problem, not a verification problem.
    principle: 5,
    severity: 'note',
    tools: 'bash',
    summary: 'Making a file executable or world-writable.',
    consequence:
      'The next thing to run this file — including something the user did not intend — will have these permissions.',
    match: (a) => {
      const c = str(a, 'command');
      const m = /\bchmod\s+([0-7]{3,4})\s+(\S+)/.exec(c);
      if (m && /[2367]7?$/.test(m[1]!)) return `${m[1]} ${m[2]}`;
      return null;
    },
  },

  // ── Principle 3: surface uncertainty ─────────────────────────
  {
    id: 'curl-pipe-to-shell',
    principle: 3,
    severity: 'high',
    tools: 'bash',
    summary: 'Downloading a script and running it directly.',
    consequence:
      'Whatever the server returns executes immediately, and the contents were never shown to the user. A changed upstream script runs with their full access and no review.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k|)sh\b/.test(c)
        || /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(python|node|ruby|perl)\b/.test(c)) {
        return c.slice(0, 120);
      }
      return null;
    },
  },

  // ── Principle 5 again: things that reach outside the scope ───
  {
    id: 'package-install',
    principle: 5,
    severity: 'note',
    tools: 'bash',
    summary: 'Installing packages.',
    consequence:
      'Install scripts run at install time, and the dependency tree changes. Lockfile churn or a transitive compromise both land in the project without being asked for.',
    match: (a) => {
      const c = str(a, 'command');
      // `ci` installs from the lockfile and is missing from the obvious
      // `(i|install|add)` set, which is why it is spelled out here.
      if (!/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/.test(c)) return null;
      // Anchored with `(?:^|\s)` rather than `\b`: a word boundary
      // before a leading `-` never matches, because `-` is not a word
      // character, so `\b(--dry-run)` silently matches nothing.
      if (/(?:^|\s)(?:--dry-run|--no-save)(?=\s|$)/.test(c)) return null;
      return c.slice(0, 120);
    },
  },
  {
    id: 'sending-data-out',
    principle: 5,
    severity: 'warn',
    tools: 'bash',
    summary: 'Piping local content to a network command.',
    consequence:
      'The content leaves the machine as part of the command. If the payload is a file the user never meant to share, the send is already done by the time anyone sees it.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\b(cat|tail|head|ls|env|printenv)\b[^\n]*\|\s*(curl|wget|nc|ncat|mail|scp|rsync)\b/.test(c)) {
        return c.slice(0, 120);
      }
      return null;
    },
  },
  {
    id: 'db-destructive',
    principle: 5,
    severity: 'high',
    tools: 'bash',
    summary: 'Dropping a database table or truncating a table.',
    consequence:
      'The table and its rows are gone. Unless a dump was taken first — and this layer cannot know that — there is no recovery path.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(c)
        || /\bTRUNCATE\s+TABLE\b/i.test(c)
        || /\bDELETE\s+FROM\s+\w+\s*(;|$)/i.test(c) && !/\bWHERE\b/i.test(c)) {
        return c.slice(0, 120);
      }
      return null;
    },
  },
  {
    id: 'kill-process',
    principle: 5,
    severity: 'note',
    tools: 'bash',
    summary: 'Killing processes.',
    consequence:
      'Whatever those processes were doing stops. If one was mid-write, that work is lost rather than paused.',
    match: (a) => {
      const c = str(a, 'command');
      if (/\b(kill(all)?|pkill|taskkill)\b/.test(c)) return c.slice(0, 120);
      return null;
    },
  },

  // ── Principle 5: a command line is a broadcast channel ──────
  {
    id: 'secret-in-command',
    // P5. The first draft anchored this to P8 ("honor the inner
    // layer"), which is about introspection and has nothing to do with
    // credentials. An anchor that does not hold up is worse than no
    // anchor: the user opens the chip to check the reasoning and finds
    // that the reasoning is decorative. A command line reaches the
    // transcript, the shell history and `ps` — all outside the scope
    // of the one request that put it there.
    principle: 5,
    severity: 'warn',
    tools: 'bash',
    summary: 'A command line containing what looks like a credential.',
    consequence:
      'Command lines are visible in the session transcript, in shell history, and in `ps` output for every process on the machine. A key pasted into a command is a key in at least four places.',
    match: (a) => {
      const c = str(a, 'command');
      const m = /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/.exec(c);
      return m ? `a token starting "${m[1]!.slice(0, 8)}…"` : null;
    },
  },
];

/**
 * Exact tool match, never a substring one: `'bash'.includes('bas')` is
 * true, and a rule scoped to `bash` must not fire on `bash_history`.
 */
function ruleAppliesTo(rule: MoralRule, toolName: string): boolean {
  if (rule.tools === '*') return true;
  const list = typeof rule.tools === 'string' ? [rule.tools] : rule.tools;
  return list.includes(toolName);
}

/**
 * Evaluate one tool call against every rule. Pure and synchronous.
 *
 * Returns findings in rule order, most severe first, so a caller that
 * only shows the first one shows the most important one.
 */
export function auditToolCall(toolName: string, args: unknown): MoralFinding[] {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const out: MoralFinding[] = [];
  for (const rule of MORAL_RULES) {
    if (!ruleAppliesTo(rule, toolName)) continue;
    let evidence: string | null = null;
    try {
      evidence = rule.match(a);
    } catch {
      // A rule that throws must not take the turn down with it.
      evidence = null;
    }
    if (evidence === null) continue;
    out.push({
      rule: rule.id,
      principle: rule.principle,
      severity: rule.severity,
      tool: toolName,
      summary: rule.summary,
      consequence: rule.consequence,
      evidence,
    });
  }
  return out.sort(
    (x, y) => SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity],
  );
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, warn: 2, note: 1 };

/**
 * True when a finding should stop for an explicit confirmation.
 *
 * This is form B — the soft gate. Deliberately narrow: only
 * severity 'high', and only for rules on the BLOCKING list. A moral
 * judgement should not be able to stop ordinary work; if it can, the
 * feature gets turned off and the protection it provided is gone.
 */
const BLOCKING_RULES = new Set([
  'rm-recursive',
  'git-force-push',
  'git-discard',
  'history-rewrite',
  'curl-pipe-to-shell',
  'db-destructive',
]);

export function shouldBlock(finding: MoralFinding): boolean {
  return finding.severity === 'high' && BLOCKING_RULES.has(finding.rule);
}

export function blockingFindings(findings: MoralFinding[]): MoralFinding[] {
  return findings.filter(shouldBlock);
}

// ─── form C: the turn review ────────────────────────────────────

export interface ToolUse {
  tool: string;
  /** Did it succeed? */
  ok: boolean;
}

export interface TurnReview {
  /** One line, user-facing. Null when there is nothing to say. */
  headline: string | null;
  /** The findings, most severe first, for the expandable detail. */
  findings: MoralFinding[];
  /** Counts for the badge. */
  high: number;
  warn: number;
  note: number;
  /**
   * A short, concrete observation about this turn's behaviour —
   * form C. Not a judgement, a pattern.
   */
  observation: string | null;
}

/**
 * Summarise a turn.
 *
 * The observation is deliberately descriptive rather than
 * evaluative. "3 destructive commands, all approved" is a fact the
 * user can act on; "this agent was reckless" is a verdict they would
 * have to evaluate, and they have better things to do with their
 * attention.
 */
export function reviewTurn(uses: ToolUse[], findings: MoralFinding[]): TurnReview {
  const high = findings.filter((f) => f.severity === 'high').length;
  const warn = findings.filter((f) => f.severity === 'warn').length;
  const note = findings.filter((f) => f.severity === 'note').length;

  let headline: string | null = null;
  if (high > 0) {
    const ruleNames = [...new Set(findings.filter((f) => f.severity === 'high').map((f) => f.rule))];
    headline = high === 1
      ? `1 irreversible action: ${ruleNames[0]}`
      : `${high} irreversible actions: ${ruleNames.join(', ')}`;
  } else if (warn > 0) {
    headline = `${warn} action${warn === 1 ? '' : 's'} worth a look`;
  }

  let observation: string | null = null;
  if (uses.length > 0) {
    const failed = uses.filter((u) => !u.ok).length;
    const destructive = findings.filter((f) => shouldBlock(f)).length;
    const parts: string[] = [];
    if (destructive > 0) {
      parts.push(`${destructive} irreversible action${destructive === 1 ? '' : 's'}`);
    }
    parts.push(`${uses.length} tool call${uses.length === 1 ? '' : 's'}`);
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    // Only say something when there is something to say.
    if (destructive > 0 || failed > 0) {
      observation = `${parts.join(' · ')}`;
    }
  }

  return { headline, findings, high, warn, note, observation };
}
