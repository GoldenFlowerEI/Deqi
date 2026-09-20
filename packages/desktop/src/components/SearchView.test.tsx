/**
 * SearchView.test.tsx — debounced search, filter chips, result
 * rendering, empty state.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchView } from './SearchView';
import type { SearchResponse } from '../lib/types';

const sampleResp: SearchResponse = {
  query: 'hello',
  total: 1,
  results: [
    {
      sessionId: 'sess-abc',
      cwd: 'C:/projects/x',
      model: 'MiniMax-M3',
      createdAt: new Date().toISOString(),
      hitCount: 2,
      hits: [
        { role: 'user', snippet: 'say hello world', ts: '2026-09-19T10:00:00Z' },
        { role: 'assistant', snippet: 'hello there!', ts: '2026-09-19T10:00:01Z' },
      ],
    },
  ],
};

function makeApi(resp = sampleResp) {
  return {
    search: vi.fn().mockResolvedValue(resp),
  } as any;
}

function renderSearch(initialQuery = '', api = makeApi()) {
  const onOpenSession = vi.fn();
  return { ...render(<SearchView api={api} onOpenSession={onOpenSession} initialQuery={initialQuery} />), onOpenSession, api };
}

describe('SearchView', () => {
  it('shows the empty state when no query is typed', () => {
    renderSearch();
    expect(screen.getByText(/Type to search/)).toBeInTheDocument();
    expect(screen.getByText(/Including the ones you forgot existed/)).toBeInTheDocument();
  });

  it('renders the 6 filter chips', () => {
    renderSearch();
    for (const label of ['All', 'Today', 'This week', 'Claude', 'GPT', 'MiniMax']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('All chip is active by default', () => {
    renderSearch();
    const allChip = screen.getByText('All').closest('button')!;
    expect(allChip.className).toMatch(/active/);
  });

  it('typing a query triggers the search API (debounced)', async () => {
    const api = makeApi();
    renderSearch('', api);
    await userEvent.type(screen.getByPlaceholderText(/Search messages/), 'hello');
    await waitFor(() => expect(api.search).toHaveBeenCalledWith('hello', 30));
  });

  it('renders search results with snippets + role pills', async () => {
    renderSearch('hello');
    await waitFor(() => expect(screen.getByText('sess-abc')).toBeInTheDocument());
    expect(screen.getByText('say hello world')).toBeInTheDocument();
    expect(screen.getByText('hello there!')).toBeInTheDocument();
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(screen.getByText('assistant')).toBeInTheDocument();
  });

  it('shows the clear button when query is non-empty', async () => {
    renderSearch('hello');
    await waitFor(() => expect(screen.getByText('sess-abc')).toBeInTheDocument());
    expect(screen.getByText('×')).toBeInTheDocument();
  });

  it('clicking a result calls onOpenSession', async () => {
    const { onOpenSession } = renderSearch('hello');
    await waitFor(() => expect(screen.getByText('sess-abc')).toBeInTheDocument());
    await userEvent.click(screen.getByText('sess-abc').closest('li')!);
    expect(onOpenSession).toHaveBeenCalledWith('sess-abc');
  });

  it('shows "no matches" when results are empty', async () => {
    renderSearch('', makeApi({ query: 'zzz', total: 0, results: [] }));
    await userEvent.type(screen.getByPlaceholderText(/Search messages/), 'zzz');
    await waitFor(() => expect(screen.getByText(/No matches for "zzz"/)).toBeInTheDocument());
  });

  it('clicking the same filter chip again resets to All', async () => {
    renderSearch();
    const weekChip = screen.getByText('This week').closest('button')!;
    await userEvent.click(weekChip);
    expect(weekChip.className).toMatch(/active/);
    await userEvent.click(weekChip);
    const allChip = screen.getByText('All').closest('button')!;
    expect(allChip.className).toMatch(/active/);
  });

  it('shows busy indicator while search is in flight', async () => {
    let resolveSearch: (v: SearchResponse) => void = () => {};
    const api = {
      search: vi.fn().mockImplementation(() => new Promise<SearchResponse>((r) => { resolveSearch = r; })),
    } as any;
    renderSearch('', api);
    await userEvent.type(screen.getByPlaceholderText(/Search messages/), 'hello');
    await waitFor(() => expect(screen.getByText(/searching/)).toBeInTheDocument());
    await act(async () => {
      resolveSearch(sampleResp);
    });
  });
});