/**
 * ErrorBoundary.test.tsx
 *
 * The behaviour that matters is the one a crash makes impossible to
 * check by hand: does a broken block take the rest of the
 * conversation with it? It must not, because the events are
 * untrusted — off a socket, from a model, describing tool arguments.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary, BlockBoundary } from './ErrorBoundary';

function Boom({ message = 'kaboom' }: { message?: string }): JSX.Element {
  throw new Error(message);
}

/** A component that can be told to start throwing, so the same
 *  boundary can be tested before and after. */
let shouldThrow = false;
function Flaky(): JSX.Element {
  if (shouldThrow) throw new Error('now broken');
  return <div>working content</div>;
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing is wrong', () => {
    render(<ErrorBoundary><div>all good</div></ErrorBoundary>);
    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('shows a message instead of a blank page when a child throws', () => {
    // React logs the caught error; silence it so the run is readable.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/could not recover|could not be displayed/i)).toBeInTheDocument();
    spy.mockRestore();
  });

  it('says the rest of the app is still alive', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    // The whole point of a boundary: the user needs to know whether
    // their session is gone or just this panel.
    expect(screen.getByText(/still running/i)).toBeInTheDocument();
    spy.mockRestore();
  });

  it('reports the error to the caller', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(<ErrorBoundary onError={onError}><Boom message="the real cause" /></ErrorBoundary>);
    expect(onError).toHaveBeenCalled();
    expect((onError.mock.calls[0]![0] as Error).message).toBe('the real cause');
    spy.mockRestore();
  });

  it('clears the error when the reset key changes', () => {
    shouldThrow = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary resetKey="a"><Flaky /></ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    rerender(<ErrorBoundary resetKey="b"><Flaky /></ErrorBoundary>);
    // Holding a stale error across a data change would leave the
    // failure message sitting on top of content that has been fixed.
    expect(screen.getByText('working content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    spy.mockRestore();
  });

  it('recovers when the user clicks Try again', () => {
    shouldThrow = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<ErrorBoundary><Flaky /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    // Same element identity, new props — the case a naive boundary
    // gets wrong, because it only resets on unmount.
    rerender(<ErrorBoundary><Flaky /></ErrorBoundary>);
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('working content')).toBeInTheDocument();
    spy.mockRestore();
  });
});

describe('BlockBoundary', () => {
  it('keeps sibling content alive when one block throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <div>
        <div>the message above</div>
        <BlockBoundary><Boom /></BlockBoundary>
        <div>the message below</div>
      </div>,
    );
    // This is the whole point: a malformed event must not cost the
    // user the 200 messages that were fine.
    expect(screen.getByText('the message above')).toBeInTheDocument();
    expect(screen.getByText('the message below')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('names the block kind so the user can tell what was lost', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<BlockBoundary label="A tool call could not be displayed."><Boom /></BlockBoundary>);
    expect(screen.getByText('A tool call could not be displayed.')).toBeInTheDocument();
    spy.mockRestore();
  });
});
