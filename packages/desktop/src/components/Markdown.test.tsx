/**
 * Markdown.test.tsx — assistant reply rendering.
 *
 * The security assertions are the point of this file. Agent output is
 * the least trustworthy text in the product: it is written by a model
 * that read a repository, which may contain a file whose contents say
 * `<img onerror=...>`. Every other escaping guarantee in the app is
 * void if this one component renders it.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders inline emphasis instead of its asterisks', () => {
    const { container } = render(<Markdown>{'a **bold** claim'}</Markdown>);
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.textContent).not.toContain('**');
  });

  it('renders a fenced code block with its language', () => {
    render(<Markdown>{'```ts\nconst x = 1;\n```'}</Markdown>);
    expect(screen.getByText('ts')).toBeInTheDocument();
    expect(screen.getByText(/const x = 1;/)).toBeInTheDocument();
  });

  it('keeps inline code inline', () => {
    const { container } = render(<Markdown>{'call `read_file(path)` first'}</Markdown>);
    // An inline span must not grow the block chrome — a one-liner
    // should not get a language bar and a copy button.
    expect(container.querySelector('.md-inline-code')).toBeInTheDocument();
    expect(container.querySelector('.md-code-bar')).toBeNull();
  });

  it('copies a code block to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Markdown>{'```sh\nrm -rf build\n```'}</Markdown>);
    fireEvent.click(screen.getByText('copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('rm -rf build'));
  });

  it('renders GFM tables', () => {
    const { container } = render(
      <Markdown>{'| a | b |\n|---|---|\n| 1 | 2 |'}</Markdown>,
    );
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container.querySelectorAll('td')).toHaveLength(2);
    // A wide table scrolls inside its own box instead of stretching
    // the whole message column.
    expect(container.querySelector('.md-table-scroll')).toBeInTheDocument();
  });

  it('opens links outside the app with noopener', () => {
    const { container } = render(<Markdown>{'[docs](https://example.com)'}</Markdown>);
    const a = container.querySelector('a');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(a).toHaveAttribute('href', 'https://example.com');
  });

  // ─── the reason this component is not hand-rolled ─────────────
  describe('untrusted agent output', () => {
    it('does not execute a javascript: href', () => {
      const { container } = render(
        <Markdown>{'[click](javascript:alert(1))'}</Markdown>,
      );
      const a = container.querySelector('a');
      const href = a?.getAttribute('href') ?? '';
      expect(href).not.toContain('javascript:');
    });

    it('does not execute an inline event handler', () => {
      const { container } = render(
        <Markdown>{'<img src=x onerror="window.__pwned = 1">'}</Markdown>,
      );
      // Not merely "escaped" — react-markdown does not build an
      // element for raw HTML at all, so there is nothing to fire.
      expect(container.querySelector('img')).toBeNull();
      expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    });

    it('renders a script tag as text, not as a script', () => {
      const { container } = render(
        <Markdown>{'<script>window.__pwned2 = 1</script>'}</Markdown>,
      );
      expect(container.querySelector('script')).toBeNull();
      expect((window as unknown as { __pwned2?: number }).__pwned2).toBeUndefined();
    });

    it('drops a data: url, which can carry a payload', () => {
      const { container } = render(
        <Markdown>{'[x](data:text/html;base64,PHNjcmlwdD4x)'}</Markdown>,
      );
      expect(container.querySelector('a')?.getAttribute('href')).not.toContain('data:');
    });
  });
});
