/**
 * test/setup.ts — runs before every Vitest test file.
 *
 * Responsibilities:
 *   1. Install @testing-library/jest-dom matchers (toBeInTheDocument, etc.)
 *   2. Mock @tauri-apps/api so component tests don't need a running shell
 *   3. Clear mocks between tests so state doesn't leak
 *
 * The Tauri mocks come from the official @tauri-apps/api/mocks module.
 * We use mockIPC for command-style calls and mockWindows for window
 * queries. Event mocks aren't needed at the component layer — the
 * server's WebSocket is the event source, not Tauri.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';

// Default mock — components that need a real IPC handler can call
// mockIPC() again inside their test (it overrides). Without an
// explicit handler, invoke() resolves with `null`.
mockIPC(() => null);

// jsdom doesn't ship with matchMedia; the StatusBar queries it
// for the prefers-reduced-motion media query.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom doesn't implement WebSocket — the WebSocket class is
// re-implemented in our lib/ws.ts. Reset the spy between tests.
afterEach(() => {
  clearMocks();
  vi.clearAllMocks();
});