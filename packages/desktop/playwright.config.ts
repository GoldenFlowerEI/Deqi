/**
 * playwright.config.ts — Deqi desktop E2E runner.
 *
 * Strategy: spin up the Vite dev server in the background; Playwright
 * runs the audit specs against it. The React app talks REST + WS to
 * deqi-server (expected to be running on 127.0.0.1:7700).
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'bun run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});