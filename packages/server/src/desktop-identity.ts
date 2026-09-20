/**
 * v4.8: stable desktop identity.
 *
 * Each running Deqi-server gets a persistent id stored at
 * `~/.deqi/desktop-id`. The id is generated on first read (using
 * 8 random bytes hex) and reused on every subsequent read so a
 * desktop keeps the same identity across restarts.
 *
 * The desktop_id is what we use in the cluster registry, in the
 * push endpoint (so a phone can target a specific machine), and
 * in the RPC dispatch (so `delegate_remote` can pin tasks).
 *
 * Format: `d_` + 16 hex chars, e.g. `d_8a3f4b2c1d5e7f90`. The
 * prefix makes it greppable in logs and avoids confusion with
 * session ids (`sess_...`) or pair ids (`pair_...`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const Deqi_HOME = join(homedir(), '.deqi');
const ID_PATH = join(Deqi_HOME, 'desktop-id');

let cached: string | null = null;

export function getDesktopId(): string {
  if (cached) return cached;
  // v4.8: explicit override (testing + multi-instance on the
  // same machine). Setting Deqi_DESKTOP_ID lets two Deqi-servers
  // run side-by-side on one host without colliding in
  // cluster.json. Production deployments on distinct machines
  // never set this — each machine gets its own persisted id.
  const override = process.env.Deqi_DESKTOP_ID ?? '';
  if (/^d_[0-9a-f]{16}$/.test(override)) {
    cached = override;
    return cached;
  }
  if (!existsSync(Deqi_HOME)) mkdirSync(Deqi_HOME, { recursive: true });
  if (existsSync(ID_PATH)) {
    const raw = readFileSync(ID_PATH, 'utf8').trim();
    // Defensive: if the file is corrupted (truncated, empty,
    // wrong prefix), regenerate. The id MUST be `d_` + 16 hex.
    if (/^d_[0-9a-f]{16}$/.test(raw)) {
      cached = raw;
      return cached;
    }
  }
  const fresh = 'd_' + randomBytes(8).toString('hex');
  writeFileSync(ID_PATH, fresh + '\n', 'utf8');
  cached = fresh;
  return cached;
}

/** Test-only: clear the cache so the next call re-reads from disk. */
export function _resetDesktopIdForTests(): void {
  cached = null;
}
