/**
 * vitest.config.ts — Deqi desktop frontend test runner.
 *
 * Strategy:
 *   - jsdom environment (React Testing Library is the bread-and-butter
 *     component runner; jsdom is enough for our needs — we don't need
 *     a real browser)
 *   - Tauri APIs are mocked in `test/setup.ts` via @tauri-apps/api/mocks,
 *     so component tests don't need a running Tauri shell
 *   - Coverage via v8 (built into vitest; c8 alternative is heavier)
 *   - Test files live next to their source (`*.test.tsx` co-located)
 *     for fast discoverability, plus a top-level integration test in
 *     `test/integration.test.tsx` if it grows
 *
 * Why not Playwright Component Testing (CT)?
 *   Playwright CT spins up a real browser per component, which is slow
 *   for 9 components. We use jsdom for the unit layer and reserve
 *   Playwright for end-to-end tests against the Vite dev server.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    css: false,                  // ← no CSS extraction; CSS classes still detectable
    include: [
      'src/**/*.test.{ts,tsx}',
      'test/**/*.test.{ts,tsx}',
    ],
    exclude: [
      'node_modules/**',
      'src-tauri/**',
      'dist/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/**/*.d.ts',
      ],
    },
  },
});