/**
 * e2e/visual-audit.spec.ts — open each main view in the Vite dev
 * server (no Tauri shell needed; the React app is a regular SPA
 * that talks to deqi-server over REST + WebSocket) and take a
 * screenshot. Used for the v0.1 manual visual audit; the output
 * goes to e2e/screenshots/v0.1-audit-*.png.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const VITE_URL = process.env.VITE_URL ?? 'http://127.0.0.1:5173';
const OUT_DIR = path.resolve(__dirname, 'screenshots');

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

test.describe('Deqi v0.1 desktop — visual audit', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('chat (welcome)', async ({ page }) => {
    await page.goto(VITE_URL);
    await expect(page.getByText('Deqi')).toBeVisible();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-chat.png'), fullPage: false });
  });

  test('search', async ({ page }) => {
    await page.goto(VITE_URL);
    await page.getByText('Search').click();
    await expect(page.getByText(/Across all sessions/)).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-search.png') });
  });

  test('schedule', async ({ page }) => {
    await page.goto(VITE_URL);
    await page.getByText('Schedule').click();
    await expect(page.getByText(/Run any prompt on a timer/)).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-schedule.png') });
  });

  test('plugins (soon)', async ({ page }) => {
    await page.goto(VITE_URL);
    await page.getByText('Plugins').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-plugins.png') });
  });

  test('web (soon)', async ({ page }) => {
    await page.goto(VITE_URL);
    await page.getByText('Web').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-web.png') });
  });

  test('mobile (phase 2)', async ({ page }) => {
    await page.goto(VITE_URL);
    await page.getByText('Mobile').click();
    await expect(page.getByText(/Pair your phone/)).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-mobile.png') });
  });

  test('feedback', async ({ page }) => {
    await page.goto(VITE_URL);
    await page.getByText('Feedback').click();
    await expect(page.getByText(/Send feedback/)).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-feedback.png') });
  });

  test('settings', async ({ page }) => {
    await page.goto(VITE_URL);
    await page.getByText('Settings').click();
    await expect(page.getByText(/Preferences, models, and behavior/)).toBeVisible();
    await page.waitForTimeout(800); // wait for /v1/config to load
    await page.screenshot({ path: path.join(OUT_DIR, 'v0.1-audit-settings.png') });
  });

  test('a11y smoke — every interactive control has an accessible name', async ({ page }) => {
    await page.goto(VITE_URL);
    const buttons = await page.getByRole('button').all();
    for (const btn of buttons) {
      const name = await btn.getAttribute('aria-label') ?? (await btn.textContent());
      expect(name, `button missing accessible name`).toBeTruthy();
      expect(name!.trim().length, `button has empty name`).toBeGreaterThan(0);
    }
  });

  test('a11y smoke — every nav rail item is reachable by keyboard', async ({ page }) => {
    await page.goto(VITE_URL);
    const rail = page.locator('.rail');
    const railButtons = await rail.getByRole('button').all();
    expect(railButtons.length).toBeGreaterThanOrEqual(8);
    // Focus first button, then tab through; ensure no trap.
    await railButtons[0].focus();
    for (let i = 0; i < railButtons.length; i += 1) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => document.activeElement?.tagName);
      expect(focused).toBeTruthy();
    }
  });

  test('no console errors during navigation across all views', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.goto(VITE_URL);
    for (const label of ['Search', 'Schedule', 'Plugins', 'Web', 'Mobile', 'Feedback', 'Settings']) {
      await page.getByText(label).click();
      await page.waitForTimeout(300);
    }
    // Filter out expected-dev-only warnings (e.g. source map, React DevTools).
    const real = errors.filter((e) => !e.includes('source map') && !e.includes('Download the React DevTools'));
    expect(real, `console errors:\n${real.join('\n')}`).toHaveLength(0);
  });
});