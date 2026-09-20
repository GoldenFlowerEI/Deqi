/**
 * deqi desktop — v2.1 main shell.
 *
 * The new layout (MiniMax-Code-inspired):
 *
 *   ┌────────┬────────────────────────────────────────────────┐
 *   │        │  status bar                                    │
 *   │  Rail  │  ─────────────────────────────────────────────  │
 *   │  (4    │                                                │
 *   │  nav + │  active view (chat | search | schedule |       │
 *   │  proj) │  settings | mobile)                            │
 *   │        │                                                │
 *   │        │  composer (with model picker + slash menu)     │
 *   └────────┴────────────────────────────────────────────────┘
 *
 * The rail carries project metadata; views are route-based
 * and lazy. We keep all session + WS state at the App level
 * so navigating between views doesn't lose chat context.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { DeqiApi } from './lib/api';
import { DeqiWebSocket, type WsConnectionState as WsState } from './lib/ws';
import type {
  ModelInfo,
  ScheduleItem,
  ScheduleCadence,
  ServerConfig,
  SessionEvent,
  SessionSummary,
} from './lib/types';
import { LeftRail, type RailView } from './components/LeftRail';
import { ChatView } from './components/ChatView';
import { SearchView } from './components/SearchView';
import { ScheduleView } from './components/ScheduleView';
import { SettingsView } from './components/SettingsView';
import { MobileView } from './components/MobileView';
import { FeedbackView } from './components/FeedbackView';

interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  pinned?: boolean;
}

const API_BASE = (import.meta.env['VITE_Deqi_API'] as string) ?? 'http://127.0.0.1:7700';
const WS_BASE = (import.meta.env['VITE_Deqi_WS'] as string) ?? 'ws://127.0.0.1:7700/v1/chat';

interface AppState {
  connection: WsState;
  connectionInfo?: string;
  config: ServerConfig | null;
  models: ModelInfo[];
  activeModel: string;
  projects: ProjectInfo[];
  activeProjectId: string | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /**
   * Wire events streamed from the server. In v2.2 we keep
   * the user's prompt text in a parallel `userPrompts`
   * array so ChatArea can render user blocks and assistant
   * blocks as distinct rows instead of one coalesced blob.
   */
  events: SessionEvent[];
  /**
   * One entry per user turn, in send order. Pushed by
   * handleSend; cleared when switching sessions / starting
   * a new task. The i-th entry is the user prompt for the
   * i-th turn; events[] is the assistant's streamed response
   * to that turn.
   */
  userPrompts: string[];
  draft: string;
  busy: boolean;
  view: RailView;
}

export function App() {
  const apiRef = useRef(new DeqiApi(API_BASE));
  const wsRef = useRef<DeqiWebSocket | null>(null);

  const [state, setState] = useState<AppState>({
    connection: 'closed',
    config: null,
    models: [],
    activeModel: '—',
    projects: [],
    activeProjectId: null,
    sessions: [],
    activeSessionId: null,
    events: [],
    userPrompts: [],
    draft: '',
    busy: false,
    view: 'chat',
  });

  // ─── WebSocket ────────────────────────────────────────────────
  const onConn = useCallback((s: WsState, info?: string) => {
    setState((st) => ({ ...st, connection: s, connectionInfo: info }));
  }, []);
  const onEvent = useCallback((sessionId: string, event: SessionEvent) => {
    setState((st) => {
      if (st.activeSessionId !== sessionId) return st;
      // Reset `busy` when the agent is done with this turn. The
      // composer disables itself while `busy` is true, so without
      // this reset the user can only continue after clicking Stop.
      // We reset on:
      //   - turn_end with any non-tool_use stop_reason (end_turn /
      //     max_tokens / max_turns / aborted / error)
      //   - agent_end (the whole run finished)
      // We do NOT reset on turn_end with stop_reason=tool_use —
      // the agent is still working, just between tool calls.
      let nextBusy = st.busy;
      if (event.type === 'turn_end' && event.stop_reason !== 'tool_use') {
        nextBusy = false;
      } else if (event.type === 'agent_end') {
        nextBusy = false;
      }
      return { ...st, busy: nextBusy, events: [...st.events, event] };
    });
  }, []);
  const onWsErr = useCallback((message: string) => {
    setState((st) => ({ ...st, connectionInfo: message }));
  }, []);

  useEffect(() => {
    const ws = new DeqiWebSocket(
      { onConnectionChange: onConn, onSessionEvent: onEvent, onError: onWsErr },
      WS_BASE,
    );
    wsRef.current = ws;
    ws.connect();
    return () => ws.disconnect();
  }, [onConn, onEvent, onWsErr]);

  // ─── Initial REST load: config + models + sessions + projects ─
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [config, { models }, { sessions }] = await Promise.all([
          apiRef.current.getConfig(),
          apiRef.current.listModels(),
          apiRef.current.listSessions(),
        ]);
        if (cancelled) return;
        const latest = sessions.find((s) => s.is_latest) ?? sessions[0] ?? null;
        // Build a project list from the unique cwds in the user's
        // session history, most recent first.
        const projectMap = new Map<string, ProjectInfo>();
        for (const s of sessions) {
          const id = cwdToProjectId(s.cwd);
          if (!projectMap.has(id)) {
            projectMap.set(id, {
              id,
              name: projectNameFromCwd(s.cwd),
              path: s.cwd,
            });
          }
        }
        const projects = Array.from(projectMap.values()).slice(0, 30);
        setState((st) => ({
          ...st,
          config,
          models,
          activeModel: config.default_model,
          projects,
          activeProjectId: projects[0]?.id ?? null,
          sessions,
          activeSessionId: latest?.id ?? null,
        }));
      } catch (err) {
        if (cancelled) return;
        setState((st) => ({ ...st, connectionInfo: `load failed: ${(err as Error).message}` }));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── Replay messages when active session changes ────────────
  // v2.2: split user-role messages into `userPrompts` and
  // assistant-role messages into the events stream. The
  // ChatArea then interleaves them per turn.
  useEffect(() => {
    const id = state.activeSessionId;
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const { messages } = await apiRef.current.getSessionMessages(id);
        if (cancelled) return;
        const userPrompts: string[] = [];
        const events: SessionEvent[] = [];
        for (const m of messages) {
          const text = extractText(m.content);
          if (!text) continue;
          if (m.role === 'user') {
            userPrompts.push(text);
          } else if (m.role === 'assistant') {
            events.push({ type: 'text_delta', delta: text } as SessionEvent);
          }
        }
        setState((st) => ({ ...st, userPrompts, events }));
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [state.activeSessionId]);

  // ─── View routing ────────────────────────────────────────────
  const setView = useCallback((v: RailView) => {
    setState((st) => ({ ...st, view: v }));
  }, []);

  // ─── New task ─────────────────────────────────────────────────
  // v2.2 fix: abort the previous session if it was still busy
  // (otherwise the Stop button on the new task would silently
  // kill the old turn and the new composer inherits the busy
  // state). Also clear `busy` + `userPrompts` so the new
  // session starts clean.
  const handleNewTask = useCallback(async () => {
    // Snapshot the current busy state so we can decide whether
    // to send an abort — but the state capture is from the
    // closure, so we read via stateRef in case it's stale.
    const snapshot = stateRef.current;
    if (snapshot.busy && snapshot.activeSessionId) {
      try {
        wsRef.current?.send({ type: 'abort', session_id: snapshot.activeSessionId });
      } catch { /* ignore — the server may already have finished */ }
    }
    const { session } = await apiRef.current.createSession();
    setState((st) => ({
      ...st,
      sessions: [session as unknown as SessionSummary, ...st.sessions],
      activeSessionId: session.id,
      events: [],
      userPrompts: [],
      draft: '',
      busy: false,
      view: 'chat',
    }));
  }, []);

  // Mutable ref so handleNewTask's closure sees the latest
  // busy / activeSessionId without depending on them (which
  // would re-create the callback on every state change and
  // re-trigger the click handler chain).
  const stateRef = useRef(state);
  stateRef.current = state;

  const handleOpenSession = useCallback((id: string) => {
    setState((st) => ({ ...st, activeSessionId: id, view: 'chat', events: [], userPrompts: [] }));
  }, []);

  const handleSelectProject = useCallback((id: string) => {
    setState((st) => {
      const project = st.projects.find((p) => p.id === id);
      if (!project) return st;
      // Filter sessions for the selected project
      const sessions = st.sessions.filter((s) => cwdToProjectId(s.cwd) === id);
      const first = sessions[0];
      return {
        ...st,
        activeProjectId: id,
        sessions,
        activeSessionId: first?.id ?? null,
        events: [],
        userPrompts: [],
        view: 'chat',
      };
    });
  }, []);

  const handleSetDraft = useCallback((s: string) => {
    setState((st) => ({ ...st, draft: s }));
  }, []);

  const handleSend = useCallback(() => {
    const id = state.activeSessionId;
    if (!id || !state.draft.trim() || state.busy) return;
    const text = state.draft;
    // v2.2: send the active model on every user_message. The
    // server applies it as a per-turn override via agent.setModel()
    // and reverts to the runner's default after the turn. This
    // way the composer's model picker controls the next turn
    // without mutating the persisted default.
    const model = state.activeModel && state.activeModel !== '—' ? state.activeModel : undefined;
    // v2.2 fix: the user's prompt goes into a parallel
    // `userPrompts` array, NOT into the events stream. The
    // events array is now purely the server's wire stream
    // (text_delta, tool_start/end, info, etc.) — ChatArea
    // interleaves userPrompts with the assistant text_delta
    // runs so the user prompt and the assistant reply render
    // as distinct blocks.
    setState((st) => ({
      ...st,
      draft: '',
      busy: true,
      userPrompts: [...st.userPrompts, text],
    }));
    try {
      wsRef.current?.send({ type: 'user_message', session_id: id, text, ...(model ? { model } : {}) });
    } catch (err) {
      setState((st) => ({ ...st, busy: false, connectionInfo: `send failed: ${(err as Error).message}` }));
    }
  }, [state.activeSessionId, state.draft, state.busy, state.activeModel]);

  const handleAbort = useCallback(() => {
    if (!state.activeSessionId) return;
    try {
      wsRef.current?.send({ type: 'abort', session_id: state.activeSessionId });
    } catch { /* ignore */ }
    setState((st) => ({ ...st, busy: false }));
  }, [state.activeSessionId]);

  const handleConfigChange = useCallback((cfg: ServerConfig) => {
    setState((st) => ({ ...st, config: cfg }));
  }, []);

  const handleModelChange = useCallback((id: string) => {
    setState((st) => ({ ...st, activeModel: id }));
  }, []);

  // ─── Render ───────────────────────────────────────────────────
  let viewEl;
  if (state.view === 'chat') {
    viewEl = (
      <ChatView
        api={apiRef.current}
        events={state.events}
        userPrompts={state.userPrompts}
        busy={state.busy}
        draft={state.draft}
        setDraft={handleSetDraft}
        onSend={handleSend}
        onAbort={handleAbort}
        config={state.config}
        models={state.models}
        activeModel={state.activeModel}
        onModelChange={handleModelChange}
        connection={state.connection}
        connectionInfo={state.connectionInfo}
        activeSession={state.sessions.find((s) => s.id === state.activeSessionId) ?? null}
      />
    );
  } else if (state.view === 'search') {
    viewEl = (
      <SearchView
        api={apiRef.current}
        onOpenSession={handleOpenSession}
      />
    );
  } else if (state.view === 'schedule') {
    viewEl = <ScheduleView api={apiRef.current} />;
  } else if (state.view === 'settings') {
    viewEl = (
      <SettingsView
        api={apiRef.current}
        config={state.config}
        models={state.models}
        onConfigChange={handleConfigChange}
      />
    );
  } else if (state.view === 'mobile') {
    viewEl = <MobileView api={apiRef.current} />;
  } else if (state.view === 'feedback') {
    viewEl = (
      <FeedbackView
        api={apiRef.current}
        surface="left-rail"
        sessionId={state.activeSessionId}
      />
    );
  } else {
    viewEl = (
      <div className="view view-soon">
        <div className="view-header">
          <h2>{state.view}</h2>
          <span className="phase-pill">soon</span>
        </div>
        <p>Coming soon. v2.2 will land it.</p>
      </div>
    );
  }

  return (
    <div className="app-v2">
      <LeftRail
        view={state.view}
        onView={setView}
        onNewTask={handleNewTask}
        projects={state.projects}
        activeProjectId={state.activeProjectId}
        onSelectProject={handleSelectProject}
        onPinProject={() => { /* TODO: persist pinned projects */ }}
        recentSessions={state.sessions.slice(0, 8).map((s) => ({
          id: s.id,
          shortId: s.id.length > 6 ? s.id.slice(-6) : s.id,
          model: s.model,
          projectName: projectNameFromCwd(s.cwd),
        }))}
        activeSessionId={state.activeSessionId}
        onOpenSession={handleOpenSession}
      />
      <main className="main-v2">
        {viewEl}
      </main>
    </div>
  );
}

// ─── helpers ───────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') {
          return (b as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function cwdToProjectId(cwd: string): string {
  // Stable, URL-safe, short.
  return 'p_' + cwd.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
}

function projectNameFromCwd(cwd: string): string {
  // Show the last 2 path segments as the friendly project name.
  // e.g. "C:\Users\P1\projects\deqi" → "projects/deqi"
  //      "/home/user/work/hardproblems" → "work/hardproblems"
  const norm = cwd.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length === 0) return cwd;
  if (parts.length === 1) return parts[0];
  return parts.slice(-2).join('/');
}
