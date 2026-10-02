/**
 * useLang.tsx — the React binding for i18n.
 *
 * A single context, because a language switch has to re-render every
 * component that holds a string. Anything more elaborate would be a
 * second copy of this file.
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  applyLang,
  initialLang,
  storeLang,
  translate,
  type Lang,
  type MsgKey,
} from './i18n';

interface LangContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: MsgKey) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => initialLang());

  useEffect(() => { applyLang(lang); }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    storeLang(l);
  }, []);

  const value = useMemo<LangContextValue>(() => ({
    lang,
    setLang,
    t: (key: MsgKey) => translate(lang, key),
  }), [lang, setLang]);

  return createElement(LangContext.Provider, { value }, children);
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  // Falling back rather than throwing: a component rendered outside
  // the provider (a test, a storybook) should get working English,
  // not a blank screen.
  if (ctx) return ctx;
  return {
    lang: 'en',
    setLang: () => { /* no provider — nothing to switch */ },
    t: (key) => translate('en', key),
  };
}
