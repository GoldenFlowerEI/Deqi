import type {
  AssistantEvent,
  CompletionRequest,
  StreamFunction,
} from '../types.js';
import { parseSse } from '../sse.js';
import { toOpenAIMessages, toOpenAITools } from '../convert.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';

export interface OpenAIConfig {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export function createOpenAIStream(config: OpenAIConfig): StreamFunction {
  return async function* streamOpenAI(
    req: CompletionRequest,
  ): AsyncIterable<AssistantEvent> {
    if (!config.apiKey) {
      yield { type: 'error', message: 'OpenAI API key is not configured' };
      return;
    }

    const systemPrompt = extractSystem(req.messages, req.system);
    const messages = toOpenAIMessages(req.messages, systemPrompt);

    const body: Record<string, unknown> = {
      model: req.model.id,
      messages,
      max_tokens: req.maxTokens ?? req.model.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = toOpenAITools(req.tools);
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }

    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          ...(config.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      yield {
        type: 'error',
        message: `OpenAI request failed: ${(err as Error).message}`,
        retryable: true,
      };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield {
        type: 'error',
        message: `OpenAI ${response.status}: ${text.slice(0, 500)}`,
        retryable: response.status >= 500,
      };
      return;
    }

    yield { type: 'start' };

    // Track per-tool-call input being accumulated.
    const toolInputs = new Map<string, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';
    let hadToolUse = false;

    try {
      for await (const sse of parseSse(response, req.signal)) {
        if (sse.data === '[DONE]') break;
        let payload: any;
        try {
          payload = JSON.parse(sse.data);
        } catch {
          continue;
        }

        // Usage (only on final chunk when stream_options.include_usage=true).
        if (payload.usage) {
          inputTokens = payload.usage.prompt_tokens ?? inputTokens;
          outputTokens = payload.usage.completion_tokens ?? outputTokens;
        }

        const choice = payload.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta ?? {};
        if (delta.content) {
          yield { type: 'text_delta', delta: delta.content };
        }
        if (delta.reasoning_content) {
          yield { type: 'thinking_delta', delta: delta.reasoning_content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const id = tc.id ?? toolInputs.keys().next().value ?? '';
            if (tc.id) {
              // New tool call announced.
              if (tc.function?.name) {
                yield {
                  type: 'toolcall_start',
                  id,
                  name: tc.function.name,
                };
                hadToolUse = true;
              }
              toolInputs.set(id, tc.function?.arguments ?? '');
            } else if (tc.function?.arguments) {
              const current = toolInputs.get(id) ?? '';
              toolInputs.set(id, current + tc.function.arguments);
              yield {
                type: 'toolcall_delta',
                id,
                inputDelta: tc.function.arguments,
              };
            }
          }
        }
      }
    } catch (err) {
      yield { type: 'error', message: `OpenAI stream error: ${(err as Error).message}` };
      return;
    }

    // Emit toolcall_end for each accumulated tool call.
    for (const [id, rawInput] of toolInputs.entries()) {
      let parsed: unknown = {};
      try {
        parsed = rawInput ? JSON.parse(rawInput) : {};
      } catch {
        parsed = { __raw: rawInput, __error: 'invalid json from model' };
      }
      // We need the name; we only have the arguments. Name was yielded earlier
      // via toolcall_start; here we re-emit with name unknown if we lost it.
      yield {
        type: 'toolcall_end',
        id,
        name: '', // Resolved by AgentCore from the matching toolcall_start.
        input: parsed,
      };
    }

    yield { type: 'usage', inputTokens, outputTokens };
    yield {
      type: 'done',
      stopReason: hadToolUse
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : finishReason === 'stop'
            ? 'end_turn'
            : 'end_turn',
    };
  };
}

function extractSystem(
  messages: import('../types.js').Message[],
  passedSystem?: string,
): string {
  if (passedSystem) return passedSystem;
  for (const m of messages) {
    if (m.role === 'system') {
      return typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    }
  }
  return '';
}
