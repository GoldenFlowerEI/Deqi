/**
 * SessionSidebar — left rail with the list of past sessions.
 * Matches goose's layout: a "New session" button at the top,
 * then a chronologically sorted list of session previews
 * (most recent first). Clicking a session makes it active.
 */

import type { SessionSummary } from '../lib/types';

interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const sec = Math.round((now - d.getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

export function SessionSidebar({ sessions, activeId, onSelect, onNew }: SessionSidebarProps) {
  return (
    <aside className="sidebar">
      <button className="new-session-btn" onClick={onNew} title="Start a new session (Ctrl+N)">
        <span className="plus">+</span> New session
      </button>
      <ul className="session-list">
        {sessions.length === 0 && (
          <li className="session-empty">No sessions yet</li>
        )}
        {sessions.map((s) => {
          const isActive = s.id === activeId;
          return (
            <li
              key={s.id}
              className={`session-row ${isActive ? 'active' : ''}`}
              onClick={() => onSelect(s.id)}
            >
              <div className="session-title">
                {truncate(s.cwd.split(/[/\\]/).pop() || s.cwd, 32)}
              </div>
              <div className="session-meta">
                <span className="session-model">{s.model}</span>
                <span className="session-time">{formatRelative(s.created_at)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
