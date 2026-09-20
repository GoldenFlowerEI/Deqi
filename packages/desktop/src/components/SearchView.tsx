/**
 * SearchView — full-text search across all session messages.
 *
 * The user types into the search box; debounced 300ms we hit
 * GET /v1/search?q=… and render the results. Each result is a
 * session with up to 5 snippet hits (100 chars around the
 * match). Clicking a result jumps to the session.
 *
 * Layout: top bar with the input + filter chips (date / model
 * / length), then a scrollable list. The active filter chips
 * show what's on; click again to clear.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { DeqiApi } from '../lib/api';
import type { SearchHit, SearchResponse } from '../lib/types';

interface Props {
  api: DeqiApi;
  onOpenSession: (id: string) => void;
  initialQuery?: string;
}

type FilterKey = 'all' | 'today' | 'week' | 'model:claude' | 'model:gpt' | 'model:minimax';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
  { key: 'model:claude', label: 'Claude' },
  { key: 'model:gpt', label: 'GPT' },
  { key: 'model:minimax', label: 'MiniMax' },
];

export function SearchView({ api, onOpenSession, initialQuery = '' }: Props) {
  const [q, setQ] = useState(initialQuery);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [resp, setResp] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  // Debounce query
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!q.trim()) {
      setResp(null);
      setErr(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    timer.current = window.setTimeout(async () => {
      try {
        const r = await api.search(q, 30);
        setResp(r);
        setErr(null);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 300);
  }, [q, api]);

  const filtered = useMemo(() => {
    if (!resp) return [];
    return resp.results.filter((r) => passesFilter(r, filter));
  }, [resp, filter]);

  return (
    <div className="view view-search">
      <div className="view-header">
        <h2>Search</h2>
        <p className="view-sub">Across all sessions and messages</p>
      </div>

      <div className="search-bar">
        <span className="search-icon">⌕</span>
        <input
          autoFocus
          className="search-input"
          placeholder="Search messages, sessions, code…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {busy && <span className="search-busy">searching…</span>}
        {q && (
          <button className="search-clear" onClick={() => setQ('')}>
            ×
          </button>
        )}
      </div>

      <div className="search-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={'chip' + (filter === f.key ? ' active' : '')}
            onClick={() => setFilter(f.key === filter ? 'all' : f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {err && <div className="view-error">⚠ {err}</div>}

      {!q && (
        <div className="view-empty">
          <div className="view-empty-icon">⌕</div>
          <p>Type to search across every session you've ever had.</p>
          <p className="view-empty-sub">
            Including the ones you forgot existed.
          </p>
        </div>
      )}

      {q && resp && filtered.length === 0 && !busy && (
        <div className="view-empty">
          <div className="view-empty-icon">∅</div>
          <p>No matches for "{q}"{filter !== 'all' ? ` with filter ${filter}` : ''}.</p>
        </div>
      )}

      <ul className="search-results">
        {filtered.map((r) => (
          <li
            key={r.sessionId}
            className="search-hit"
            onClick={() => onOpenSession(r.sessionId)}
          >
            <div className="search-hit-head">
              <span className="search-hit-id">{r.sessionId}</span>
              <span className="search-hit-model">{r.model}</span>
              <span className="search-hit-when">{formatWhen(r.createdAt)}</span>
              <span className="search-hit-count">{r.hitCount} hit{r.hitCount > 1 ? 's' : ''}</span>
            </div>
            <div className="search-hit-snippets">
              {r.hits.map((h, i) => (
                <div key={i} className="search-snippet">
                  <span className={'snippet-role ' + h.role}>{h.role}</span>
                  <span className="snippet-text">{h.snippet}</span>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function passesFilter(hit: SearchHit, f: FilterKey): boolean {
  if (f === 'all') return true;
  if (f === 'today') {
    const t = Date.parse(hit.createdAt);
    return Date.now() - t < 24 * 60 * 60 * 1000;
  }
  if (f === 'week') {
    const t = Date.parse(hit.createdAt);
    return Date.now() - t < 7 * 24 * 60 * 60 * 1000;
  }
  if (f.startsWith('model:')) {
    const want = f.slice(6);
    return hit.model.toLowerCase().includes(want);
  }
  return true;
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
