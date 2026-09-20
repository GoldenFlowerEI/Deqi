/**
 * ScheduleView — manage cron-like jobs.
 *
 * Each row is a scheduled task with: name, prompt, cadence,
 * enabled toggle, last-run status. Click "+" to create; click
 * the row to edit; click the trash to delete; click "Run now"
 * to fire it immediately (server marks lastRun, the actual
 * execution is owned by a sidecar process we don't have yet).
 *
 * Cadences are friendly strings: 5m / 15m / 30m / 1h / 6h /
 * daily / weekly. The desktop app shows the human form, the
 * server stores the same.
 */

import { useEffect, useState } from 'react';
import { DeqiApi } from '../lib/api';
import type { ScheduleCadence, ScheduleItem } from '../lib/types';

interface Props {
  api: DeqiApi;
}

const CADENCES: Array<{ value: ScheduleCadence; label: string }> = [
  { value: '5m', label: 'Every 5 min' },
  { value: '15m', label: 'Every 15 min' },
  { value: '30m', label: 'Every 30 min' },
  { value: '1h', label: 'Every hour' },
  { value: '6h', label: 'Every 6 hours' },
  { value: 'daily', label: 'Once a day' },
  { value: 'weekly', label: 'Once a week' },
];

export function ScheduleView({ api }: Props) {
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ScheduleItem | null>(null);

  const reload = async () => {
    setBusy(true);
    try {
      const { items } = await api.listSchedule();
      setItems(items);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    reload();
  }, []);

  const handleCreate = () => {
    setEditing({
      id: '',
      name: '',
      prompt: '',
      cadence: '1h',
      enabled: true,
      createdAt: '',
    });
    setShowForm(true);
  };

  const handleEdit = (it: ScheduleItem) => {
    setEditing(it);
    setShowForm(true);
  };

  const handleSave = async (draft: ScheduleItem) => {
    try {
      if (!draft.id) {
        await api.createSchedule({
          name: draft.name,
          prompt: draft.prompt,
          cadence: draft.cadence,
          enabled: draft.enabled,
        });
      } else {
        await api.updateSchedule(draft.id, {
          name: draft.name,
          prompt: draft.prompt,
          cadence: draft.cadence,
          enabled: draft.enabled,
        });
      }
      setShowForm(false);
      setEditing(null);
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const handleDelete = async (it: ScheduleItem) => {
    if (!confirm(`Delete scheduled task "${it.name}"?`)) return;
    await api.deleteSchedule(it.id);
    await reload();
  };

  const handleRun = async (it: ScheduleItem) => {
    await api.runScheduleNow(it.id);
    await reload();
  };

  const handleToggle = async (it: ScheduleItem) => {
    await api.updateSchedule(it.id, { enabled: !it.enabled });
    await reload();
  };

  return (
    <div className="view view-schedule">
      <div className="view-header">
        <h2>Schedule</h2>
        <p className="view-sub">Run any prompt on a timer. Wake up, check in, hand off — your call.</p>
        <button className="btn btn-primary" onClick={handleCreate}>+ New task</button>
      </div>

      {err && <div className="view-error">⚠ {err}</div>}
      {busy && <div className="view-busy">Loading…</div>}

      {!busy && items.length === 0 && (
        <div className="view-empty">
          <div className="view-empty-icon">⏰</div>
          <p>No scheduled tasks yet.</p>
          <p className="view-empty-sub">
            One good use: a daily 9am "what's the world saying about X" brief.
          </p>
        </div>
      )}

      <ul className="schedule-list">
        {items.map((it) => (
          <li key={it.id} className={'schedule-row' + (it.enabled ? '' : ' disabled')}>
            <div className="schedule-main">
              <div className="schedule-name">{it.name}</div>
              <div className="schedule-prompt">{it.prompt}</div>
              <div className="schedule-meta">
                <span className="cadence-pill">{labelFor(it.cadence)}</span>
                {it.lastRunAt && (
                  <span className="last-run">
                    Last run: {formatWhen(it.lastRunAt)}
                    {it.lastRunStatus === 'error' && ' ⚠'}
                  </span>
                )}
              </div>
            </div>
            <div className="schedule-actions">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={it.enabled}
                  onChange={() => handleToggle(it)}
                />
                <span>{it.enabled ? 'on' : 'off'}</span>
              </label>
              <button className="btn btn-mini" onClick={() => handleRun(it)}>Run now</button>
              <button className="btn btn-mini" onClick={() => handleEdit(it)}>Edit</button>
              <button className="btn btn-mini danger" onClick={() => handleDelete(it)}>×</button>
            </div>
          </li>
        ))}
      </ul>

      {showForm && editing && (
        <ScheduleForm
          draft={editing}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function ScheduleForm({
  draft,
  onCancel,
  onSave,
}: {
  draft: ScheduleItem;
  onCancel: () => void;
  onSave: (d: ScheduleItem) => void;
}) {
  const [name, setName] = useState(draft.name);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [cadence, setCadence] = useState<ScheduleCadence>(draft.cadence);
  const [enabled, setEnabled] = useState(draft.enabled);

  return (
    <div className="schedule-form-backdrop" onClick={onCancel}>
      <div className="schedule-form" onClick={(e) => e.stopPropagation()}>
        <h3>{draft.id ? 'Edit scheduled task' : 'New scheduled task'}</h3>
        <label>
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Daily brief" />
        </label>
        <label>
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="What changed in the AI agent ecosystem yesterday?"
          />
        </label>
        <label>
          <span>Cadence</span>
          <select value={cadence} onChange={(e) => setCadence(e.target.value as ScheduleCadence)}>
            {CADENCES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Enabled</span>
        </label>
        <div className="schedule-form-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!name.trim() || !prompt.trim()}
            onClick={() => onSave({ ...draft, name: name.trim(), prompt: prompt.trim(), cadence, enabled })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function labelFor(c: ScheduleCadence): string {
  return CADENCES.find((x) => x.value === c)?.label ?? c;
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / 3_600_000)} h ago`;
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.round(diff / 86_400_000)} d ago`;
  return new Date(t).toLocaleDateString();
}
