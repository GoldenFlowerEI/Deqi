/**
 * SettingsView.test.tsx — model picker, provider edit cycle,
 * behavior toggles, About section. Mocks the DeqiApi so no network.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView } from './SettingsView';
import type { ModelInfo, ServerConfig } from '../lib/types';

const baseConfig: ServerConfig = {
  version: 1,
  default_model: 'MiniMax-M3',
  permission_mode: 'smart',
  show_surprise: true,
  enable_reflection: false,
  providers: {
    anthropic: { has_key: true, key_tail: 'xyz1', base_url: null },
    'openai-compat': { has_key: false, key_tail: null, base_url: 'https://example.com/v1' },
  },
};

const baseModels: ModelInfo[] = [
  { id: 'MiniMax-M3', provider: 'MiniMax' },
  { id: 'claude-sonnet-4-5', provider: 'anthropic' },
  { id: 'gpt-5', provider: 'openai' },
];

function makeApi() {
  return {
    patchConfig: vi.fn().mockResolvedValue({ config: baseConfig }),
    putProvider: vi.fn().mockResolvedValue({ config: baseConfig }),
  } as any;
}

function renderSettings(api = makeApi(), config = baseConfig, models = baseModels) {
  const onConfigChange = vi.fn();
  return { ...render(<SettingsView api={api} config={config} models={models} onConfigChange={onConfigChange} />), onConfigChange, api };
}

describe('SettingsView', () => {
  it('shows a loading state when config is null', () => {
    const { container } = render(<SettingsView api={makeApi()} config={null} models={[]} onConfigChange={() => {}} />);
    expect(container.querySelector('.view-busy')).toBeInTheDocument();
    expect(screen.getByText(/Loading config/)).toBeInTheDocument();
  });

  it('renders the About section with version + paths', () => {
    renderSettings();
    expect(screen.getByText(/Deqi version/i)).toBeInTheDocument();
    // Use the <code> tag (not the prose mention in the intro).
    expect(screen.getAllByText(/~?\/.deqi\/config\.json/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/~?\/.deqi\/sessions/).length).toBeGreaterThanOrEqual(1);
  });

  it('lists all models in the Default dropdown', () => {
    renderSettings();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    const optionTexts = Array.from(select.options).map(o => o.text);
    expect(optionTexts.some(t => t.includes('MiniMax-M3'))).toBe(true);
    expect(optionTexts.some(t => t.includes('claude-sonnet-4-5'))).toBe(true);
    expect(optionTexts.some(t => t.includes('gpt-5'))).toBe(true);
  });

  it('renders the providers with their configured status', () => {
    const { container } = renderSettings();
    expect(container.textContent).toContain('anthropic');
    expect(container.textContent).toContain('openai-compat');
    expect(screen.getByText('configured')).toBeInTheDocument();
    expect(screen.getByText('no key')).toBeInTheDocument();
  });

  it('shows the API key tail only when has_key', () => {
    const { container } = renderSettings();
    // anthropic has key_tail "xyz1"
    expect(container.textContent).toContain('xyz1');
  });

  it('does NOT show provider edit fields before Edit is clicked', () => {
    renderSettings();
    expect(screen.queryByText(/API key/)).not.toBeInTheDocument();
  });

  it('Edit button reveals the per-provider edit fields', async () => {
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    // Now there should be API key fields visible
    const keyLabels = screen.getAllByText(/API key/);
    expect(keyLabels.length).toBeGreaterThanOrEqual(1);
  });

  it('Cancel (Done) button hides the edit fields', async () => {
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    expect(screen.getAllByText(/API key/).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /^Done$/ }));
    expect(screen.queryByText(/API key/)).not.toBeInTheDocument();
  });

  it('shows the base URL field for all providers and Path only for openai-compat', async () => {
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const baseUrlLabels = screen.getAllByText(/Base URL/);
    expect(baseUrlLabels.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/^Path$/)).toBeInTheDocument();
  });

  it('toggling show/hide on the API key flips input type', async () => {
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const keyInputs = document.querySelectorAll('input[type="password"]');
    expect(keyInputs.length).toBeGreaterThanOrEqual(1);
    const showButtons = screen.getAllByTitle('Show');
    expect(showButtons.length).toBeGreaterThanOrEqual(1);
    await userEvent.click(showButtons[0]);
    expect(document.querySelectorAll('input[type="text"]').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByTitle('Hide').length).toBeGreaterThanOrEqual(1);
  });

  it('Save with all empty fields shows an error and does NOT call api.putProvider', async () => {
    const api = makeApi();
    renderSettings(api);
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const saveButtons = screen.getAllByText('Save');
    await userEvent.click(saveButtons[0]);
    await waitFor(() => expect(screen.getByText(/No changes to save/)).toBeInTheDocument());
    expect(api.putProvider).not.toHaveBeenCalled();
  });

  it('Save with a key calls api.putProvider', async () => {
    const api = makeApi();
    renderSettings(api);
    await userEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
    const keyInputs = document.querySelectorAll('input[type="password"]');
    await userEvent.type(keyInputs[0], 'sk-new-key-12345');
    const saveButtons = screen.getAllByText('Save');
    await userEvent.click(saveButtons[0]);
    await waitFor(() => expect(api.putProvider).toHaveBeenCalled());
  });

  it('default model change calls api.patchConfig with { default_model }', async () => {
    const api = makeApi();
    renderSettings(api);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'claude-sonnet-4-5');
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ default_model: 'claude-sonnet-4-5' }));
  });

  it('permission card click calls api.patchConfig with { permission_mode }', async () => {
    const api = makeApi();
    renderSettings(api);
    await userEvent.click(screen.getByText('Autonomous'));
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ permission_mode: 'autonomous' }));
  });

  it('show_surprise toggle calls api.patchConfig', async () => {
    const api = makeApi();
    const { container } = renderSettings(api);
    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await userEvent.click(toggle);
    await waitFor(() => expect(api.patchConfig).toHaveBeenCalledWith({ show_surprise: false }));
  });

  it('calls onConfigChange after a successful patch', async () => {
    const api = makeApi();
    const { onConfigChange } = renderSettings(api);
    await userEvent.click(screen.getByText('Autonomous'));
    await waitFor(() => expect(onConfigChange).toHaveBeenCalled());
  });
});