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
import type { SessionEvent } from '../lib/types';

interface ChatAreaProps {
  events: SessionEvent[];
  userPrompts: string[];
  busy: boolean;
}

interface Block {
  kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'info'
      | 'memory' | 'skills' | 'reflection' | 'compact';
  text: string;
  // For tool blocks:
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolError?: boolean;
  toolDurationMs?: number;
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
        <BlockView key={i} block={b} />
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
        <div className="msg-body">{block.text}</div>
      </div>
    );
  }
  if (block.kind === 'thinking') {
    return (
      <div className="msg msg-thinking">
        💭 {block.thinking || 'thinking…'}
      </div>
    );
  }
  if (block.kind === 'tool') {
    return (
      <div className={`msg msg-tool ${block.toolError ? 'error' : ''}`}>
        <div className="msg-tool-header">
          <span className="tool-name">⚙ {block.toolName ?? '?'}</span>
          {block.toolDurationMs !== undefined && (
            <span className="tool-duration">{block.toolDurationMs}ms</span>
          )}
        </div>
        {block.toolInput !== undefined && (
          <pre className="tool-input">{JSON.stringify(block.toolInput, null, 2)}</pre>
        )}
        {block.toolOutput && (
          <pre className="tool-output">{block.toolOutput}</pre>
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
  return null;
}

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
    | { kind: 'compact'; before: number; after: number };

  interface Turn {
    textDeltas: string[];   // runs of text_delta, concatenated
    thinking: string;       // live thinking
    toolStarts: Array<{ name: string; input: unknown; toolUseId: string }>;
    toolEnds: Map<string, { output: string; is_error: boolean; duration_ms: number }>;
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
