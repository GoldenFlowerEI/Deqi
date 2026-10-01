/**
 * Deqi config — persists provider credentials and defaults to
 * `~/.deqi/config.json`. The file is read on CLI startup (env vars
 * take precedence) and may be written from inside the TUI via the
 * `/setup` and `/env` slash commands, or from the desktop app
 * via PATCH /v1/config.
 *
 * Schema (v1, v2.2 adds behavior fields):
 *   {
 *     "version": 1,
 *     "providers": {
 *       "anthropic": { "apiKey": "sk-..." },
 *       "openai":    { "apiKey": "sk-..." },
 *       "google":    { "apiKey": "..." },
 *       "openai-compat": { "baseUrl": "...", "apiKey": "...", "path": "/v1/chat/completions" }
 *     },
 *     "defaultModel": "claude-sonnet-4-5",
 *     "permissionMode": "smart",
 *     "showSurprise": true,
 *     "enableReflection": true
 *   }
 *
 * Env vars (if set) always take precedence over the file — this is
 * the standard 12-factor pattern.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  copyFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type PermissionMode = 'autonomous' | 'smart' | 'manual' | 'chat_only';

export interface DeqiConfig {
  version: 1;
  providers: {
    anthropic?: { apiKey: string };
    openai?: { apiKey: string };
    google?: { apiKey: string };
    'openai-compat'?: { baseUrl: string; apiKey: string; path?: string };
  };
  defaultModel?: string;
  /** goose-style 4-tier permission mode (v2.2). */
  permissionMode?: PermissionMode;
  /** Show the surprise banner when UserModel reports a topic shift. */
  showSurprise?: boolean;
  /** Reflection-in-action: derive a per-turn reflection entry. */
  enableReflection?: boolean;
}

const EMPTY: DeqiConfig = { version: 1, providers: {} };

function configPath(): string {
  return resolve(homedir(), '.deqi', 'config.json');
}

let cached: DeqiConfig | null = null;

/**
 * v0.3: why the last load failed, or null when it succeeded.
 *
 * The UI shows this so a user whose providers "disappeared" is told
 * the file is broken instead of being left to wonder.
 */
let lastLoadError: string | null = null;
let lastLoadBackup: string | null = null;

export function configLoadError(): { message: string; backup: string | null } | null {
  return lastLoadError ? { message: lastLoadError, backup: lastLoadBackup } : null;
}

/**
 * v0.3: move an unparseable config aside instead of dropping it.
 *
 * `loadConfig()` used to `catch { cached = EMPTY }` and move on. That
 * alone would be survivable, but any later `saveConfig()` — from the
 * settings page, from the setup wizard, from a provider edit — wrote
 * the EMPTY back over the original. A single stray byte (a trailing
 * comma from a hand edit, a half-flushed write from a crash during
 * a previous write) turned into a permanently empty config: every
 * stored API key gone, with no error shown and no file to recover
 * from.
 *
 * So the original is preserved. `config.json.broken-<n>` keeps the
 * exact bytes; only after that copy is on disk does the caller see a
 * fresh EMPTY.
 */
function quarantineUnreadableConfig(p: string, reason: string): void {
  const dir = dirname(p);
  for (let n = 1; n <= 50; n += 1) {
    const dest = join(dir, `config.json.broken-${n}`);
    if (existsSync(dest)) continue;
    try {
      copyFileSync(p, dest);
      lastLoadBackup = dest;
      console.error(
        `[deqi] config at ${p} is unreadable (${reason}). ` +
        `The original was preserved at ${dest}; continuing with an empty config. ` +
        `Fix or merge that file to restore your providers.`,
      );
      return;
    } catch (e) {
      console.error(`[deqi] could not preserve the broken config: ${(e as Error).message}`);
      return;
    }
  }
  console.error(`[deqi] config at ${p} is unreadable and 50 .broken-N backups already exist.`);
}

export function loadConfig(): DeqiConfig {
  if (cached) return cached;
  const p = configPath();
  if (!existsSync(p)) {
    cached = EMPTY;
    lastLoadError = null;
    return cached;
  }
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    lastLoadError = `could not read ${p}: ${(e as Error).message}`;
    cached = EMPTY;
    return cached;
  }
  let parsed: DeqiConfig;
  try {
    parsed = JSON.parse(raw) as DeqiConfig;
  } catch (e) {
    // The file exists but is not JSON. This is the case that used to
    // cost the user their API keys.
    lastLoadError = `${p} is not valid JSON: ${(e as Error).message}`;
    quarantineUnreadableConfig(p, (e as Error).message);
    cached = EMPTY;
    return cached;
  }
  if (parsed.version !== 1) {
    // Well-formed JSON, wrong shape. Do NOT quarantine — this file
    // may be a deliberate newer format, and rewriting it would
    // downgrade data the user has not asked us to touch. Just say so.
    lastLoadError = `${p} has version ${String(parsed.version)}; this build understands version 1`;
    cached = EMPTY;
    return cached;
  }
  cached = parsed;
  lastLoadError = null;
  return cached;
}

/**
 * v0.3: write the config atomically.
 *
 * The old `writeFileSync(p, ...)` truncates the destination before
 * writing. A crash, a full disk, or a concurrent read at that instant
 * leaves a half-written config.json — which is then quarantined as
 * "broken" on the next start, exactly the loss this file is trying to
 * prevent. Write to a sibling temp file, flush it, then rename: the
 * rename is atomic on every platform we target, so config.json is
 * either the old content or the new content, never a mixture.
 */
export function saveConfig(cfg: DeqiConfig): void {
  const p = configPath();
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.config.json.${process.pid}.${Date.now().toString(36)}.tmp`);
  const body = JSON.stringify(cfg, null, 2);
  try {
    // wx: fail rather than clobber if the temp name somehow exists.
    writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx' });
    // Force the bytes out before the rename makes them visible.
    const fd = openSync(tmp, 'r+');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw new Error(
      `failed to write ${p}: ${(e as Error).message}. ` +
      `Your previous config is unchanged.`,
    );
  }
  cached = cfg;
  lastLoadError = null;
}

/** Read the active API key for a given provider, env-first. */
export function providerKey(provider: 'anthropic' | 'openai' | 'google' | 'openai-compat'): string | null {
  switch (provider) {
    case 'anthropic':
      return process.env.ANTHROPIC_API_KEY || loadConfig().providers.anthropic?.apiKey || null;
    case 'openai':
      return process.env.OPENAI_API_KEY || loadConfig().providers.openai?.apiKey || null;
    case 'google':
      return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || loadConfig().providers.google?.apiKey || null;
    case 'openai-compat': {
      const envBase = process.env.DEQI_OPENAI_COMPAT_BASE_URL;
      if (envBase) {
        return process.env.DEQI_OPENAI_COMPAT_API_KEY || 'configured';
      }
      const c = loadConfig().providers['openai-compat'];
      return c?.apiKey || null;
    }
  }
}

/** Set a provider's API key in the config file (env vars still take precedence). */
export function setProviderKey(
  provider: 'anthropic' | 'openai' | 'google' | 'openai-compat',
  key: string,
  extras?: { baseUrl?: string; path?: string },
): DeqiConfig {
  const cfg = { ...loadConfig() };
  cfg.providers = { ...cfg.providers };
  if (provider === 'openai-compat') {
    cfg.providers['openai-compat'] = {
      baseUrl: extras?.baseUrl ?? cfg.providers['openai-compat']?.baseUrl ?? '',
      apiKey: key,
      path: extras?.path ?? cfg.providers['openai-compat']?.path,
    };
  } else {
    cfg.providers[provider] = { apiKey: key };
  }
  saveConfig(cfg);
  return cfg;
}

export function setDefaultModel(modelId: string): DeqiConfig {
  const cfg = { ...loadConfig() };
  cfg.defaultModel = modelId;
  saveConfig(cfg);
  return cfg;
}

/** v2.2: Update behavior settings in one call. */
export function setBehavior(patch: {
  permissionMode?: PermissionMode;
  showSurprise?: boolean;
  enableReflection?: boolean;
}): DeqiConfig {
  const cfg = { ...loadConfig() };
  if (patch.permissionMode !== undefined) cfg.permissionMode = patch.permissionMode;
  if (patch.showSurprise !== undefined) cfg.showSurprise = patch.showSurprise;
  if (patch.enableReflection !== undefined) cfg.enableReflection = patch.enableReflection;
  saveConfig(cfg);
  return cfg;
}

/** v2.2: Add or update a provider's full config (apiKey, baseUrl, path). */
export function setProvider(
  name: 'anthropic' | 'openai' | 'google' | 'openai-compat',
  patch: { apiKey?: string; baseUrl?: string; path?: string },
): DeqiConfig {
  const cfg = { ...loadConfig() };
  cfg.providers = { ...cfg.providers };
  if (name === 'openai-compat') {
    const cur = cfg.providers['openai-compat'] ?? { baseUrl: '', apiKey: '' };
    cfg.providers['openai-compat'] = {
      baseUrl: patch.baseUrl ?? cur.baseUrl ?? '',
      apiKey: patch.apiKey ?? cur.apiKey ?? '',
      path: patch.path ?? cur.path,
    };
  } else {
    const cur = cfg.providers[name] ?? { apiKey: '' };
    cfg.providers[name] = { apiKey: patch.apiKey ?? cur.apiKey ?? '' };
  }
  saveConfig(cfg);
  return cfg;
}

/** v2.2: Resolve the persisted behavior settings with defaults applied. */
export function resolveBehavior(): {
  permissionMode: PermissionMode;
  showSurprise: boolean;
  enableReflection: boolean;
} {
  const cfg = loadConfig();
  return {
    permissionMode: cfg.permissionMode ?? 'smart',
    showSurprise: cfg.showSurprise ?? true,
    enableReflection: cfg.enableReflection ?? true,
  };
}

export function _resetConfigCache(): void {
  cached = null;
}

export { configPath };
