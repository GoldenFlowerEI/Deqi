/**
 * ScheduleView.test.tsx — list, CRUD form, run-now, enable toggle.
 * Mocks window.confirm and the DeqiApi.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleView } from './ScheduleView';
import type { ScheduleItem } from '../lib/types';

const sample: ScheduleItem[] = [
  {
    id: 'sch_a',
    name: 'Daily brief',
    prompt: 'summarise what changed in AI today',
    cadence: 'daily',
    enabled: true,
    createdAt: '2026-09-01T00:00:00Z',
    lastRunAt: new Date(Date.now() - 60_000).toISOString(),
    lastRunStatus: 'ok',
    lastRunNote: 'ok',
  },
  {
    id: 'sch_b',
    name: 'Hourly check',
    prompt: 'check logs',
    cadence: '1h',
    enabled: false,
    createdAt: '2026-09-02T00:00:00Z',
  },
];

function makeApi(items = sample) {
  return {
    listSchedule: vi.fn().mockResolvedValue({ items }),
    createSchedule: vi.fn().mockResolvedValue({ id: 'sch_new' }),
    updateSchedule: vi.fn().mockResolvedValue({ ok: true }),
    deleteSchedule: vi.fn().mockResolvedValue({ ok: true }),
    runScheduleNow: vi.fn().mockResolvedValue({ ok: true, item: items[0] }),
  } as any;
}

describe('ScheduleView', () => {
  it('renders the empty state when no items', async () => {
    render(<ScheduleView api={makeApi([])} />);
    await waitFor(() => expect(screen.getByText(/No scheduled tasks yet/)).toBeInTheDocument());
  });

  it('renders one row per item with name + prompt + cadence', async () => {
    render(<ScheduleView api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('Daily brief')).toBeInTheDocument());
    expect(screen.getByText('Hourly check')).toBeInTheDocument();
    expect(screen.getByText('summarise what changed in AI today')).toBeInTheDocument();
    expect(screen.getByText('check logs')).toBeInTheDocument();
  });

  it('marks disabled rows with the .disabled class', async () => {
    const { container } = render(<ScheduleView api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('Daily brief')).toBeInTheDocument());
    const disabledRow = screen.getByText('Hourly check').closest('li')!;
    expect(disabledRow.className).toMatch(/disabled/);
  });

  it('renders the last-run line when present', async () => {
    render(<ScheduleView api={makeApi()} />);
    await waitFor(() => expect(screen.getByText(/Last run/)).toBeInTheDocument());
  });

  it('+ New task opens the form', async () => {
    render(<ScheduleView api={makeApi()} />);
    await userEvent.click(screen.getByText(/\+ New task/));
    expect(screen.getByText('New scheduled task')).toBeInTheDocument();
  });

  it('Save button is disabled when name or prompt is empty', async () => {
    render(<ScheduleView api={makeApi()} />);
    await userEvent.click(screen.getByText(/\+ New task/));
    const saveButtons = screen.getAllByText('Save');
    expect(saveButtons[0]).toBeDisabled();
  });

  it('saving a new task calls api.createSchedule', async () => {
    const api = makeApi();
    render(<ScheduleView api={api} />);
    await userEvent.click(screen.getByText(/\+ New task/));
    await userEvent.type(screen.getByPlaceholderText(/Daily brief/i), 'New thing');
    await userEvent.type(screen.getByPlaceholderText(/changed in the AI/), 'do the thing');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.createSchedule).toHaveBeenCalled());
  });

  it('Run now calls api.runScheduleNow and reloads', async () => {
    const api = makeApi();
    render(<ScheduleView api={api} />);
    await waitFor(() => expect(screen.getByText('Daily brief')).toBeInTheDocument());
    const runButtons = screen.getAllByText('Run now');
    await userEvent.click(runButtons[0]);
    await waitFor(() => expect(api.runScheduleNow).toHaveBeenCalledWith('sch_a'));
  });

  it('toggle calls api.updateSchedule with enabled flipped', async () => {
    const api = makeApi();
    const { container } = render(<ScheduleView api={api} />);
    await waitFor(() => expect(screen.getByText('Daily brief')).toBeInTheDocument());
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    await userEvent.click(checkboxes[0]);
    await waitFor(() => expect(api.updateSchedule).toHaveBeenCalledWith('sch_a', { enabled: false }));
  });

  it('delete triggers confirm and api.deleteSchedule', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = makeApi();
    render(<ScheduleView api={api} />);
    await waitFor(() => expect(screen.getByText('Daily brief')).toBeInTheDocument());
    const deleteButtons = screen.getAllByText('×');
    await userEvent.click(deleteButtons[0]);
    await waitFor(() => expect(api.deleteSchedule).toHaveBeenCalledWith('sch_a'));
    confirmSpy.mockRestore();
  });

  it('delete with confirm=false does NOT call api.deleteSchedule', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = makeApi();
    render(<ScheduleView api={api} />);
    await waitFor(() => expect(screen.getByText('Daily brief')).toBeInTheDocument());
    const deleteButtons = screen.getAllByText('×');
    await userEvent.click(deleteButtons[0]);
    expect(api.deleteSchedule).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('Edit opens the form pre-filled', async () => {
    render(<ScheduleView api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('Daily brief')).toBeInTheDocument());
    const editButtons = screen.getAllByText('Edit');
    await userEvent.click(editButtons[0]);
    expect(screen.getByText('Edit scheduled task')).toBeInTheDocument();
    const nameInput = screen.getByPlaceholderText(/Daily brief/i) as HTMLInputElement;
    expect(nameInput.value).toBe('Daily brief');
  });

  it('Cancel closes the form without saving', async () => {
    const api = makeApi();
    render(<ScheduleView api={api} />);
    await userEvent.click(screen.getByText(/\+ New task/));
    expect(screen.getByText('New scheduled task')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New scheduled task')).not.toBeInTheDocument();
    expect(api.createSchedule).not.toHaveBeenCalled();
  });

  it('shows the 7 cadence options in the form', async () => {
    render(<ScheduleView api={makeApi()} />);
    await userEvent.click(screen.getByText(/\+ New task/));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.options.length).toBe(7);
    expect(select.value).toBe('1h');
  });
});