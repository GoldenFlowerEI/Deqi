/**
 * identity.test.ts — APP_VERSION, DESKTOP_ID, detectUpgrade.
 * v0.2: lock the version string + the per-install id scheme.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The DESKTOP_ID constant is captured at module load. To test
// detectUpgrade + getDesktopId in isolation, we re-import the
// module per scenario.
async function loadIdentity() {
  vi.resetModules();
  return await import('./identity');
}

describe('identity.APP_VERSION', () => {
  it('is a non-empty versioned string', async () => {
    const { APP_VERSION } = await loadIdentity();
    expect(APP_VERSION).toMatch(/^v\d+\.\d+/);
    expect(APP_VERSION.length).toBeGreaterThan(3);
  });
});

describe('identity.DESKTOP_ID', () => {
  it('is generated lazily and stored in localStorage', async () => {
    const { DESKTOP_ID } = await loadIdentity();
    expect(DESKTOP_ID).toMatch(/^d_[0-9a-f]{16}$/);
    expect(window.localStorage.getItem('deqi:desktop-id')).toBe(DESKTOP_ID);
  });

  it('returns the stored id on subsequent loads', async () => {
    window.localStorage.setItem('deqi:desktop-id', 'd_0123456789abcdef');
    const { DESKTOP_ID } = await loadIdentity();
    expect(DESKTOP_ID).toBe('d_0123456789abcdef');
  });

  it('replaces a malformed stored id with a fresh one', async () => {
    window.localStorage.setItem('deqi:desktop-id', 'totally-not-valid');
    const { DESKTOP_ID } = await loadIdentity();
    expect(DESKTOP_ID).toMatch(/^d_[0-9a-f]{16}$/);
    expect(DESKTOP_ID).not.toBe('totally-not-valid');
  });
});

describe('identity.detectUpgrade', () => {
  it('returns null when there is no prior version stored', async () => {
    const { detectUpgrade, APP_VERSION } = await loadIdentity();
    const result = detectUpgrade();
    expect(result).toBeNull();
    // After the first call, the version is recorded for next time
    expect(window.localStorage.getItem('deqi:app-version')).toBe(APP_VERSION);
  });

  it('returns null when the stored version matches APP_VERSION', async () => {
    const { detectUpgrade, APP_VERSION } = await loadIdentity();
    window.localStorage.setItem('deqi:app-version', APP_VERSION);
    expect(detectUpgrade()).toBeNull();
  });

  it('returns {from, to} when the stored version differs from APP_VERSION', async () => {
    const { detectUpgrade, APP_VERSION } = await loadIdentity();
    window.localStorage.setItem('deqi:app-version', 'v0.1.0');
    const result = detectUpgrade();
    expect(result).toEqual({ from: 'v0.1.0', to: APP_VERSION });
    // And the new version is now recorded
    expect(window.localStorage.getItem('deqi:app-version')).toBe(APP_VERSION);
  });
});

describe('identity.getDesktopId (direct)', () => {
  it('returns a hex id matching the d_<16hex> shape', async () => {
    const { getDesktopId } = await loadIdentity();
    const id = getDesktopId();
    expect(id).toMatch(/^d_[0-9a-f]{16}$/);
  });

  it('returns the same id across calls when storage is intact', async () => {
    const { getDesktopId } = await loadIdentity();
    const a = getDesktopId();
    const b = getDesktopId();
    expect(a).toBe(b);
  });
});