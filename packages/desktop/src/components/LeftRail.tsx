/**
 * deqi desktop — left rail (MiniMax-Code-style sidebar).
 *
 * Layout (v2.1):
 *   ┌─────────────────────────────┐
 *   │  ✦ New task                  │   <- top-level action
 *   │  ⌕ Search                    │
 *   │  ⏰ Schedule                  │
 *   │  ⊟ Plugins (v2.2)            │
 *   │  ⊞ Web (v2.2)                │
 *   │  ⌬ Mobile (phase 2)          │
 *   │  ⚙ Settings                  │
 *   ├─────────────────────────────┤
 *   │  Pinned                      │   <- project list
 *   │  • deqi                      │
 *   │  • longevity-agent           │
 *   │  • …                         │
 *   └─────────────────────────────┘
 *
 * Sessions sit inside the active project. Clicking a project
 * switches the project's session list. The list itself is
 * intentionally a *secondary* surface — the chat composer is
 * the focus.
 */

import { useEffect, useState } from 'react';

export type RailView =
  | 'chat'
  | 'search'
  | 'schedule'
  | 'plugins'
  | 'web'
  | 'mobile'
  | 'feedback'
  | 'settings';

interface RailItem {
  id: RailView;
  label: string;
  icon: string;
  badge?: 'phase2' | 'soon';
}

const ITEMS: RailItem[] = [
  { id: 'chat', label: 'New task', icon: '✦' },
  { id: 'search', label: 'Search', icon: '⌕' },
  { id: 'schedule', label: 'Schedule', icon: '⏰' },
  { id: 'plugins', label: 'Plugins', icon: '⊟', badge: 'soon' },
  { id: 'web', label: 'Web', icon: '⊞', badge: 'soon' },
  { id: 'mobile', label: 'Mobile', icon: '⌬', badge: 'phase2' },
  { id: 'feedback', label: 'Feedback', icon: '✉' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

interface Project {
  id: string;
  name: string;
  path: string;
  pinned?: boolean;
}

interface RecentSession {
  id: string;
  /** Last 6 chars of the id — short, click-stable. */
  shortId: string;
  /** Optional model + cwd-derived project name. */
  model?: string;
  projectName: string;
}

interface Props {
  view: RailView;
  onView: (v: RailView) => void;
  onNewTask: () => void;
  projects: Project[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onPinProject: (id: string) => void;
  recentSessions: RecentSession[];
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
}

export function LeftRail({
  view,
  onView,
  onNewTask,
  projects,
  activeProjectId,
  onSelectProject,
  recentSessions,
  activeSessionId,
  onOpenSession,
}: Props) {
  // Cmd/Ctrl+K jumps to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        onView('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onView]);

  const pinned = projects.filter((p) => p.pinned);
  const recent = projects.filter((p) => !p.pinned).slice(0, 12);

  return (
    <aside className="rail">
      <button className="rail-new" onClick={onNewTask}>
        <span className="rail-new-plus">✦</span>
        <span>New task</span>
        <span className="rail-new-kbd">⌘K</span>
      </button>

      <nav className="rail-nav">
        {ITEMS.map((it) => (
          <button
            key={it.id}
            className={'rail-item' + (view === it.id ? ' active' : '')}
            onClick={() => {
              if (it.id === 'chat') onNewTask();
              else onView(it.id);
            }}
          >
            <span className="rail-icon">{it.icon}</span>
            <span className="rail-label">{it.label}</span>
            {it.badge === 'phase2' && <span className="rail-badge phase2">phase 2</span>}
            {it.badge === 'soon' && <span className="rail-badge soon">soon</span>}
          </button>
        ))}
      </nav>

      {pinned.length > 0 && (
        <div className="rail-section">
          <div className="rail-section-label">Pinned</div>
          <ProjectList
            projects={pinned}
            activeId={activeProjectId}
            onSelect={onSelectProject}
          />
        </div>
      )}

      {recent.length > 0 && (
        <div className="rail-section">
          <div className="rail-section-label">Projects</div>
          <ProjectList
            projects={recent}
            activeId={activeProjectId}
            onSelect={onSelectProject}
          />
          {projects.length > recent.length && (
            <button className="rail-more">More →</button>
          )}
        </div>
      )}

      {recentSessions.length > 0 && (
        <div className="rail-section">
          <div className="rail-section-label">Recent tasks</div>
          <ul className="rail-projects rail-tasks">
            {recentSessions.slice(0, 8).map((s) => (
              <li
                key={s.id}
                className={'rail-task' + (s.id === activeSessionId ? ' active' : '')}
                onClick={() => onOpenSession(s.id)}
                title={`${s.projectName}${s.model ? ` · ${s.model}` : ''}`}
              >
                <span className="rail-task-icon">✦</span>
                <span className="rail-task-name">{s.shortId}</span>
                <span className="rail-task-sub">{s.projectName}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rail-footer">
        <div className="rail-footer-title">Deqi</div>
        <div className="rail-footer-sub">v3.9 · desktop</div>
      </div>
    </aside>
  );
}

function ProjectList({
  projects,
  activeId,
  onSelect,
}: {
  projects: Project[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="rail-projects">
      {projects.map((p) => (
        <li
          key={p.id}
          className={'rail-project' + (p.id === activeId ? ' active' : '')}
          title={p.path}
          onClick={() => onSelect(p.id)}
        >
          <span className="rail-project-icon">
            {p.pinned ? '★' : '○'}
          </span>
          <span className="rail-project-name">{p.name}</span>
        </li>
      ))}
    </ul>
  );
}
