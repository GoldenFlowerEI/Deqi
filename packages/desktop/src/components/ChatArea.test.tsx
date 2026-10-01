/**
 * ChatArea.test.tsx — block rendering for every session-event
 * variant: user / assistant / thinking / tool / info / memory /
 * skills / reflection / compact. Also covers the welcome empty
 * state and the busy indicator.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatArea } from './ChatArea';
import type { SessionEvent } from '../lib/types';

function ev(partial: Partial<SessionEvent>): SessionEvent {
  return partial as SessionEvent;
}

describe('ChatArea', () => {
  it('renders the welcome empty state when no blocks', () => {
    render(<ChatArea events={[]} userPrompts={[]} busy={false} />);
    expect(screen.getByText('Deqi')).toBeInTheDocument();
    expect(screen.getByText(/Type a task below/)).toBeInTheDocument();
  });

  it('shows a busy indicator while the model is working', () => {
    const { container } = render(
      <ChatArea
        events={[]}
        userPrompts={['hello']}
        busy={true}
      />,
    );
    expect(container.querySelector('.busy')).toBeInTheDocument();
    expect(screen.getByText(/working/)).toBeInTheDocument();
  });

  it('renders a user message', () => {
    render(
      <ChatArea
        events={[]}
        userPrompts={['list files in /tmp']}
        busy={false}
      />,
    );
    expect(screen.getByText('list files in /tmp')).toBeInTheDocument();
    expect(screen.getByText(/you/)).toBeInTheDocument();
  });

  it('renders an assistant text response paired with a user prompt', () => {
    render(
      <ChatArea
        events={[
          ev({ type: 'text_delta', delta: 'hello there' } as any),
        ]}
        userPrompts={['hi']}
        busy={false}
      />,
    );
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText('hello there')).toBeInTheDocument();
    expect(screen.getByText('Deqi')).toBeInTheDocument();
  });

  it('concatenates multiple text_deltas into one assistant block', () => {
    render(
      <ChatArea
        events={[
          ev({ type: 'text_delta', delta: 'hello ' } as any),
          ev({ type: 'text_delta', delta: 'there' } as any),
          ev({ type: 'text_delta', delta: ' friend' } as any),
        ]}
        userPrompts={['hi']}
        busy={false}
      />,
    );
    expect(screen.getByText('hello there friend')).toBeInTheDocument();
  });

  it('renders a thinking block with the actual reasoning text', () => {
    const { container } = render(
      <ChatArea
        events={[
          ev({ type: 'thinking_delta', delta: 'reasoning step' } as any),
          ev({ type: 'text_delta', delta: 'answer' } as any),
        ]}
        userPrompts={['q']}
        busy={false}
      />,
    );
    // v0.2 fix: the renderer used to read block.thinking (always
    // undefined, since useMemoBlocks writes block.text). It now
    // reads block.text, so the actual reasoning string surfaces.
    const thinkingBlock = container.querySelector('.msg-thinking');
    expect(thinkingBlock).toBeInTheDocument();
    expect(thinkingBlock?.textContent).toContain('💭');
    expect(thinkingBlock?.textContent).toContain('reasoning step');
    expect(screen.getByText('answer')).toBeInTheDocument();
  });

  it('falls back to the "thinking…" placeholder when the text is empty', () => {
    const { container } = render(
      <ChatArea
        events={[
          ev({ type: 'text_delta', delta: 'no thinking yet' } as any),
        ]}
        userPrompts={['q']}
        busy={false}
      />,
    );
    // No thinking_delta was emitted, so no thinking block exists.
    expect(container.querySelector('.msg-thinking')).not.toBeInTheDocument();
  });

  it('renders a tool block with input + output + duration', () => {
    const { container } = render(
      <ChatArea
        events={[
          ev({ type: 'tool_start', name: 'read', input: { path: '/etc/hosts' }, tool_use_id: 't1' } as any),
          ev({ type: 'tool_end', output: '127.0.0.1 localhost', is_error: false, duration_ms: 42, tool_use_id: 't1' } as any),
        ]}
        userPrompts={['read it']}
        busy={false}
      />,
    );
    const toolBlock = container.querySelector('.msg-tool')!;
    expect(toolBlock.textContent).toMatch(/read/);
    expect(screen.getByText('42ms')).toBeInTheDocument();
    expect(toolBlock.textContent).toMatch(/127.0.0.1 localhost/);
  });

  it('marks a failing tool with the error class', () => {
    const { container } = render(
      <ChatArea
        events={[
          ev({ type: 'tool_start', name: 'bash', input: { cmd: 'false' }, tool_use_id: 't1' } as any),
          ev({ type: 'tool_end', output: 'command failed', is_error: true, duration_ms: 12, tool_use_id: 't1' } as any),
        ]}
        userPrompts={['run']}
        busy={false}
      />,
    );
    expect(container.querySelector('.msg-tool.error')).toBeInTheDocument();
  });

  it('renders an info block', () => {
    render(
      <ChatArea
        events={[
          ev({ type: 'info', text: 'permission needed: bash' } as any),
        ]}
        userPrompts={['run']}
        busy={false}
      />,
    );
    expect(screen.getByText('permission needed: bash')).toBeInTheDocument();
  });

  it('renders a memory_retrieved ambient chip', () => {
    render(
      <ChatArea
        events={[
          ev({ type: 'memory_retrieved', factCount: 3, patternCount: 1, prefCount: 2, query: 'q' } as any),
        ]}
        userPrompts={['q']}
        busy={false}
      />,
    );
    expect(screen.getByText(/remembered 3 facts, 1 pattern, 2 prefs/)).toBeInTheDocument();
  });

  it('renders a skills_suggested ambient chip', () => {
    render(
      <ChatArea
        events={[
          ev({ type: 'skills_suggested', skills: [{ name: 'commit-message', score: 0.07 }] } as any),
        ]}
        userPrompts={['q']}
        busy={false}
      />,
    );
    expect(screen.getByText(/commit-message \(0.07\)/)).toBeInTheDocument();
  });

  it('renders a tool_reflection ambient chip with kind=data', () => {
    render(
      <ChatArea
        events={[
          ev({ type: 'tool_reflection', toolName: 'grep', hint: 'no matches', kind: 'empty' } as any),
        ]}
        userPrompts={['q']}
        busy={false}
      />,
    );
    expect(screen.getByText('no matches')).toBeInTheDocument();
  });

  it('renders a context_compacted ambient chip with token counts', () => {
    render(
      <ChatArea
        events={[
          ev({ type: 'context_compacted', tokensBefore: 4000, tokensAfter: 800 } as any),
        ]}
        userPrompts={['q']}
        busy={false}
      />,
    );
    expect(screen.getByText(/compacted: 4000 → 800 tokens/)).toBeInTheDocument();
  });

  // ─── sub-agent progress (v0.3) ───────────────────────────────
  //
  // The server emitted `subagent_event` since v3.9.1. The desktop's
  // SessionEvent union did not contain it and useMemoBlocks had no
  // branch, so every sub-agent event fell through to `i += 1` and
  // was dropped. The visible symptom: a `subagent` tool block, then
  // a long silence, then the final text all at once — a running
  // sub-agent looked exactly like a hang.
  describe('subagent_event', () => {
    const sub = (inner: Record<string, unknown>, model = 'MiniMax-M3') =>
      ev({ type: 'subagent_event', subagent: { model, cwd: '/proj' }, ev: inner } as any);

    it('renders a chip when the sub-agent starts a tool', () => {
      const { container } = render(
        <ChatArea
          events={[sub({ type: 'tool_execution_start', toolName: 'grep' })]}
          userPrompts={['q']}
          busy={false}
        />,
      );
      expect(container.querySelector('.msg-chip-subagent')).toBeInTheDocument();
      expect(screen.getByText(/running grep/)).toBeInTheDocument();
    });

    it('shows the model that is doing the work', () => {
      render(
        <ChatArea
          events={[sub({ type: 'agent_start' }, 'Sonnet-4')]}
          userPrompts={['q']}
          busy={false}
        />,
      );
      expect(screen.getByText('Sonnet-4')).toBeInTheDocument();
      expect(screen.getByText(/starting/)).toBeInTheDocument();
    });

    it('previews streamed sub-agent text', () => {
      render(
        <ChatArea
          events={[sub({
            type: 'message_update',
            event: { type: 'text_delta', delta: 'reading the config file' },
          })]}
          userPrompts={['q']}
          busy={false}
        />,
      );
      expect(screen.getByText(/reading the config file/)).toBeInTheDocument();
    });

    it('marks a failed sub-agent tool as an error', () => {
      const { container } = render(
        <ChatArea
          events={[sub({
            type: 'tool_execution_end',
            toolName: 'bash',
            result: { content: [], isError: true },
          })]}
          userPrompts={['q']}
          busy={false}
        />,
      );
      const chip = container.querySelector('.msg-chip-subagent');
      expect(chip).toHaveAttribute('data-error', 'true');
      expect(screen.getByText(/bash failed/)).toBeInTheDocument();
    });

    it('renders one chip per event, so progress is visible while running', () => {
      const { container } = render(
        <ChatArea
          events={[
            sub({ type: 'agent_start' }),
            sub({ type: 'tool_execution_start', toolName: 'read' }),
            sub({ type: 'tool_execution_end', toolName: 'read', result: { content: [] } }),
          ]}
          userPrompts={['q']}
          busy={false}
        />,
      );
      expect(container.querySelectorAll('.msg-chip-subagent')).toHaveLength(3);
    });
  });
});