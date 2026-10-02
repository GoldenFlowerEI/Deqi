/**
 * ErrorBoundary.tsx — keep one bad thing from taking down the page.
 *
 * Two levels, because the failure modes are different:
 *
 *   <ErrorBoundary>            around the whole app. A crash there is
 *                              rare, and the right response is a
 *                              message and a reset, not a white window
 *                              with an error in the console the user
 *                              cannot see.
 *
 *   <BlockBoundary>            around each rendered block. This is
 *                              the one that matters day to day: the
 *                              event stream is untrusted input, and a
 *                              single malformed event used to blank
 *                              the entire conversation — including
 *                              the 200 messages above it that were
 *                              perfectly fine.
 *
 * The reset key matters. A boundary that cannot be told "the inputs
 * changed, try again" is a boundary the user has to reload the app
 * past, which is worse than the crash it is catching.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Change this to clear a caught error and re-render the children. */
  resetKey?: unknown;
  /** Replaces the default message. */
  label?: string;
  onError?: (err: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
  seenKey: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, seenKey: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // A new key means new content. Holding the error across that
    // boundary would leave a stale message sitting on top of data
    // that has since been replaced.
    if (state.error !== null && props.resetKey !== state.seenKey) {
      return { error: null, seenKey: props.resetKey };
    }
    return { seenKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    // Also to the console: this is a developer-facing breadcrumb, and
    // the user-facing copy deliberately does not name the component
    // stack, which is noise to anyone not debugging.
    console.error('[deqi] render error:', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="boundary boundary-error" role="alert">
        <div className="boundary-title">{this.props.label ?? 'Something went wrong here.'}</div>
        <p className="boundary-body">
          The rest of the app is still running — this part could not be displayed.
        </p>
        <button type="button" className="boundary-retry" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}

/**
 * The same boundary, sized for a chat block. A failed block renders a
 * single line in place, so the conversation above and below it stays
 * readable — which is the entire point of having it.
 */
export function BlockBoundary({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ErrorBoundary label={label ?? 'A message could not be displayed.'} resetKey={children}>
      {children}
    </ErrorBoundary>
  );
}
