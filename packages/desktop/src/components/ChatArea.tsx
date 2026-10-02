/**
 * ChatArea — main message list.
 *
 * Re-renders the active session's event stream into user-visible
 * blocks:
 *   - User blocks (from synthetic text_delta we prepended on send)
 *   - Assistant blocks (the model's response, streamed in via
 *     text_delta events)
 *   - Thinking blocks (live during streaming, then collapsed to
 *     `💭 thought for Xs` after the turn ends — same as the old
 *     TUI's v1.1.7 collapse logic)
 *   - Tool blocks (showing tool name + input + output)
 *   - Info blocks (human-readable hints, errors)
 *
 * The events list is the "single source of truth" — when the user
 * switches sessions we reset the events and the new session's
 * history is replayed by App.tsx's useEffect.
 */

import { useEffect, useRef } from 'react';
import type { SessionEvent, MoralFindingWire } from '../lib/types';
import { Markdown } from './Markdown';
import { summarizeToolInput } from '../lib/tool-input';
import { DiffView } from './DiffView';
import { BlockBoundary } from './ErrorBoundary';

interface ChatAreaProps {
  events: SessionEvent[];
  userPrompts: string[];
  busy: boolean;
}

interface Block {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'info'
      | 'memory' | 'skills' | 'reflection' | 'compact' | 'subagent'
      | 'moral' | 'review';
  text: string;
  // For tool blocks:
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolError?: boolean;
  toolDurationMs?: number;
  /** v0.4: the line diff for write/edit, as it arrived on the wire. */
  toolDiff?: unknown;
  // For sub-agent blocks (v0.3). `subagentStep` is a human label for
  // what the sub-agent is doing right now; the raw event carries far
  // more than the UI needs to show.
  subagentModel?: string;
  subagentStep?: string;
  subagentError?: boolean;
  // For ambient event blocks (v3.6/v3.7):
  memoryFacts?: number;
  memoryPatterns?: number;
  memoryPrefs?: number;
  memoryQuery?: string;
  skillsList?: Array<{ name: string; score: number }>;
  reflectionKind?: 'error' | 'empty' | 'large';
  compactBefore?: number;
  compactAfter?: number;
  // For thinking:
  thinking?: string;
  thinkingElapsedMs?: number;
  // v0.4: the moral layer. `text` is the chip headline; the findings
  // carry the reasoning behind it, which the chip expands on demand.
  moralSeverity?: 'note' | 'warn' | 'high';
  moralFindings?: MoralFindingWire[];
  reviewHeadline?: string | null;
  reviewObservation?: string | null;
}

export function ChatArea({ events, userPrompts, busy }: ChatAreaProps) {
  const blocks = useMemoBlocks(events, userPrompts);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks.length, busy]);

  if (blocks.length === 0) {
    return (
      <div className="chat-area" ref={scrollRef}>
        <div className="empty">
          <h2>Deqi</h2>
          <p>Type a task below to start. Deqi can read, write, edit, and run shell commands on your behalf.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-area" ref={scrollRef}>
      {blocks.map((b, i) => (
        // v0.5: per-block boundary. The event stream is untrusted
        // input — it comes off a socket, from a model, describing tool
        // arguments. One malformed block used to blank the whole
        // conversation, including the messages above it that were
        // perfectly fine.
        <BlockBoundary key={i} label={`A message could not be displayed (${b.kind}).`}>
          <BlockView block={b} />
        </BlockBoundary>
      ))}
      {busy && <div className="busy">● working…</div>}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-author">❯ you</div>
        <div className="msg-body">{block.text}</div>
      </div>
    );
  }
  if (block.kind === 'assistant') {
    return (
      <div className="msg msg-assistant">
        <div className="msg-author">Deqi</div>
        <div className="msg-body">
          {/* v0.4: rendered as Markdown. It was plain text, so a reply
              containing a diff, a list or a fenced block arrived as
              one undifferentiated wall. */}
          <Markdown>{block.text}</Markdown>
        </div>
      </div>
    );
  }
  if (block.kind === 'thinking') {
    // v0.2: useMemoBlocks populates thinking text into `block.text`,
    // not `block.thinking` (which is a stale optional field on the
    // Block interface). Reading `block.text` shows the actual
    // reasoning; the `thinking…` placeholder only shows when both
    // are empty (e.g. an open streaming block).
    return (
      <div className="msg msg-thinking">
        💭 {block.text || 'thinking…'}
      </div>
    );
  }
  if (block.kind === 'tool') {
    // v0.4: the input used to be dumped as full JSON with no
    // disclosure, so a 400-line `write` buried the conversation. Now
    // the identifying field leads, bulk text is summarised, and the
    // raw input is one click away.
    const s = block.toolInput !== undefined
      ? summarizeToolInput(block.toolName ?? '', block.toolInput)
      : null;
    return (
      <div className={`msg msg-tool ${block.toolError ? 'error' : ''}`}>
        <div className="msg-tool-header">
          <span className="tool-name">⚙ {block.toolName ?? '?'}</span>
          {s && s.summary ? <span className="tool-summary">{s.summary}</span> : null}
          {block.toolDurationMs !== undefined && (
            <span className="tool-duration">{block.toolDurationMs}ms</span>
          )}
        </div>
        {s && (
          <details className="tool-input-details">
            <summary>input</summary>
            <pre className="tool-input">{s.preview}</pre>
          </details>
        )}
        {/* v0.4: what the write/edit actually changed. The tool's own
            one-line summary is below it; the diff is the part the
            user came to see. */}
        <DiffView raw={block.toolDiff} />
        {block.toolOutput && (
          <details className="tool-input-details" open={!!block.toolError}>
            <summary>
              output{block.toolError ? ' (error)' : ''}
            </summary>
            <pre className="tool-output">{block.toolOutput}</pre>
          </details>
        )}
      </div>
    );
  }
  if (block.kind === 'info') {
    return <div className="msg msg-info">{block.text}</div>;
  }
  if (block.kind === 'memory') {
    // v3.7: a small chip showing what the agent auto-pulled from
    // memory at the start of the turn. Compact, one-line.
    const parts: string[] = [];
    if (block.memoryFacts) parts.push(`${block.memoryFacts} fact${block.memoryFacts === 1 ? '' : 's'}`);
    if (block.memoryPatterns) parts.push(`${block.memoryPatterns} pattern${block.memoryPatterns === 1 ? '' : 's'}`);
    if (block.memoryPrefs) parts.push(`${block.memoryPrefs} pref${block.memoryPrefs === 1 ? '' : 's'}`);
    return (
      <div className="msg msg-chip msg-chip-memory" title={block.memoryQuery ?? ''}>
        <span className="chip-icon">🧠</span>
        <span className="chip-text">remembered {parts.join(', ') || 'nothing'}</span>
      </div>
    );
  }
  if (block.kind === 'skills') {
    return (
      <div className="msg msg-chip msg-chip-skills">
        <span className="chip-icon">🛠</span>
        <span className="chip-text">suggested {block.skillsList?.map((s) => `${s.name} (${s.score.toFixed(2)})`).join(', ')}</span>
      </div>
    );
  }
  if (block.kind === 'reflection') {
    // v3.7: tool-reflection hint. Rendered compact, dismissable-
    // looking. The user can ignore or read the hint.
    return (
      <div className="msg msg-chip msg-chip-reflection" data-kind={block.reflectionKind}>
        <span className="chip-icon">💡</span>
        <span className="chip-text">{block.text}</span>
      </div>
    );
  }
  if (block.kind === 'compact') {
    // v3.6: auto-context-compaction. Diagnostic, but useful.
    return (
      <div className="msg msg-chip msg-chip-compact">
        <span className="chip-icon">📦</span>
        <span className="chip-text">compacted: {block.compactBefore} → {block.compactAfter} tokens</span>
      </div>
    );
  }
  if (block.kind === 'subagent') {
    // v0.3: sub-agent progress. Indented and de-emphasised so it reads
    // as "the agent is working over there" rather than as part of the
    // main conversation. Without this the `subagent` tool block was
    // the only thing on screen for the whole run.
    return (
      <div
        className="msg msg-chip msg-chip-subagent"
        data-error={block.subagentError ? 'true' : 'false'}
        data-model={block.subagentModel}
      >
        <span className="chip-icon">⑂</span>
        <span className="chip-text">
          <span className="subagent-model">{block.subagentModel}</span>
          {' '}
          {block.subagentStep}
        </span>
      </div>
    );
  }
  if (block.kind === 'moral') {
    // v0.4, form A: a finding, shown as it happens.
    //
    // Collapsed by default so a run does not turn into a wall of
    // chips, but every finding expands to the principle it comes from
    // and the concrete consequence. A moral layer the user cannot read
    // is just a vibe; a moral layer that interrupts every tool call is
    // one they will switch off. `<details>` gives both without a line
    // of state.
    const findings = block.moralFindings ?? [];
    // With a single finding the headline above already says the
    // summary, so repeating it in the detail just makes the user read
    // the same sentence twice. With several, the summary is what tells
    // them apart, so it comes back.
    const showHeads = findings.length > 1;
    return (
      <details className="msg msg-chip msg-chip-moral" data-severity={block.moralSeverity}>
        <summary>
          <span className="chip-icon">{MORAL_ICON[block.moralSeverity ?? 'note']}</span>
          <span className="chip-text">{block.text}</span>
        </summary>
        <div className="moral-detail">
          {findings.map((f, i) => (
            <div className="moral-item" key={`${f.rule}-${i}`} data-severity={f.severity}>
              {showHeads ? (
                <div className="moral-item-head">
                  <strong>{f.summary}</strong>
                </div>
              ) : null}
              <p className="moral-consequence">{f.consequence}</p>
              {/* The principle is always shown, even for a single
                  finding: it is the handle the user needs in order to
                  disagree with the flag, which is the one thing that
                  has to survive the collapsed state. */}
              <span className="moral-principle">principle {f.principle}</span>
              {f.evidence ? <code className="moral-evidence">{f.evidence}</code> : null}
            </div>
          ))}
        </div>
      </details>
    );
  }
  if (block.kind === 'review') {
    // v0.4, form C: the retrospective. Descriptive by construction —
    // see the module comment in coding-agent/src/moral.ts. Counts are
    // shown only when non-zero, because "0 notes" is not information.
    const counts: string[] = [];
    if (block.moralFindings && block.moralFindings.length > 0) {
      const by = (s: string) => block.moralFindings!.filter((f) => f.severity === s).length;
      for (const s of ['high', 'warn', 'note'] as const) {
        const n = by(s);
        if (n > 0) counts.push(`${n} ${s}`);
      }
    }
    return (
      <details className="msg msg-chip msg-chip-review">
        <summary>
          <span className="chip-icon">⚖</span>
          <span className="chip-text">
            {block.reviewHeadline ?? block.reviewObservation ?? 'turn review'}
            {counts.length > 0 ? <span className="review-counts"> · {counts.join(' · ')}</span> : null}
          </span>
        </summary>
        <div className="moral-detail">
          {block.reviewObservation ? <p className="moral-consequence">{block.reviewObservation}</p> : null}
          {(block.moralFindings ?? []).map((f, i) => (
            <div className="moral-item" key={`${f.rule}-${i}`} data-severity={f.severity}>
              <div className="moral-item-head">
                <strong>{f.summary}</strong>
                <span className="moral-principle">principle {f.principle}</span>
              </div>
              <p className="moral-consequence">{f.consequence}</p>
            </div>
          ))}
        </div>
      </details>
    );
  }
  return null;
}

/** One icon per severity. Deliberately not a traffic light — a moral
 *  judgement rendered as red/amber/green invites reading it as a
 *  verdict, which is the thing this layer is not. */
const MORAL_ICON: Record<'note' | 'warn' | 'high', string> = {
  note: '◦',
  warn: '△',
  high: '◆',
};

// ─── events → blocks ────────────────────────────────────────────

/**
 * Walk `events` + `userPrompts` and return the rendered block
 * list. v2.2 fix: user prompts and assistant text deltas are
 * no longer merged into one block. Instead we pair them:
 *   userPrompts[i]  →  text_delta-run[i]   (in order)
 *
 * If the user has sent a prompt but the model hasn't responded
 * yet, we still emit the user block — the assistant block just
 * doesn't exist for that turn yet (the spinner takes its place).
 *
 * Tool / thinking / info blocks are emitted in their natural
 * position within the assistant's run for that turn.
 */
function useMemoBlocks(events: SessionEvent[], userPrompts: string[]): Block[] {
  // 1) Walk the events and split them into "turn buckets".
  //    A turn boundary is: agent_start, turn_start, or the
  //    start of a new text_delta run when we still have an
  //    unmatched user prompt. Each bucket holds the assistant's
  //    response to ONE user turn.
  type AmbientEvent =
    | { kind: 'memory'; facts: number; patterns: number; prefs: number; query: string }
    | { kind: 'skills'; skills: Array<{ name: string; score: number }> }
    | { kind: 'reflection'; toolName: string; hint: string; reflectionKind: 'error' | 'empty' | 'large' }
    | { kind: 'compact'; before: number; after: number }
    | { kind: 'subagent'; model: string; step: string; error: boolean }
    // v0.4: the moral layer. `text` is the chip headline; `findings`
    // carry the reasoning the chip expands to show.
    | { kind: 'moral'; text: string; severity: 'note' | 'warn' | 'high'; findings: MoralFindingWire[] }
    | {
        kind: 'review';
        headline: string | null;
        observation: string | null;
        findings: MoralFindingWire[];
      };

  interface Turn {
    textDeltas: string[];   // runs of text_delta, concatenated
    thinking: string;       // live thinking
    toolStarts: Array<{ name: string; input: unknown; toolUseId: string }>;
    toolEnds: Map<string, { output: string; is_error: boolean; duration_ms: number; diff?: unknown }>;
    info: string[];         // info lines
    ambient: AmbientEvent[]; // v3.6/v3.7 ambient events
  }
  const turns: Turn[] = [];
  let cur: Turn = { textDeltas: [], thinking: '', toolStarts: [], toolEnds: new Map(), info: [], ambient: [] };
  let i = 0;
  while (i < events.length) {
    const ev = events[i]!;
    if (ev.type === 'text_delta') {
      // New text run — finish the current turn and start a new one
      // ONLY IF there's still an unmatched user prompt waiting.
      // (If the user only sent one prompt and the model emits
      // multiple deltas, they all belong to the same turn — no
      // boundary. If the user sent N prompts, the Nth text run
      // is the response to prompt N-1.)
      if (cur.textDeltas.length > 0 || cur.thinking || cur.toolStarts.length > 0 || cur.info.length > 0 || cur.ambient.length > 0) {
        if (turns.length < userPrompts.length) {
          turns.push(cur);
          cur = { textDeltas: [], thinking: '', toolStarts: [], toolEnds: new Map(), info: [], ambient: [] };
        }
      }
      let text = ev.delta;
      i += 1;
      while (i < events.length && events[i]!.type === 'text_delta') {
        text += (events[i] as { delta: string }).delta;
        i += 1;
      }
      cur.textDeltas.push(text);
      continue;
    }
    if (ev.type === 'thinking_delta') {
      cur.thinking += ev.delta;
      i += 1;
      continue;
    }
    if (ev.type === 'tool_start') {
      cur.toolStarts.push({ name: ev.name, input: ev.input, toolUseId: ev.tool_use_id });
      i += 1;
      continue;
    }
    if (ev.type === 'tool_end') {
      cur.toolEnds.set(ev.tool_use_id, {
        output: ev.output, is_error: ev.is_error, duration_ms: ev.duration_ms,
      });
      i += 1;
      continue;
    }
    if (ev.type === 'info') {
      cur.info.push(ev.text);
      i += 1;
      continue;
    }
    if (ev.type === 'memory_retrieved') {
      cur.ambient.push({
        kind: 'memory',
        facts: ev.factCount,
        patterns: ev.patternCount,
        prefs: ev.prefCount,
        query: ev.query,
      });
      i += 1;
      continue;
    }
    if (ev.type === 'skills_suggested') {
      cur.ambient.push({ kind: 'skills', skills: ev.skills });
      i += 1;
      continue;
    }
    if (ev.type === 'tool_reflection') {
      cur.ambient.push({
        kind: 'reflection',
        toolName: ev.toolName,
        hint: ev.hint,
        reflectionKind: ev.kind,
      });
      i += 1;
      continue;
    }
    if (ev.type === 'context_compacted') {
      cur.ambient.push({ kind: 'compact', before: ev.tokensBefore, after: ev.tokensAfter });
      i += 1;
      continue;
    }
    if (ev.type === 'subagent_event') {
      // v0.3: this event was emitted by the server since v3.9.1 and
      // had no branch here, so it fell through to the final
      // `i += 1` and vanished. The visible effect: a `subagent` tool
      // call showed a spinner, then nothing at all until the whole
      // sub-agent finished and its final text appeared at once. A
      // two-minute sub-agent looked identical to a hang.
      const inner = ev.ev;
      let step = '';
      let error = false;
      if (inner.type === 'tool_execution_start') {
        step = `running ${inner.toolName ?? 'tool'}`;
      } else if (inner.type === 'tool_execution_end') {
        const failed = (inner as { result?: { isError?: boolean } }).result?.isError === true;
        step = failed ? `${inner.toolName ?? 'tool'} failed` : `${inner.toolName ?? 'tool'} done`;
        error = failed;
      } else if (inner.type === 'message_update') {
        const delta = inner.event?.type === 'text_delta' ? (inner.event.delta ?? '') : '';
        step = delta.trim() ? delta.trim().slice(0, 80) : 'thinking';
      } else if (inner.type === 'turn_start') {
        step = `turn ${inner.turn ?? '?'}`;
      } else if (inner.type === 'agent_start') {
        step = 'starting';
      } else {
        step = inner.type;
      }
      cur.ambient.push({ kind: 'subagent', model: ev.subagent.model, step, error });
      i += 1;
      continue;
    }
    if (ev.type === 'moral_audit') {
      // v0.4, form A. The server already sorted these most-severe
      // first, so the chip leads with the one that matters and the
      // rest are a click away.
      const top = ev.findings[0];
      if (top) {
        const text = ev.findings.length === 1
          ? top.summary
          : `${top.summary} (+${ev.findings.length - 1} more)`;
        cur.ambient.push({ kind: 'moral', text, severity: top.severity, findings: ev.findings });
      }
      i += 1;
      continue;
    }
    if (ev.type === 'turn_review') {
      // v0.4, form C. The server only sends this when there is
      // something to say, so there is no empty-state to filter here —
      // but an all-null review would render an empty chip, so it is
      // dropped here rather than trusted to the sender.
      if (ev.headline || ev.observation) {
        cur.ambient.push({
          kind: 'review',
          headline: ev.headline,
          observation: ev.observation,
          findings: ev.findings,
        });
      }
      i += 1;
      continue;
    }
    // agent_start / agent_end / turn_start / turn_end / tokens /
    // permission_* / reflection — not rendered as their own block
    i += 1;
  }
  // Flush the trailing turn
  if (cur.textDeltas.length > 0 || cur.thinking || cur.toolStarts.length > 0 || cur.info.length > 0 || cur.ambient.length > 0) {
    turns.push(cur);
  }

  // 2) Interleave: for each user prompt, render user block +
  //    the matching turn's blocks (if any).
  const blocks: Block[] = [];
  for (let n = 0; n < userPrompts.length; n += 1) {
    blocks.push({ kind: 'user', text: userPrompts[n]! });
    const turn = turns[n];
    if (!turn) continue;
    if (turn.thinking) blocks.push({ kind: 'thinking', text: turn.thinking });
    for (const t of turn.toolStarts) {
      const end = turn.toolEnds.get(t.toolUseId);
      blocks.push({
        kind: 'tool',
        text: '',
        toolName: t.name,
        toolInput: t.input,
        toolOutput: end?.output,
        toolError: end?.is_error ?? false,
        toolDurationMs: end?.duration_ms,
        toolDiff: end?.diff,
      });
    }
    for (const info of turn.info) {
      blocks.push({ kind: 'info', text: info });
    }
    for (const a of turn.ambient) {
      if (a.kind === 'memory') {
        blocks.push({
          kind: 'memory', text: '',
          memoryFacts: a.facts, memoryPatterns: a.patterns, memoryPrefs: a.prefs,
          memoryQuery: a.query,
        });
      } else if (a.kind === 'skills') {
        blocks.push({ kind: 'skills', text: '', skillsList: a.skills });
      } else if (a.kind === 'reflection') {
        blocks.push({
          kind: 'reflection', text: a.hint,
          reflectionKind: a.reflectionKind,
        });
      } else if (a.kind === 'compact') {
        blocks.push({
          kind: 'compact', text: '',
          compactBefore: a.before, compactAfter: a.after,
        });
      } else if (a.kind === 'subagent') {
        blocks.push({
          kind: 'subagent', text: a.step,
          subagentModel: a.model,
          subagentStep: a.step,
          subagentError: a.error,
        });
      } else if (a.kind === 'moral') {
        blocks.push({
          kind: 'moral', text: a.text,
          moralSeverity: a.severity,
          moralFindings: a.findings,
        });
      } else if (a.kind === 'review') {
        blocks.push({
          kind: 'review', text: a.headline ?? a.observation ?? '',
          reviewHeadline: a.headline,
          reviewObservation: a.observation,
          moralFindings: a.findings,
        });
      }
    }
    const assistantText = turn.textDeltas.join('');
    if (assistantText) blocks.push({ kind: 'assistant', text: assistantText });
  }
  // 3) Edge case: assistant turns with no user prompt (rare —
  //    shouldn't happen in v2.2, but render them so we don't
  //    drop data).
  for (let n = userPrompts.length; n < turns.length; n += 1) {
    const turn = turns[n]!;
    if (turn.thinking) blocks.push({ kind: 'thinking', text: turn.thinking });
    for (const info of turn.info) blocks.push({ kind: 'info', text: info });
    const assistantText = turn.textDeltas.join('');
    if (assistantText) blocks.push({ kind: 'assistant', text: assistantText });
  }
  return blocks;
}
