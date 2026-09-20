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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

export function loadConfig(): DeqiConfig {
  if (cached) return cached;
  const p = configPath();
  if (!existsSync(p)) {
    cached = EMPTY;
    return cached;
  }
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as DeqiConfig;
    cached = parsed.version === 1 ? parsed : EMPTY;
  } catch {
    cached = EMPTY;
  }
  return cached;
}

export function saveConfig(cfg: DeqiConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  cached = cfg;
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
      const envBase = process.env.Deqi_OPENAI_COMPAT_BASE_URL;
      if (envBase) {
        return process.env.Deqi_OPENAI_COMPAT_API_KEY || 'configured';
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
