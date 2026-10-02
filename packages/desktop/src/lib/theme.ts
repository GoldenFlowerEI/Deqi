/**
 * theme.ts — light / dark, with the system preference as the default.
 *
 * Small, and deliberately so. The temptation with a theme system is
 * to build a context, a provider tree, and a settings object, and end
 * up with more code than the two CSS blocks it is switching between.
 *
 * The contract this keeps:
 *   - the choice is applied to <html data-theme>, so CSS variables do
 *     the work and no component needs to know a theme exists;
 *   - an explicit choice persists; no choice follows the OS, live;
 *   - a corrupt stored value falls back to the OS rather than
 *     producing a theme named `undefined`.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'deqi.theme';

function prefersLight(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)').matches === true;
  } catch {
    return false;
  }
}

export function systemTheme(): Theme {
  return prefersLight() ? 'light' : 'dark';
}

export function readStoredTheme(): Theme | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    // Anything that is not exactly one of the two is treated as
    // absent. A half-written or hand-edited value must not become
    // `data-theme="undefined"`, which silently renders unthemed.
    return raw === 'dark' || raw === 'light' ? raw : null;
  } catch {
    return null;
  }
}

export function applyTheme(theme: Theme): void {
  try {
    const el = globalThis.document?.documentElement;
    if (!el) return;
    el.setAttribute('data-theme', theme);
    el.style.colorScheme = theme;
  } catch {
    /* no DOM (tests, SSR) — the caller still gets the value back */
  }
}

export function storeTheme(theme: Theme): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode, quota, disabled storage — the theme still applies
       for this session, it just will not be remembered */
  }
}

/** The theme to start with: the stored choice, else the OS. */
export function initialTheme(): Theme {
  return readStoredTheme() ?? systemTheme();
}

/** Apply the starting theme and keep following the OS until the user
 *  makes an explicit choice. Returns an unsubscribe function. */
export function initTheme(onChange?: (t: Theme) => void): () => void {
  const stored = readStoredTheme();
  applyTheme(stored ?? systemTheme());
  onChange?.(stored ?? systemTheme());

  if (stored) return () => { /* explicit choice: the OS is not in play */ };
  let mql: MediaQueryList | undefined;
  try {
    mql = globalThis.matchMedia?.('(prefers-color-scheme: light)');
  } catch {
    return () => { /* no matchMedia */ };
  }
  if (!mql) return () => { /* no matchMedia */ };
  const handler = (e: MediaQueryListEvent): void => {
    const t: Theme = e.matches ? 'light' : 'dark';
    applyTheme(t);
    onChange?.(t);
  };
  mql.addEventListener?.('change', handler);
  return () => mql.removeEventListener?.('change', handler);
}
