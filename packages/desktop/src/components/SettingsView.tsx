/**
 * SettingsView — preferences + provider config.
 *
 * v2.2 changes:
 *   - Edit mode toggle on the providers section (was read-only)
 *   - Each provider can have its API key (with show/hide), baseUrl,
 *     and path edited; "Save" calls PUT /v1/config/providers/:name
 *   - Default model is a select (not a static code block), saves
 *     via PATCH /v1/config
 *   - Behavior toggles (permission_mode, show_surprise,
 *     enable_reflection) save via PATCH /v1/config
 *
 * All writes go to ~/.deqi/config.json through the server. The
 * server returns the new full config in the response so the UI
 * can re-render from authoritative state (no optimistic drift).
 */

import { useState } from 'react';
import { DeqiApi } from '../lib/api';
import { APP_VERSION, DESKTOP_ID } from '../lib/identity';
import type {
  ModelInfo,
  PermissionMode,
  ServerConfig,
} from '../lib/types';

interface Props {
  api: DeqiApi;
  config: ServerConfig | null;
  models: ModelInfo[];
  onConfigChange: (cfg: ServerConfig) => void;
}

const PERMISSION_LABELS: Array<{ value: PermissionMode; label: string; desc: string }> = [
  { value: 'autonomous', label: 'Autonomous', desc: 'Run any tool, no questions' },
  { value: 'smart', label: 'Smart', desc: 'Ask only for risky/destructive ops' },
  { value: 'manual', label: 'Manual', desc: 'Approve every tool call' },
  { value: 'chat_only', label: 'Chat only', desc: 'No tools — pure conversation' },
];

interface ProviderDraft {
  apiKey: string;
  baseUrl: string;
  path: string;
  showKey: boolean;
}

function emptyDraft(): ProviderDraft {
  return { apiKey: '', baseUrl: '', path: '', showKey: false };
}

export function SettingsView({ api, config, models, onConfigChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [editingProviders, setEditingProviders] = useState(false);
  // Per-provider edit draft. When `editingProviders` is false,
  // drafts is hidden. Map keyed by provider name.
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});

  if (!config) {
    return (
      <div className="view view-settings">
        <div className="view-busy">Loading config…</div>
      </div>
    );
  }

  const setDraft = (name: string, patch: Partial<ProviderDraft>): void => {
    setDrafts((d) => ({ ...d, [name]: { ...(d[name] ?? emptyDraft()), ...patch } }));
  };

  const beginEdit = (): void => {
    // Seed drafts from current config so the form shows real values.
    const seeded: Record<string, ProviderDraft> = {};
    for (const [name, p] of Object.entries(config.providers)) {
      seeded[name] = {
        apiKey: '',
        // Don't pre-fill the api key field — leave blank to mean
        // "keep existing". User must type a new key to change it.
        baseUrl: p.base_url ?? '',
        path: '',
        showKey: false,
      };
    }
    setDrafts(seeded);
    setEditingProviders(true);
  };

  const cancelEdit = (): void => {
    setEditingProviders(false);
    setDrafts({});
  };

  const flash = (msg: string): void => {
    setOk(msg);
    setTimeout(() => setOk(null), 2200);
  };

  const saveBehavior = async (patch: Partial<ServerConfig>): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.patchConfig(patch);
      onConfigChange(res.config);
      flash('Saved');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveDefaultModel = async (modelId: string): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.patchConfig({ default_model: modelId });
      onConfigChange(res.config);
      flash('Default model saved');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveProvider = async (name: string): Promise<void> => {
    const d = drafts[name];
    if (!d) return;
    setBusy(true);
    setErr(null);
    try {
      const patch: { apiKey?: string; baseUrl?: string; path?: string } = {};
      if (d.apiKey.trim()) patch.apiKey = d.apiKey.trim();
      if (d.baseUrl.trim()) patch.baseUrl = d.baseUrl.trim();
      if (d.path.trim()) patch.path = d.path.trim();
      if (Object.keys(patch).length === 0) {
        setErr('No changes to save (apiKey / baseUrl / path all empty)');
        return;
      }
      const res = await api.putProvider(name, patch);
      onConfigChange(res.config);
      // Clear the draft for this provider so its key field resets
      setDrafts((cur) => ({ ...cur, [name]: emptyDraft() }));
      flash(`Provider ${name} updated`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view view-settings">
      <div className="view-header">
        <h2>Settings</h2>
        <p className="view-sub">Preferences, models, and behavior. All writes go to ~/.deqi/config.json</p>
      </div>

      {err && <div className="view-error">⚠ {err}</div>}
      {ok && <div className="view-ok">✓ {ok}</div>}

      <section className="settings-section">
        <h3>Model</h3>
        <div className="settings-row">
          <span className="settings-label">Default</span>
          <select
            className="settings-picker"
            value={config.default_model}
            onChange={(e) => saveDefaultModel(e.target.value)}
            disabled={busy}
          >
            {models.length > 0 ? (
              models.map((m) => (
                <option key={m.id} value={m.id}>{m.id} ({m.provider})</option>
              ))
            ) : (
              <option value={config.default_model}>{config.default_model}</option>
            )}
          </select>
          <span className="settings-hint">Used for new sessions. Chat composer can override per turn.</span>
        </div>
      </section>

      <section className="settings-section">
        <h3>
          Providers
          {!editingProviders ? (
            <button className="settings-edit-btn" onClick={beginEdit} disabled={busy}>
              Edit
            </button>
          ) : (
            <button className="settings-edit-btn" onClick={cancelEdit} disabled={busy}>
              Done
            </button>
          )}
        </h3>
        <div className="settings-providers">
          {Object.entries(config.providers).map(([name, p]) => {
            const draft = drafts[name] ?? emptyDraft();
            return (
              <div key={name} className="settings-provider">
                <div className="settings-provider-name">{name}</div>
                <div className="settings-provider-state">
                  {p.has_key ? (
                    <span className="status-pill ok">configured</span>
                  ) : (
                    <span className="status-pill warn">no key</span>
                  )}
                  {p.key_tail && <code className="key-tail">…{p.key_tail}</code>}
                  {p.base_url && <code className="base-url">{p.base_url}</code>}
                </div>
                {editingProviders && (
                  <div className="settings-provider-edit">
                    <label className="settings-field">
                      <span>API key</span>
                      <div className="key-input-wrap">
                        <input
                          type={draft.showKey ? 'text' : 'password'}
                          value={draft.apiKey}
                          onChange={(e) => setDraft(name, { apiKey: e.target.value })}
                          placeholder={p.has_key ? `current ends …${p.key_tail}` : 'paste key here'}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={busy}
                        />
                        <button
                          type="button"
                          className="icon-btn key-toggle"
                          onClick={() => setDraft(name, { showKey: !draft.showKey })}
                          title={draft.showKey ? 'Hide' : 'Show'}
                        >
                          {draft.showKey ? '🙈' : '👁'}
                        </button>
                      </div>
                    </label>
                    <label className="settings-field">
                      <span>Base URL</span>
                      <input
                        type="text"
                        value={draft.baseUrl}
                        onChange={(e) => setDraft(name, { baseUrl: e.target.value })}
                        placeholder={p.base_url ?? '(unchanged)'}
                        disabled={busy}
                      />
                    </label>
                    {name === 'openai-compat' && (
                      <label className="settings-field">
                        <span>Path</span>
                        <input
                          type="text"
                          value={draft.path}
                          onChange={(e) => setDraft(name, { path: e.target.value })}
                          placeholder="(unchanged) e.g. /v1/chat/completions"
                          disabled={busy}
                        />
                      </label>
                    )}
                    <div className="settings-provider-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() => saveProvider(name)}
                        disabled={busy}
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {editingProviders && Object.keys(config.providers).length === 0 && (
          <div className="settings-hint">
            No providers configured. Use the &lt;Edit&gt; button to add one.
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>Behavior</h3>
        <div className="settings-permissions">
          <span className="settings-label">Permission mode</span>
          <div className="permission-grid">
            {PERMISSION_LABELS.map((p) => (
              <button
                key={p.value}
                className={'permission-card' + (config.permission_mode === p.value ? ' active' : '')}
                onClick={() => saveBehavior({ permission_mode: p.value })}
                disabled={busy}
              >
                <div className="permission-card-label">{p.label}</div>
                <div className="permission-card-desc">{p.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Surprise banner</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={config.show_surprise}
              onChange={(e) => saveBehavior({ show_surprise: e.target.checked })}
              disabled={busy}
            />
            <span>{config.show_surprise ? 'on' : 'off'}</span>
          </label>
        </div>
        <div className="settings-row">
          <span className="settings-label">Per-turn reflection</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={config.enable_reflection}
              onChange={(e) => saveBehavior({ enable_reflection: e.target.checked })}
              disabled={busy}
            />
            <span>{config.enable_reflection ? 'on' : 'off'}</span>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <div className="settings-row">
          <span className="settings-label">Deqi version</span>
          {/* v0.2: pull from identity.ts so the displayed version
              tracks the actual bundle. Previously hardcoded
              "3.9.0 (desktop)" — lied about the version on every
              release past v3.9. */}
          <code>{APP_VERSION} (desktop)</code>
        </div>
        <div className="settings-row">
          <span className="settings-label">Desktop ID</span>
          <code>{DESKTOP_ID}</code>
        </div>
        <div className="settings-row">
          <span className="settings-label">Config file</span>
          <code>~/.deqi/config.json</code>
        </div>
        <div className="settings-row">
          <span className="settings-label">Sessions</span>
          <code>~/.deqi/sessions/</code>
        </div>
      </section>
    </div>
  );
}
