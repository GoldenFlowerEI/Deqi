/**
 * session-view.ts — pure state transitions for the chat view.
 *
 * Why this is its own module
 * -------------------------
 * App.tsx is the one component with 0% test coverage, because
 * mounting it means standing up a WebSocket, a REST client and a
 * reducer around it. The logic that was actually broken lived there
 * and could not be reached by a test, so it lived untested.
 *
 * These are the two decisions that were wrong, extracted so they can
 * be asserted directly:
 *
 *   shouldApplyReplay() — v0.3. Opening a session fires a history
 *   fetch, which is not instantaneous. If the user sends a prompt
 *   before it returns, the old code assigned the replay over the
 *   top of the live stream: the assistant's output for the turn that
 *   was visibly streaming disappeared, and the prompt itself could
 *   vanish from the view, because the server had already snapshotted
 *   the history before persisting it.
 *
 *   nextSessionView() — v0.3. Switching sessions did not reset
 *   `busy`, so the spinner and the Stop button stayed on screen for a
 *   session that was idle — and Stop then aborted the *previous*
 *   session's turn, which was still the one the server was running.
 */

export interface SessionViewState {
  activeSessionId: string | null;
  events: unknown[];
  userPrompts: string[];
  busy: boolean;
}

/** The view as it stood when a history request went out. */
export interface ViewSnapshot {
  eventsAtStart: number;
  promptsAtStart: number;
}

export function snapshotView(state: SessionViewState): ViewSnapshot {
  return {
    eventsAtStart: state.events.length,
    promptsAtStart: state.userPrompts.length,
  };
}

/**
 * v0.3: true when a history replay may be written into the view.
 *
 * History is a backfill for a quiet view. It loses to the socket.
 * The `cancelled` flag already covers "the user switched sessions";
 * this covers "the user started talking while we were waiting".
 */
export function shouldApplyReplay(
  now: SessionViewState,
  snap: ViewSnapshot,
): boolean {
  // Anything arrived over the socket for this session.
  if (now.events.length !== snap.eventsAtStart) return false;
  // The user sent (or the view gained) a prompt since the request.
  if (now.userPrompts.length !== snap.promptsAtStart) return false;
  return true;
}

/**
 * v0.3: the state after switching to a different session.
 *
 * `busy` follows the session, not the app. A turn running in the
 * session you just left keeps running on the server; the view you are
 * now looking at is not busy, and its Stop button must not reach
 * across and abort the other one.
 */
export function nextSessionView<T extends SessionViewState>(
  state: T,
  sessionId: string | null,
): T {
  return {
    ...state,
    activeSessionId: sessionId,
    events: [],
    userPrompts: [],
    busy: false,
  };
}
