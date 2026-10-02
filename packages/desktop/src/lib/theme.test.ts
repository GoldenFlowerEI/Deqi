/**
 * theme.test.ts
 *
 * The property worth protecting is the fallback chain. A theme
 * system that reads a corrupt stored value and applies
 * `data-theme="undefined"` renders the app with no variables at all,
 * and it does so silently.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  applyTheme,
  initialTheme,
  readStoredTheme,
  storeTheme,
  systemTheme,
} from './theme';

function setPrefLight(on: boolean): void {
  // jsdom has matchMedia but not its behaviour; drive it directly.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (q: string) => ({
      matches: on && q.includes('light'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    setPrefLight(false);
  });

  it('follows the OS when nothing is stored', () => {
    setPrefLight(true);
    expect(systemTheme()).toBe('light');
    setPrefLight(false);
    expect(systemTheme()).toBe('dark');
  });

  it('prefers an explicit choice over the OS', () => {
    setPrefLight(true);
    storeTheme('dark');
    expect(initialTheme()).toBe('dark');
  });

  it('writes the attribute CSS variables key off', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    // Native form controls and scrollbars follow colorScheme; without
    // it a light theme still gets a dark scrollbar.
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('persists a choice across a reload', () => {
    storeTheme('light');
    expect(readStoredTheme()).toBe('light');
    expect(initialTheme()).toBe('light');
  });

  // ─── the corrupt-value cases ─────────────────────────────────
  it.each([
    ['an empty string', ''],
    ['a half-written value', 'lig'],
    ['an old theme name', 'solarized'],
    ['a number', '42'],
    ['a JSON blob', '{"theme":"light"}'],
  ])('ignores %s in storage', (_label, raw) => {
    localStorage.setItem('deqi.theme', raw as string);
    expect(readStoredTheme()).toBeNull();
    // And falls back to the OS rather than to something unthemed.
    setPrefLight(true);
    expect(initialTheme()).toBe('light');
  });

  it('never produces a theme name outside the two it knows', () => {
    for (const raw of ['', 'x', 'DARK', 'dark ', ' light']) {
      localStorage.setItem('deqi.theme', raw);
      const t = initialTheme();
      expect(['dark', 'light']).toContain(t);
    }
  });

  it('survives storage being unavailable', () => {
    // Private mode / disabled storage throws rather than returning
    // null. The theme must still apply for this session.
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error('denied'); };
    expect(() => storeTheme('light')).not.toThrow();
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    Storage.prototype.setItem = original;
  });

  it('survives localStorage.getItem throwing on read', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('denied'); };
    expect(readStoredTheme()).toBeNull();
    setPrefLight(true);
    expect(initialTheme()).toBe('light');
    Storage.prototype.getItem = original;
  });

  it('survives a missing matchMedia', () => {
    // @ts-expect-error — deliberately removing a browser API
    delete window.matchMedia;
    expect(systemTheme()).toBe('dark');
    expect(initialTheme()).toBe('dark');
  });
});
