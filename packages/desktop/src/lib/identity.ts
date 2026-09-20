/**
 * Deqi identity constants used for telemetry + feedback + cluster registration.
 *
 * APP_VERSION: a single source of truth for the desktop bundle version.
 * Bumped in the same commit as the Cargo.toml / tauri.conf.json version.
 * The string is also surfaced in the Settings → About panel, so changing
 * it changes what users see.
 *
 * DESKTOP_ID: a stable per-install id. Generated once and stored in
 * `localStorage` so it survives reloads but is per-browser-profile.
 * Used by the feedback channel + the future cluster registry to
 * cross-reference the user's machine.
 */

const VERSION_STORAGE_KEY = 'deqi:app-version';
const ID_STORAGE_KEY = 'deqi:desktop-id';

function generateHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i += 1) arr[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

// v0.2: bumped from legacy "v5.1.0" (pre-rebrand from GFEI). The Deqi
// release train is 0.x; we'll switch to 1.0 once we have a stable API.
export const APP_VERSION = 'v0.2.0';

export function getDesktopId(): string {
  let id = localStorage.getItem(ID_STORAGE_KEY);
  if (!id || !/^d_[0-9a-f]{16}$/.test(id)) {
    id = 'd_' + generateHex(8);
    try {
      localStorage.setItem(ID_STORAGE_KEY, id);
    } catch {
      // localStorage may be unavailable (private mode, etc.).
      // Fall through; the session-only id is still useful.
    }
  }
  return id;
}

export const DESKTOP_ID = getDesktopId();

// Bump-detection helper: if a previously stored APP_VERSION differs
// from the current bundle version, the user just upgraded. Useful
// for "what's new in v5.2" prompts.
export function detectUpgrade(): { from: string; to: string } | null {
  const prev = localStorage.getItem(VERSION_STORAGE_KEY);
  if (prev && prev !== APP_VERSION) {
    try {
      localStorage.setItem(VERSION_STORAGE_KEY, APP_VERSION);
    } catch {
      // ignore
    }
    return { from: prev, to: APP_VERSION };
  }
  if (!prev) {
    try {
      localStorage.setItem(VERSION_STORAGE_KEY, APP_VERSION);
    } catch {
      // ignore
    }
  }
  return null;
}
