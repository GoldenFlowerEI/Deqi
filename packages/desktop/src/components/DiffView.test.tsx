/**
 * DiffView.test.tsx
 *
 * Half of this file is about hostile input. The diff arrives on the
 * wire as `unknown` and is rendered directly over the main
 * conversation, so a cast would put one malformed event between the
 * user and the whole transcript.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView, parseDiff } from './DiffView';

const good = {
  path: 'src/index.ts',
  change: 'modified' as const,
  lines: [
    { op: 'ctx' as const, text: 'const a = 1;', oldNo: 1, newNo: 1 },
    { op: 'del' as const, text: 'const b = 2;', oldNo: 2 },
    { op: 'add' as const, text: 'const b = 3;', newNo: 2 },
  ],
  added: 1,
  removed: 1,
  truncated: false,
};

describe('DiffView', () => {
  it('shows the path and the counts', () => {
    render(<DiffView raw={good} />);
    expect(screen.getByText('src/index.ts')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
  });

  it('marks each line with its operation', () => {
    const { container } = render(<DiffView raw={good} />);
    const ops = [...container.querySelectorAll('.diff-line')].map((e) => e.getAttribute('data-op'));
    expect(ops).toEqual(['ctx', 'del', 'add']);
  });

  it('numbers old and new lines on the correct side', () => {
    const { container } = render(<DiffView raw={good} />);
    const del = container.querySelector('[data-op="del"]')!;
    const [oldNo, newNo] = del.querySelectorAll('.diff-no');
    // A deletion has an old number and no new one.
    expect(oldNo.textContent).toBe('2');
    expect(newNo.textContent).toBe('');
  });

  it('renders nothing for an empty diff', () => {
    const { container } = render(<DiffView raw={{ ...good, lines: [] }} />);
    expect(container.querySelector('.diff')).toBeNull();
  });

  it('says so when the file was too large to diff', () => {
    render(<DiffView raw={{ ...good, lines: [], tooLarge: true, added: 3000, removed: 3000 }} />);
    expect(screen.getByText(/Too large/)).toBeInTheDocument();
    // Counts still shown — "too big" is not the same as "nothing".
    expect(screen.getByText('+3000')).toBeInTheDocument();
  });

  it('says so when the diff was cut short', () => {
    render(<DiffView raw={{ ...good, truncated: true }} />);
    expect(screen.getByText(/truncated/)).toBeInTheDocument();
  });

  // ─── untrusted input ─────────────────────────────────────────
  describe('hostile or malformed payloads', () => {
    const junk: Array<[string, unknown]> = [
      ['null', null],
      ['undefined', undefined],
      ['a string', 'not a diff'],
      ['a number', 42],
      ['an array', [1, 2, 3]],
      ['an empty object', {}],
      ['an unknown change kind', { ...good, change: 'renamed' }],
      ['lines that are not an array', { ...good, lines: 'nope' }],
      ['a line that is null', { ...good, lines: [null] }],
    ];
    for (const [name, raw] of junk) {
      it(`renders nothing and does not throw for ${name}`, () => {
        const { container } = render(<DiffView raw={raw} />);
        expect(container.querySelector('.diff')).toBeNull();
      });
    }

    it('drops a bad line but keeps the good ones', () => {
      const { container } = render(
        <DiffView raw={{ ...good, lines: [good.lines[0], { op: 'evil' }, good.lines[1]] }} />,
      );
      // Partial data beats no data: the user still sees what we do know.
      expect(container.querySelectorAll('.diff-line')).toHaveLength(2);
    });

    it('drops a line whose op is not one of the three', () => {
      const { container } = render(
        <DiffView raw={{ ...good, lines: [{ op: 'add', text: 'ok' }, { op: 'script', text: 'x' }] }} />,
      );
      expect(container.querySelectorAll('.diff-line')).toHaveLength(1);
    });

    it('recovers the counts when they are missing', () => {
      // Destructured to drop the fields; the point is that the parser
      // derives them from the lines rather than trusting the payload.
      const noCounts = { ...good } as Record<string, unknown>;
      delete noCounts.added;
      delete noCounts.removed;
      const d = parseDiff(noCounts);
      expect(d?.added).toBe(1);
      expect(d?.removed).toBe(1);
    });

    it('renders a blank line as a non-breaking space, not as nothing', () => {
      // A zero-height row collapses and makes the two neighbouring
      // lines look adjacent, which reads as one change. The character
      // is U+00A0, written as an escape in the component so the
      // invisible one is never sitting in the source text.
      const { container } = render(
        <DiffView raw={{ ...good, lines: [{ op: 'del', text: '', oldNo: 1 }] }} />,
      );
      expect(container.querySelector('.diff-text')?.textContent).toBe(' ');
    });
  });
});
