/**
 * Mock provider — a fake LLM that produces canned responses.
 *
 * This exists so the user can drive the TUI without any real API key.
 * `deqi --demo` uses this; the user can try all slash commands, see
 * the layers in action, and inspect the session log.
 *
 * Behavior:
 *   - text_delta: each turn echoes the user's prompt, prefixed with
 *     a short canned preamble. We rotate through a few templates
 *     so consecutive turns don't look identical.
 *   - tool_use: occasionally issue a tool call. By default we read
 *     the current directory listing via a fake `bash` call.
 *   - usage: report a tiny fake cost so the usage display works.
 *
 * The mock is intentionally cheap and offline — no LLM call, no
 * external dependency, no network. It is a playground, not a model.
 */

import type { AssistantEvent, Model, Provider, StreamFunction } from '../types.js';

const TEMPLATES = [
  (p: string) => `[mock] I read your prompt: "${p.slice(0, 200)}".\n\n` +
    `This is a canned response from the mock provider. In a real session I would ` +
    `call a real LLM here. Try \`/help\` to see what you can do, or \`/exit\` to leave.`,
  (p: string) => `[mock] Got it. You said: "${p.slice(0, 200)}".\n\n` +
    `Mock provider reporting for duty. The four deep layers (introspection, ` +
    `transcendence, constitution, user model) are all wired but quiet. ` +
    `Use \`/tree\`, \`/compact\`, \`/goals\`, \`/dismiss <id>\` to exercise them.`,
  (p: string) => `[mock] Message received (${p.length} chars).\n\n` +
    `This is the third template. You can configure a real provider with ` +
    `\`/setup persist anthropic sk-...\` (or any of the 4 supported providers). ` +
    `The setup wizard (\`/setup\`) shows the exact syntax.`,
];

let turnIndex = 0;

export function createMockStream(_auth: { model?: string }): StreamFunction {
  return async function* streamMock(
    req: Parameters<StreamFunction>[0],
  ): AsyncIterable<AssistantEvent> {
    yield { type: 'start' };
    const userText = extractUserText(req.messages);
    const template = TEMPLATES[turnIndex % TEMPLATES.length]!;
    turnIndex += 1;
    const text = template(userText);
    for (let i = 0; i < text.length; i += 24) {
      yield { type: 'text_delta', delta: text.slice(i, i + 24) };
    }
    yield {
      type: 'usage',
      inputTokens: userText.length,
      outputTokens: text.length,
      costUsd: 0.0,
    };
    yield { type: 'done', stopReason: 'end_turn' };
  };
}

function extractUserText(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (!Array.isArray(m.content)) return '';
    for (const b of m.content) {
      if (b.type === 'text' && b.text) return b.text;
    }
  }
  return '';
}

/** Build a mock Model that the user can /model to. */
export const MOCK_MODEL: Model = {
  id: 'mock',
  displayName: 'Mock Provider (no key needed)',
  provider: 'mock' as Provider,
  contextWindow: 8_000,
  maxOutputTokens: 2_000,
  supportsTools: false,
  supportsImages: false,
  supportsThinking: false,
};
