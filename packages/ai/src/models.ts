import type { Model, Provider } from './types.js';

/**
 * Curated registry of well-known models.
 * Users can add custom models via the `models.json` config or the registry API.
 *
 * Prices reflect 2026-08 listings and may be stale; users can override.
 */
export const KNOWN_MODELS: Model[] = [
  // Anthropic -------------------------------------------------------------
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'claude-opus-4-1',
    displayName: 'Claude Opus 4.1',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: false,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },

  // OpenAI ---------------------------------------------------------------
  {
    id: 'gpt-5',
    displayName: 'GPT-5',
    provider: 'openai',
    contextWindow: 400_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    cost: { input: 1.25, output: 10 },
  },
  {
    id: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    provider: 'openai',
    contextWindow: 400_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    cost: { input: 0.25, output: 2 },
  },
  {
    id: 'o4-mini',
    displayName: 'o4-mini',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    cost: { input: 1.1, output: 4.4 },
  },

  // Google ---------------------------------------------------------------
  {
    id: 'gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    cost: { input: 1.25, output: 10 },
  },
  {
    id: 'gemini-2.5-flash',
    displayName: 'Gemini 2.5 Flash',
    provider: 'google',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    cost: { input: 0.3, output: 2.5 },
  },

  // OpenAI-compatible (DeepSeek, Kimi, Qwen, etc.) -----------------------
  {
    id: 'deepseek-chat',
    displayName: 'DeepSeek V3 Chat (OpenAI-compat)',
    provider: 'openai-compat',
    contextWindow: 64_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    cost: { input: 0.14, output: 0.28 },
  },
  {
    id: 'kimi-k2',
    displayName: 'Kimi K2 (OpenAI-compat)',
    provider: 'openai-compat',
    contextWindow: 128_000,
    maxOutputTokens: 8_000,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: false,
    cost: { input: 0.6, output: 2.5 },
  },
  {
    id: 'MiniMax-M3',
    displayName: 'MiniMax M3 (OpenAI-compat)',
    provider: 'openai-compat',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: true,
    cost: { input: 0, output: 0 },
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    displayName: 'MiniMax M2.7 highspeed (OpenAI-compat)',
    provider: 'openai-compat',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    supportsTools: true,
    supportsImages: false,
    supportsThinking: true,
    cost: { input: 0, output: 0 },
  },
];

/** Default model selected when no preference is set. */
export const DEFAULT_MODEL_ID = 'claude-sonnet-4-5';

export function getModel(id: string): Model | undefined {
  // Exact match first.
  const exact = KNOWN_MODELS.find((m) => m.id === id);
  if (exact) return exact;
  // Then try "<provider>/<id>".
  const slash = id.indexOf('/');
  if (slash > 0) {
    const sub = id.slice(slash + 1);
    return KNOWN_MODELS.find((m) => m.id === sub);
  }
  return undefined;
}

export function modelsByProvider(provider: Provider): Model[] {
  return KNOWN_MODELS.filter((m) => m.provider === provider);
}
