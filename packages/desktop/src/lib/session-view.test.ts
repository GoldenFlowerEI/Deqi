/**
 * session-view.test.ts — the two state decisions that were wrong and
 * could not be reached from a component test, because App.tsx needs a
 * WebSocket and a REST client mounted around it.
 */
import { describe, expect, it } from 'vitest';
import {
  snapshotView,
  shouldApplyReplay,
  nextSessionView,
  type SessionViewState,
} from './session-view';

function view(over: Partial<SessionViewState> = {}): SessionViewState {
  return {
    activeSessionId: 's1',
    events: [],
    userPrompts: [],
    busy: false,
    ...over,
  };
}

describe('shouldApplyReplay', () => {
  it('applies a replay to a view that has not moved', () => {
    const v = view();
    expect(shouldApplyReplay(v, snapshotView(v))).toBe(true);
  });

  it('refuses when live events arrived while the history was in flight', () => {
    // The bug: the user opened a session and sent a prompt before
    // getSessionMessages returned. The socket had already delivered
    // the assistant's output, and the replay assignment replaced it —
    // so a visibly streaming turn appeared to produce nothing.
    const atStart = view({ userPrompts: ['hello'] });
    const snap = snapshotView(atStart);
    const now = view({
      userPrompts: ['hello'],
      events: [{ type: 'text_delta', delta: 'working' }],
    });
    expect(shouldApplyReplay(now, snap)).toBe(false);
  });

  it('refuses when the user sent a prompt while the history was in flight', () => {
    // The server persists the user message immediately, but the
    // history response was already snapshotted server-side, so
    // replaying it dropped the prompt from the view entirely.
    const atStart = view();
    const snap = snapshotView(atStart);
    const now = view({ userPrompts: ['a brand new prompt'] });
    expect(shouldApplyReplay(now, snap)).toBe(false);
  });

  it('refuses when both moved', () => {
    const atStart = view();
    const snap = snapshotView(atStart);
    const now = view({ userPrompts: ['x'], events: [{ type: 'text_delta' }] });
    expect(shouldApplyReplay(now, snap)).toBe(false);
  });

  it('allows the replay when the view shrank back to the snapshot size', () => {
    // Switching sessions clears the view; the effect is keyed on
    // activeSessionId so the stale fetch is cancelled anyway, but the
    // guard should not depend on that to be correct.
    const atStart = view({ events: [1, 2], userPrompts: ['a'] });
    const snap = snapshotView(atStart);
    expect(shouldApplyReplay(view({ events: [1, 2], userPrompts: ['a'] }), snap)).toBe(true);
  });
});

describe('nextSessionView', () => {
  it('clears the transcript and the busy flag', () => {
    const before = view({
      activeSessionId: 's1',
      events: [{ type: 'text_delta' }],
      userPrompts: ['hello'],
      busy: true,
    });
    const after = nextSessionView(before, 's2');
    expect(after.activeSessionId).toBe('s2');
    expect(after.events).toEqual([]);
    expect(after.userPrompts).toEqual([]);
    // The bug: busy survived the switch, so the spinner and the Stop
    // button stayed on screen for a session that was idle — and Stop
    // then aborted the previous session's still-running turn.
    expect(after.busy).toBe(false);
  });

  it('does not mutate the input', () => {
    const before = view({ busy: true, userPrompts: ['a'] });
    nextSessionView(before, 's2');
    expect(before.busy).toBe(true);
    expect(before.userPrompts).toEqual(['a']);
  });

  it('preserves unrelated state', () => {
    type Extra = SessionViewState & { view: string; draft: string };
    const before: Extra = { ...view(), view: 'search', draft: 'in progress' };
    const after = nextSessionView(before, 's2');
    expect(after.view).toBe('search');
    expect(after.draft).toBe('in progress');
  });

  it('handles a null session id (project with no sessions)', () => {
    const after = nextSessionView(view({ busy: true }), null);
    expect(after.activeSessionId).toBeNull();
    expect(after.busy).toBe(false);
  });
});
