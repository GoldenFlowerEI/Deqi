/**
 * StatusBar — top banner of the chat area. Shows:
 *   - connection state to the deqi-server (with auto-reconnect hint)
 *   - active model
 *   - any error/info message from the WS
 *   - the light/dark toggle (v0.5)
 */

import { useEffect, useState } from 'react';
import type { WsConnectionState } from '../lib/ws';
import { applyTheme, initialTheme, initTheme, storeTheme, type Theme } from '../lib/theme';
import { useLang } from '../lib/useLang';

interface StatusBarProps {
  connection: WsConnectionState;
  info?: string;
  model: string;
}

const STATE_LABEL: Record<WsConnectionState, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  closed: 'Disconnected',
  error: 'Error',
};

const STATE_COLOR: Record<WsConnectionState, string> = {
  connecting: 'var(--status-warn)',
  open: 'var(--status-ok)',
  closed: 'var(--status-dim)',
  error: 'var(--status-err)',
};

export function StatusBar({ connection, info, model }: StatusBarProps) {
  // v0.5: the theme toggle lives here because the status bar is the
  // one strip that is visible on every view, including the empty
  // ones where there is nothing else to click.
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  useEffect(() => initTheme(), []);
  const { t, lang, setLang } = useLang();

  const toggle = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    storeTheme(next);
    setTheme(next);
  };

  return (
    <div className="status-bar">
      <span className="status-pill" style={{ color: STATE_COLOR[connection] }}>
        ● {STATE_LABEL[connection]}
      </span>
      <span className="status-model">{t('status.model')} <code>{model}</code></span>
      {info && <span className="status-info">{info}</span>}
      <button
        type="button"
        className="status-toggle"
        onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
        title={t('status.lang')}
        aria-label={t('status.lang')}
      >
        {lang === 'en' ? '中文' : 'EN'}
      </button>
      <button
        type="button"
        className="status-toggle"
        onClick={toggle}
        title={theme === 'dark' ? t('status.theme.light') : t('status.theme.dark')}
        aria-label={theme === 'dark' ? t('status.theme.light') : t('status.theme.dark')}
      >
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </div>
  );
}
