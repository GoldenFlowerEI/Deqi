/**
 * StatusBar — top banner of the chat area. Shows:
 *   - connection state to the deqi-server (with auto-reconnect hint)
 *   - active model
 *   - any error/info message from the WS
 */

import type { WsConnectionState } from '../lib/ws';

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
  return (
    <div className="status-bar">
      <span className="status-pill" style={{ color: STATE_COLOR[connection] }}>
        ● {STATE_LABEL[connection]}
      </span>
      <span className="status-model">model: <code>{model}</code></span>
      {info && <span className="status-info">{info}</span>}
    </div>
  );
}
