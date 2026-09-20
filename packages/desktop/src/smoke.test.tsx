/**
 * src/smoke.test.ts — a trivial Vitest smoke test.
 *
 * Run with `bun run test` (script: vitest run).
 * If this passes, the test framework itself is wired correctly.  If it
 * fails, the failure is in vitest.config.ts / test/setup.ts, not in
 * any component test.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

describe('vitest + jsdom + RTL setup', () => {
  it('jsdom provides document / window', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });

  it('RTL can render a trivial component', () => {
    render(<div data-testid="hello">hello world</div>);
    expect(screen.getByTestId('hello')).toBeInTheDocument();
    expect(screen.getByTestId('hello')).toHaveTextContent('hello world');
  });

  it('jest-dom matchers work', () => {
    const { container } = render(<button disabled>OK</button>);
    const button = container.querySelector('button');
    expect(button).toBeDisabled();
    expect(button).not.toBeEmptyDOMElement();
    expect(button).toHaveTextContent('OK');
  });
});