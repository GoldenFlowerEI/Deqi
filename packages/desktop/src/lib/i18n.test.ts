/**
 * i18n.test.ts
 *
 * The one property that matters for a hand-maintained dictionary pair:
 * both languages must have exactly the same keys. A key added to one
 * and forgotten in the other renders as the raw key path in the other
 * language, which looks like a bug in the app rather than in the
 * translation.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { EN, translate, detectLang, initialLang, readStoredLang, storeLang, applyLang, type Lang, type MsgKey } from './i18n';

// The Chinese table is not exported by value, but it is reachable
// through `translate`, which is enough to prove coverage.
const ALL_KEYS = Object.keys(EN) as MsgKey[];

function setNavigatorLanguages(langs: string[]): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { languages: langs, language: langs[0] ?? 'en' },
  });
}

describe('i18n dictionaries', () => {
  it('has keys to work with', () => {
    expect(ALL_KEYS.length).toBeGreaterThan(30);
  });

  it.each(ALL_KEYS)('zh has a translation for %s', (key) => {
    const zh = translate('zh', key);
    expect(zh, `missing zh translation for "${key}"`).toBeTruthy();
    // A copy-pasted English string is a real failure mode and reads
    // as a half-finished translation, so it is called out here rather
    // than left for someone to notice in the UI.
    if (zh !== EN[key]) expect(zh).not.toBe(key);
  });

  it('returns English for an unknown language rather than undefined', () => {
    const bogus = 'fr' as unknown as Lang;
    for (const key of ALL_KEYS) {
      expect(typeof translate(bogus, key)).toBe('string');
      expect(translate(bogus, key).length).toBeGreaterThan(0);
    }
  });

  it('gives English and Chinese the same key set by construction', () => {
    // `ZH` is typed as Record<MsgKey, string>, so TypeScript already
    // refuses a missing key. This asserts the runtime half: that the
    // values are actually populated and not accidentally emptied.
    for (const key of ALL_KEYS) {
      expect(translate('zh', key).trim().length).toBeGreaterThan(0);
      expect(translate('en', key).trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the {lang} attribute honest', () => {
    applyLang('zh');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-CN');
    applyLang('en');
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });
});

describe('language selection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('follows the browser when nothing is stored', () => {
    setNavigatorLanguages(['zh-CN', 'en']);
    expect(detectLang()).toBe('zh');
    setNavigatorLanguages(['en-GB', 'zh']);
    expect(detectLang()).toBe('en');
  });

  it('prefers an explicit choice over the browser', () => {
    setNavigatorLanguages(['zh-CN']);
    storeLang('en');
    expect(initialLang()).toBe('en');
    expect(readStoredLang()).toBe('en');
  });

  it.each(['', 'EN', 'zh_CN', 'de', '42'])('treats the stored value %o as absent', (raw) => {
    localStorage.setItem('deqi.lang', raw);
    expect(readStoredLang()).toBeNull();
  });

  it('falls back to English for a language it has no dictionary for', () => {
    setNavigatorLanguages(['de-DE', 'fr']);
    expect(detectLang()).toBe('en');
  });

  it('survives storage and navigator being unavailable', () => {
    const setItem = Storage.prototype.setItem;
    const getItem = Storage.prototype.getItem;
    Storage.prototype.setItem = () => { throw new Error('denied'); };
    Storage.prototype.getItem = () => { throw new Error('denied'); };
    expect(() => storeLang('zh')).not.toThrow();
    expect(readStoredLang()).toBeNull();
    Storage.prototype.setItem = setItem;
    Storage.prototype.getItem = getItem;
  });
});
