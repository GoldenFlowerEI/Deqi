/**
 * Registry: resolves a Model + a configured provider key to a working StreamFunction.
 *
 * In v0.1 the registry is built from environment variables. Users can add
 * custom entries by extending the registry at runtime.
 */

import type { Model, Provider, StreamFunction } from './types.js';
import { KNOWN_MODELS, getModel } from './models.js';
import { MOCK_MODEL } from './providers/mock.js';
import {
  createAnthropicStream,
  type AnthropicConfig,
} from './providers/anthropic.js';
import { createOpenAIStream, type OpenAIConfig } from './providers/openai.js';
import { createGoogleStream, type GoogleConfig } from './providers/google.js';
import {
  createOpenAICompatStream,
  type OpenAICompatConfig,
} from './providers/openai-compat.js';

export interface ProviderAuth {
  anthropic?: AnthropicConfig;
  openai?: OpenAIConfig;
  google?: GoogleConfig;
  'openai-compat'?: OpenAICompatConfig;
  /** v1.1: mock provider carries no credentials; the field exists
   *  only so the auth type stays uniform. */
  mock?: { model?: string };
}

export class ModelRegistry {
  private auth: ProviderAuth;
  private customModels: Model[] = [];
  private mockFactory: ((auth: { model?: string }) => StreamFunction) | null = null;

  constructor(auth: ProviderAuth = {}, customModels: Model[] = []) {
    this.auth = auth;
    this.customModels = customModels;
    // Pre-load the mock provider at construction time. ESM
    // top-level await is fine here because by the time
    // ModelRegistry is constructed, the module graph is ready.
    void this.loadMockFactory();
  }

  private async loadMockFactory(): Promise<void> {
    if (this.mockFactory) return;
    const mod = (await import('./providers/mock.js')) as typeof import('./providers/mock.js');
    this.mockFactory = mod.createMockStream;
  }

  /**
   * Replace the auth configuration in-place. v1.1: lets a session
   * that started with no provider pick one up at runtime (e.g. via
   * the TUI's /setup command) without rebuilding the registry.
   */
  setAuth(auth: ProviderAuth): void {
    this.auth = auth;
  }

  /**
   * Re-read the auth from process.env. Convenience wrapper around
   * setAuth(ModelRegistry.fromEnv().getAuth()).
   */
  reloadFromEnv(env: NodeJS.ProcessEnv = process.env): void {
    const next = ModelRegistry.fromEnv(env);
    this.auth = (next as unknown as { auth: ProviderAuth }).auth;
  }

  /** Build a registry from process.env (the conventional way). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ModelRegistry {
    const auth: ProviderAuth = {};
    if (env.ANTHROPIC_API_KEY) {
      auth.anthropic = {
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL,
      };
    }
    if (env.OPENAI_API_KEY) {
      auth.openai = {
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL,
      };
    }
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
      auth.google = {
        apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY!,
        baseUrl: env.GOOGLE_BASE_URL,
      };
    }
    if (env.Deqi_OPENAI_COMPAT_BASE_URL && env.Deqi_OPENAI_COMPAT_API_KEY) {
      auth['openai-compat'] = {
        apiKey: env.Deqi_OPENAI_COMPAT_API_KEY,
        baseUrl: env.Deqi_OPENAI_COMPAT_BASE_URL,
        path: env.Deqi_OPENAI_COMPAT_PATH,
      };
    }
    return new ModelRegistry(auth);
  }

  addCustomModel(model: Model): void {
    this.customModels.push(model);
  }

  /** Read-only access to the current auth (used by config.ts). */
  getAuth(): ProviderAuth {
    return { ...this.auth };
  }

  listModels(): Model[] {
    // The mock model is always listed; the TUI uses it for --demo
    // sessions and for showing what `deqi` looks like with no
    // provider configured.
    return [MOCK_MODEL, ...KNOWN_MODELS, ...this.customModels];
  }

  resolveModel(idOrAlias: string): Model {
    const all = this.listModels();
    const found = all.find((m) => m.id === idOrAlias) ?? getModel(idOrAlias);
    if (found) return found;
    throw new Error(`Unknown model: ${idOrAlias}`);
  }

  /** Returns true if this provider is configured with credentials. */
  isProviderAvailable(provider: Provider): boolean {
    switch (provider) {
      case 'anthropic':
        return Boolean(this.auth.anthropic?.apiKey);
      case 'openai':
        return Boolean(this.auth.openai?.apiKey);
      case 'google':
        return Boolean(this.auth.google?.apiKey);
      case 'openai-compat':
        return Boolean(this.auth['openai-compat']?.apiKey);
      case 'mock':
        return true; // mock is always available; needs no key
    }
  }

  /**
   * Returns a StreamFunction for the given model. For providers that
   * need configuration (anthropic/openai/google/openai-compat), the
   * auth must be set; for the mock provider, no auth is required.
   *
   * The mock stream is a lazy ESM import — kept out of the eager
   * import graph so the registry doesn't pull in mock.ts when the
   * user only uses real providers.
   */
  getStream(model: Model): StreamFunction {
    switch (model.provider) {
      case 'mock': {
        // We import synchronously here because Node ESM allows it
        // via createRequire from 'node:module'. But cleaner: we
        // pre-load in the constructor instead, so by the time
        // getStream is called, the mock factory is already imported.
        if (!this.mockFactory) {
          throw new Error('mock provider factory not loaded');
        }
        return this.mockFactory(this.auth.mock ?? {});
      }
      case 'anthropic':
        if (!this.auth.anthropic) {
          throw new Error('Anthropic provider is not configured (set ANTHROPIC_API_KEY)');
        }
        return createAnthropicStream(this.auth.anthropic);
      case 'openai':
        if (!this.auth.openai) {
          throw new Error('OpenAI provider is not configured (set OPENAI_API_KEY)');
        }
        return createOpenAIStream(this.auth.openai);
      case 'google':
        if (!this.auth.google) {
          throw new Error('Google provider is not configured (set GEMINI_API_KEY)');
        }
        return createGoogleStream(this.auth.google);
      case 'openai-compat':
        if (!this.auth['openai-compat']) {
          throw new Error(
            'OpenAI-compatible provider is not configured (set Deqi_OPENAI_COMPAT_BASE_URL and Deqi_OPENAI_COMPAT_API_KEY)',
          );
        }
        return createOpenAICompatStream(this.auth['openai-compat']);
    }
  }
}
