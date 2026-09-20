/**
 * LeftRail.test.tsx — covers navigation rendering, click handlers,
 * project + recent-session lists, Cmd/Ctrl+K shortcut.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LeftRail, type RailView } from './LeftRail';

const noop = () => {};

function renderRail(overrides: Partial<Parameters<typeof LeftRail>[0]> = {}) {
  const props = {
    view: 'chat' as RailView,
    onView: vi.fn(),
    onNewTask: vi.fn(),
    projects: [],
    activeProjectId: null,
    onSelectProject: vi.fn(),
    onPinProject: vi.fn(),
    recentSessions: [],
    activeSessionId: null,
    onOpenSession: vi.fn(),
    ...overrides,
  };
  return render(<LeftRail {...props} />);
}

describe('LeftRail', () => {
  it('renders the 8 nav items by default', () => {
    renderRail();
    // 'New task' appears twice (top big button + nav list); use getAllByText
    expect(screen.getAllByText('New task').length).toBeGreaterThanOrEqual(1);
    for (const label of ['Search', 'Schedule', 'Plugins', 'Web', 'Mobile', 'Feedback', 'Settings']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders the "soon" and "phase 2" badges', () => {
    renderRail();
    expect(screen.getAllByText('soon')).toHaveLength(2);
    expect(screen.getAllByText('phase 2')).toHaveLength(1);
  });

  it('marks the active view with the active class', () => {
    renderRail({ view: 'search' });
    const item = screen.getByText('Search').closest('button')!;
    expect(item.className).toMatch(/active/);
  });

  it('calls onNewTask when the New task button is clicked', async () => {
    const onNewTask = vi.fn();
    renderRail({ onNewTask });
    const bigButton = document.querySelector('button.rail-new')!;
    await userEvent.click(bigButton);
    expect(onNewTask).toHaveBeenCalledTimes(1);
  });

  it('calls onView with the right id when a nav item is clicked', async () => {
    const onView = vi.fn();
    renderRail({ onView });
    await userEvent.click(screen.getByText('Settings').closest('button')!);
    expect(onView).toHaveBeenCalledWith('settings');
  });

  it('Cmd/Ctrl+K jumps to search view', async () => {
    const onView = vi.fn();
    renderRail({ onView, view: 'chat' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(onView).toHaveBeenCalledWith('search');
    onView.mockClear();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(onView).toHaveBeenCalledWith('search');
  });

  it('Cmd+K is suppressed by default (preventDefault) so browser bookmarks dialog does not open', () => {
    const onView = vi.fn();
    renderRail({ onView });
    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does NOT trigger search on plain "k" press', () => {
    const onView = vi.fn();
    renderRail({ onView });
    fireEvent.keyDown(window, { key: 'k' });
    expect(onView).not.toHaveBeenCalled();
  });

  it('renders the Pinned section when there are pinned projects', () => {
    renderRail({
      projects: [
        { id: 'p1', name: 'deqi', path: 'C:/d', pinned: true },
        { id: 'p2', name: 'longevity', path: 'C:/l', pinned: false },
      ],
    });
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
  });

  it('does NOT render empty sections', () => {
    renderRail();
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
  });

  it('renders Recent tasks when recentSessions is non-empty', () => {
    renderRail({
      recentSessions: [
        { id: 's1', shortId: 'abc123', projectName: 'deqi' },
        { id: 's2', shortId: 'def456', projectName: 'deqi', model: 'MiniMax-M3' },
      ],
    });
    expect(screen.getByText('Recent tasks')).toBeInTheDocument();
    expect(screen.getByText('abc123')).toBeInTheDocument();
    expect(screen.getByText('def456')).toBeInTheDocument();
  });

  it('marks the active session in Recent tasks', () => {
    renderRail({
      recentSessions: [
        { id: 's1', shortId: 'abc123', projectName: 'deqi' },
        { id: 's2', shortId: 'def456', projectName: 'deqi' },
      ],
      activeSessionId: 's2',
    });
    const activeItem = screen.getByText('def456').closest('li')!;
    expect(activeItem.className).toMatch(/active/);
  });

  it('clicking a recent session calls onOpenSession', async () => {
    const onOpenSession = vi.fn();
    renderRail({
      recentSessions: [
        { id: 's1', shortId: 'abc123', projectName: 'deqi' },
      ],
      onOpenSession,
    });
    await userEvent.click(screen.getByText('abc123').closest('li')!);
    expect(onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('marks the active project with the active class', () => {
    renderRail({
      projects: [{ id: 'p1', name: 'deqi', path: 'C:/d', pinned: false }],
      activeProjectId: 'p1',
    });
    const projectItem = screen.getByText('deqi').closest('li')!;
    expect(projectItem.className).toMatch(/active/);
  });

  it('clicking a project calls onSelectProject', async () => {
    const onSelectProject = vi.fn();
    renderRail({
      projects: [{ id: 'p1', name: 'deqi', path: 'C:/d', pinned: false }],
      onSelectProject,
    });
    await userEvent.click(screen.getByText('deqi').closest('li')!);
    expect(onSelectProject).toHaveBeenCalledWith('p1');
  });

  it('shows the footer version line', () => {
    renderRail();
    expect(screen.getByText(/Deqi/i)).toBeInTheDocument();
    expect(screen.getByText(/desktop/i)).toBeInTheDocument();
  });
});