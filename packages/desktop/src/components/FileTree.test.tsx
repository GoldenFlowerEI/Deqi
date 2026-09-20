/**
 * FileTree.test.tsx — directory load + render, file pick callback,
 * collapse/expand, refresh button, compact mode.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileTree } from './FileTree';
import type { FileNode } from '../lib/types';

const sampleTree: FileNode = {
  kind: 'dir',
  path: '/repo',
  name: 'repo',
  children: [
    {
      kind: 'dir', path: '/repo/src', name: 'src',
      children: [
        { kind: 'file', path: '/repo/src/index.ts', name: 'index.ts', size: 1200 },
        { kind: 'file', path: '/repo/src/main.ts', name: 'main.ts', size: 32000 },
      ],
    },
    {
      kind: 'dir', path: '/repo/docs', name: 'docs',
      children: [
        { kind: 'file', path: '/repo/docs/README.md', name: 'README.md', size: 5400 },
      ],
    },
    { kind: 'file', path: '/repo/package.json', name: 'package.json', size: 800 },
  ],
};

function makeApi() {
  return {
    listFiles: vi.fn().mockResolvedValue({ node: sampleTree }),
  } as any;
}

describe('FileTree', () => {
  it('renders the root path in the toolbar', async () => {
    render(<FileTree api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('/repo')).toBeInTheDocument());
  });

  it('renders the immediate children at depth 0', async () => {
    render(<FileTree api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
  });

  it('auto-expands directories at depth < 2', async () => {
    render(<FileTree api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());
    expect(screen.getByText('main.ts')).toBeInTheDocument();
    // docs is at depth 1, also auto-expanded
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('clicking a file calls onPick with the @-prefixed path', async () => {
    const onPick = vi.fn();
    render(<FileTree api={makeApi()} onPick={onPick} />);
    await waitFor(() => expect(screen.getByText('index.ts')).toBeInTheDocument());
    await userEvent.click(screen.getByText('index.ts'));
    expect(onPick).toHaveBeenCalledWith('@/repo/src/index.ts');
  });

  it('clicking a directory toggles open/closed', async () => {
    render(<FileTree api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    // Already open (depth 1). Click closes.
    await userEvent.click(screen.getByText('src'));
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
    // Click again to reopen.
    await userEvent.click(screen.getByText('src'));
    expect(screen.getByText('index.ts')).toBeInTheDocument();
  });

  it('refresh button calls api.listFiles again', async () => {
    const api = makeApi();
    render(<FileTree api={api} />);
    await waitFor(() => expect(screen.getByText('/repo')).toBeInTheDocument());
    expect(api.listFiles).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText('↻'));
    expect(api.listFiles).toHaveBeenCalledTimes(2);
  });

  it('compact mode hides the toolbar and root label', async () => {
    render(<FileTree api={makeApi()} compact />);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());
    expect(screen.queryByText('/repo')).not.toBeInTheDocument();
    expect(screen.queryByText('↻')).not.toBeInTheDocument();
  });

  it('shows the file size in human form', async () => {
    render(<FileTree api={makeApi()} />);
    await waitFor(() => expect(screen.getByText('main.ts')).toBeInTheDocument());
    // 32000 bytes = 31.25 KB → 31.3 KB (1 decimal)
    expect(screen.getByText('31.3 KB')).toBeInTheDocument();
    // 5400 bytes = 5.27 KB → 5.3 KB
    expect(screen.getByText('5.3 KB')).toBeInTheDocument();
  });

  it('omits file size for files > 100KB', async () => {
    const bigTree: FileNode = {
      ...sampleTree,
      children: [
        { kind: 'file', path: '/repo/big.bin', name: 'big.bin', size: 200_000 },
      ],
    };
    const api = { listFiles: vi.fn().mockResolvedValue({ node: bigTree }) } as any;
    render(<FileTree api={api} />);
    await waitFor(() => expect(screen.getByText('big.bin')).toBeInTheDocument());
    expect(screen.queryByText(/200/)).not.toBeInTheDocument();
  });

  it('shows error UI on API failure', async () => {
    const api = { listFiles: vi.fn().mockRejectedValue(new Error('perm denied')) } as any;
    render(<FileTree api={api} />);
    await waitFor(() => expect(screen.getByText(/perm denied/)).toBeInTheDocument());
  });
});