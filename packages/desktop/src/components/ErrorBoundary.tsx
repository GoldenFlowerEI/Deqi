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
import { translate, type Lang, type MsgKey } from '../lib/i18n';
import { useLang } from '../lib/useLang';

interface Props {
  children: ReactNode;
  /** Change this to clear a caught error and re-render the children. */
  resetKey?: unknown;
  /** Replaces the default message. */
  label?: string;
  /**
   * The active language, for the default copy. A class component
   * cannot call `useLang()`, so the value is passed in — and it also
   * means the boundary re-renders its message when the user switches
   * language, which is what they expect after clicking the toggle.
   */
  lang?: Lang;
  t?: (key: MsgKey) => string;
  onError?: (err: Error, info: ErrorInfo) => void;
}

/** Stand-in used when the boundary is rendered without a provider. */
const fallbackT = (key: MsgKey): string => translate('en', key);

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
    // The default copy comes from the dictionary rather than being
    // hardcoded here: a boundary message is the one string a user is
    // guaranteed to read, so it must be in whatever language they
    // chose. A custom `label` still wins.
    const t = this.props.t ?? fallbackT;
    return (
      <div className="boundary boundary-error" role="alert">
        <div className="boundary-title">{this.props.label ?? t('boundary.block')}</div>
        <p className="boundary-body">{t('boundary.stillRunning')}</p>
        <button type="button" className="boundary-retry" onClick={this.reset}>
          {t('boundary.retry')}
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
  const { lang, t } = useLang();
  return (
    <ErrorBoundary label={label ?? undefined} lang={lang} t={t} resetKey={children}>
      {children}
    </ErrorBoundary>
  );
}
