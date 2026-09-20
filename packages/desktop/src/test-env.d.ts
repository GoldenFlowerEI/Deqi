// vitest-env.d.ts — global type augmentations for the test suite.
// This file is included by tsconfig.json (src/**/*), so every
// test file under src/ picks up these types automatically — even
// though the runtime setup file lives in test/setup.ts.

// @testing-library/jest-dom matchers (toBeInTheDocument,
// toBeDisabled, toHaveTextContent, toBeEmptyDOMElement, etc.)
/// <reference types="@testing-library/jest-dom/vitest" />

// jsdom's WebSocket is a no-op stub. lib/ws.ts uses only its
// constructor + the (url, protocols) signature, which is enough
// for `new WebSocket(url)` to type-check.
interface WebSocketConstructor {
  new (url: string, protocols?: string | string[]): WebSocket;
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;
}
declare global {
  interface WebSocket {
    readonly readyState: number;
    onopen: ((ev: Event) => void) | null;
    onclose: ((ev: CloseEvent) => void) | null;
    onmessage: ((ev: MessageEvent) => void) | null;
    onerror: ((ev: Event) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
  }
  var WebSocket: WebSocketConstructor;
}

export {};