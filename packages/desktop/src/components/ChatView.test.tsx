/**
 * ChatView.test.tsx — composer, slash command popover, model
 * picker, Send/Stop button, welcome quick-actions, files toggle.
 * Mocks DeqiApi + WS so the component is fully isolated.
 *
 * v0.2: this test suite was added in the v0.2 milestone. The
 * previous test runs had 0% coverage on ChatView because the
 * component lives in App.tsx and was hard to lift in isolation.
 * We now mount ChatView directly and feed it synthetic props.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatView } from './ChatView';
import type { ModelInfo, ServerConfig, SessionEvent, SessionSummary } from '../lib/types';

const baseConfig: ServerConfig = {
  default_model: 'MiniMax-M3',
  permission_mode: 'smart',
  show_surprise: true,
  enable_reflection: false,
  providers: {
    anthropic: { has_key: true, key_tail: 'xyz1', base_url: undefined },
  },
};

const baseModels: ModelInfo[] = [
  { id: 'MiniMax-M3', provider: 'MiniMax', context_window: 200000, max_output_tokens: 8192, cost: { input: 1, output: 2 } },
  { id: 'claude-sonnet-4-5', provider: 'anthropic', context_window: 200000, max_output_tokens: 8192, cost: { input: 3, output: 15 } },
  { id: 'gpt-5', provider: 'openai', context_window: 128000, max_output_tokens: 16384, cost: { input: 2, output: 8 } },
];

function makeApi() {
  return {
    listFiles: vi.fn().mockResolvedValue({
      root: '.', path: '.', node: { type: 'dir', name: '.', children: [] },
    }),
  } as any;
}

const baseSession: SessionSummary = {
  id: 'sess_test_01',
  model: 'MiniMax-M3',
  provider: 'MiniMax',
  cwd: 'C:/Users/P1/projects/Deqi',
  created_at: '2026-09-19T10:00:00Z',
  updated_at: '2026-09-19T10:00:00Z',
  is_latest: true,
  message_count: 0,
};

function renderChat(overrides: Partial<{
  api: any;
  events: SessionEvent[];
  userPrompts: string[];
  busy: boolean;
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  onAbort: () => void;
  config: ServerConfig | null;
  models: ModelInfo[];
  activeModel: string;
  onModelChange: (id: string) => void;
  activeSession: SessionSummary | null;
}> = {}) {
  const setDraft = overrides.setDraft ?? vi.fn();
  const onSend = overrides.onSend ?? vi.fn();
  const onAbort = overrides.onAbort ?? vi.fn();
  const onModelChange = overrides.onModelChange ?? vi.fn();
  const props = {
    api: overrides.api ?? makeApi(),
    events: overrides.events ?? [],
    userPrompts: overrides.userPrompts ?? [],
    busy: overrides.busy ?? false,
    draft: overrides.draft ?? '',
    setDraft,
    onSend,
    onAbort,
    config: overrides.config ?? baseConfig,
    models: overrides.models ?? baseModels,
    activeModel: overrides.activeModel ?? 'MiniMax-M3',
    onModelChange,
    connection: 'open' as const,
    activeSession: overrides.activeSession ?? null,
  };
  const utils = render(<ChatView {...props} />);
  return { ...utils, setDraft, onSend, onAbort, onModelChange };
}

describe('ChatView', () => {
  it('renders the welcome state when there are no events or prompts', () => {
    renderChat();
    expect(screen.getByText('Deqi')).toBeInTheDocument();
    // With config.default_model set, the subtitle shows the ready state
    expect(screen.getByText(/Ready · model: MiniMax-M3/)).toBeInTheDocument();
    // 4 quick-action cards
    expect(screen.getByText('Read the README')).toBeInTheDocument();
    expect(screen.getByText('Find TODOs')).toBeInTheDocument();
    expect(screen.getByText('Explain the entrypoint')).toBeInTheDocument();
    expect(screen.getByText('Write a test')).toBeInTheDocument();
  });

  it('renders the resumed-session subtitle when an active session is provided', () => {
    renderChat({ activeSession: baseSession });
    expect(screen.getByText(/Resumed sess_test_01/)).toBeInTheDocument();
  });

  it('shows the model picker with all configured models grouped by provider', () => {
    renderChat();
    const select = screen.getByRole('combobox', { name: /Model/i }) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe('MiniMax-M3');
    // Open the select and read options
    const optionTexts = Array.from(select.options).map(o => o.text);
    expect(optionTexts.some(t => t.includes('MiniMax-M3'))).toBe(true);
    expect(optionTexts.some(t => t.includes('claude-sonnet-4-5'))).toBe(true);
    expect(optionTexts.some(t => t.includes('gpt-5'))).toBe(true);
  });

  it('falls back to a single-option select when no models are loaded', () => {
    renderChat({ models: [], activeModel: '—' });
    const select = screen.getByRole('combobox', { name: /Model/i }) as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.options[0].value).toBe('—');
  });

  it('changing the model calls onModelChange with the new id', async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    renderChat({ onModelChange });
    const select = screen.getByRole('combobox', { name: /Model/i });
    await user.selectOptions(select, 'claude-sonnet-4-5');
    expect(onModelChange).toHaveBeenCalledWith('claude-sonnet-4-5');
  });

  it('disables the Send button when the draft is empty', () => {
    renderChat({ draft: '' });
    const send = screen.getByRole('button', { name: /Send/i });
    expect(send).toBeDisabled();
  });

  it('enables the Send button when the draft has text and clicking it calls onSend', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderChat({ draft: 'hello', onSend });
    const send = screen.getByRole('button', { name: /Send/i });
    expect(send).not.toBeDisabled();
    await user.click(send);
    expect(onSend).toHaveBeenCalled();
  });

  it('shows Stop instead of Send while busy and clicking it calls onAbort', async () => {
    const user = userEvent.setup();
    const onAbort = vi.fn();
    renderChat({ busy: true, draft: 'hello', onAbort });
    const stop = screen.getByRole('button', { name: /Stop/i });
    expect(stop).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send/i })).not.toBeInTheDocument();
    await user.click(stop);
    expect(onAbort).toHaveBeenCalled();
  });

  it('opens the slash command popover when the draft starts with /', async () => {
    const user = userEvent.setup();
    renderChat({ draft: '/' });
    // The first 3 slash commands should appear
    expect(screen.getByText('/help')).toBeInTheDocument();
    expect(screen.getByText('/clear')).toBeInTheDocument();
    expect(screen.getByText('/compact')).toBeInTheDocument();
    // Typing more narrows the filter
    await user.click(screen.getByRole('textbox'));
    // The popover is filtered live via the useEffect; with draft '/' we
    // already showed everything.
  });

  it('filtering the slash menu narrows the command list', () => {
    renderChat({ draft: '/c' });
    // /c matches /clear and /compact only
    expect(screen.getByText('/clear')).toBeInTheDocument();
    expect(screen.getByText('/compact')).toBeInTheDocument();
    expect(screen.queryByText('/help')).not.toBeInTheDocument();
  });

  it('clicking a slash command calls setDraft with the command + space', async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    renderChat({ draft: '/c', setDraft });
    const clear = screen.getByText('/clear');
    await user.click(clear);
    expect(setDraft).toHaveBeenCalledWith('/clear ');
  });

  it('ArrowDown / ArrowUp change the highlighted slash command', async () => {
    const user = userEvent.setup();
    renderChat({ draft: '/c' });
    const popover = screen.getByText('/clear').closest('.slash-popover') as HTMLElement;
    expect(popover).toBeInTheDocument();
    // First item highlighted by default. The className lives on the
    // <button>, not the inner <code> (which only carries the cmd text).
    const clearBtn = within(popover).getByText('/clear').closest('button') as HTMLButtonElement;
    const compactBtn = within(popover).getByText('/compact').closest('button') as HTMLButtonElement;
    expect(clearBtn.className).toContain('active');
    expect(compactBtn.className).not.toContain('active');
    // Focus the textarea so the keydown handler fires
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{ArrowDown}');
    expect(clearBtn.className).not.toContain('active');
    expect(compactBtn.className).toContain('active');
    await user.keyboard('{ArrowUp}');
    expect(clearBtn.className).toContain('active');
    expect(compactBtn.className).not.toContain('active');
  });

  it('Escape closes the slash popover', async () => {
    const user = userEvent.setup();
    renderChat({ draft: '/' });
    expect(screen.getByText('/help')).toBeInTheDocument();
    await user.click(screen.getByRole('textbox'));
    await user.keyboard('{Escape}');
    expect(screen.queryByText('/help')).not.toBeInTheDocument();
  });

  it('pressing Enter on the textarea without Shift calls onSend', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    renderChat({ draft: 'list files', onSend });
    const ta = screen.getByRole('textbox');
    await user.click(ta);
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalled();
  });

  it('Shift+Enter inserts a newline without calling onSend', async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const setDraft = vi.fn();
    renderChat({ draft: 'line one', onSend, setDraft });
    const ta = screen.getByRole('textbox');
    await user.click(ta);
    // Simulate the controlled-input onChange that React's textarea
    // would normally produce on Shift+Enter. We don't need the exact
    // newline behavior — we just need to confirm Enter with Shift
    // does NOT trigger onSend.
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('clicking a quick-action card sets the draft to that prompt', async () => {
    const user = userEvent.setup();
    const setDraft = vi.fn();
    renderChat({ setDraft });
    const card = screen.getByText('Read the README');
    await user.click(card);
    expect(setDraft).toHaveBeenCalledWith(expect.stringContaining('README'));
  });

  it('toggles the file panel when the icon button is clicked', async () => {
    const user = userEvent.setup();
    const { container } = renderChat();
    // Initially the chat-files aside is not in the DOM
    expect(container.querySelector('.chat-files')).not.toBeInTheDocument();
    const toggle = container.querySelector('.files-toggle') as HTMLButtonElement;
    await user.click(toggle);
    expect(container.querySelector('.chat-files')).toBeInTheDocument();
    await user.click(toggle);
    expect(container.querySelector('.chat-files')).not.toBeInTheDocument();
  });

  it('renders ChatArea (not the welcome state) once there are events', () => {
    const { container } = renderChat({
      events: [{ type: 'text_delta', delta: 'hi back' } as any],
      userPrompts: ['hi'],
    });
    expect(screen.queryByText('Read the README')).not.toBeInTheDocument();
    expect(container.querySelector('.composer')).toBeInTheDocument();
  });

  it('renders ChatArea (not the welcome state) once there are user prompts', () => {
    const { container } = renderChat({
      events: [],
      userPrompts: ['hello'],
    });
    expect(screen.queryByText('Read the README')).not.toBeInTheDocument();
    // A user block should be in the ChatArea
    expect(container.querySelector('.msg-user')).toBeInTheDocument();
  });
});