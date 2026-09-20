/**
 * WebSocket client for the deqi desktop app.
 *
 * Connects to the deqi-server's /v1/chat endpoint. Dispatches
 * incoming SessionEvents to a listener registered by the React
 * UI. Single connection per app instance — the server multiplexes
 * sessions over one socket via the `session_id` field.
 *
 * Reconnection: a backoff retry (1s → 2s → 4s, capped at 30s)
 * kicks in whenever the socket closes unexpectedly. The UI
 * listens to `onConnectionChange` to surface the state.
 */

import type { WsClientMessage, WsServerMessage, SessionEvent } from './types';

export type WsConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export interface WsEventCallbacks {
  onConnectionChange?: (state: WsConnectionState, info?: string) => void;
  onSessionEvent?: (sessionId: string, event: SessionEvent) => void;
  onError?: (message: string) => void;
  onAck?: (serverVersion: string) => void;
}

export class DeqiWebSocket {
  private socket: WebSocket | null = null;
  private state: WsConnectionState = 'closed';
  private retryDelay = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private url: string;

  constructor(
    private readonly callbacks: WsEventCallbacks,
    baseUrl: string = 'ws://127.0.0.1:7700/v1/chat',
  ) {
    this.url = baseUrl;
  }

  /** Open the connection. Idempotent. */
  connect(): void {
    if (this.state === 'open' || this.state === 'connecting') return;
    this.shouldReconnect = true;
    this.open();
  }

  /** Close the connection. Won't reconnect unless `connect()` is
   *  called again. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.setState('closed');
  }

  /** Send a typed message. Throws if the socket isn't open. */
  send(msg: WsClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`ws not open (state=${this.state})`);
    }
    this.socket.send(JSON.stringify(msg));
  }

  private open(): void {
    this.setState('connecting');
    try {
      this.socket = new WebSocket(this.url);
    } catch (err) {
      this.setState('error', String((err as Error).message));
      this.scheduleRetry();
      return;
    }
    this.socket.onopen = () => {
      this.retryDelay = 1000;
      this.setState('open');
      this.send({ type: 'hello', protocol: 1 });
    };
    this.socket.onclose = (ev) => {
      this.socket = null;
      if (this.shouldReconnect) {
        this.scheduleRetry();
      } else {
        this.setState('closed');
      }
      void ev;
    };
    this.socket.onerror = () => {
      // onclose will fire too; we just adjust the message.
      this.setState('error', 'socket error');
    };
    this.socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsServerMessage;
        this.handleServerMessage(msg);
      } catch (err) {
        this.callbacks.onError?.(`bad message: ${(err as Error).message}`);
      }
    };
  }

  private handleServerMessage(msg: WsServerMessage): void {
    if (msg.type === 'hello_ack') {
      this.callbacks.onAck?.(msg.server_version);
      return;
    }
    if (msg.type === 'error') {
      this.callbacks.onError?.(msg.message);
      return;
    }
    if (msg.type === 'session_event') {
      this.callbacks.onSessionEvent?.(msg.session_id, msg.event);
      return;
    }
    // The other message types (sessions_list, session_details, …)
    // are REST responses, not WS. The desktop app uses fetch()
    // for those. We ignore them here to keep the WS scope
    // narrow.
  }

  private setState(s: WsConnectionState, info?: string): void {
    this.state = s;
    this.callbacks.onConnectionChange?.(s, info);
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.shouldReconnect) this.open();
    }, this.retryDelay);
    // exponential backoff capped at 30s
    this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
  }
}
