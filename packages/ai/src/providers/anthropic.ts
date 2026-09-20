import type {
  AssistantEvent,
  CompletionRequest,
  StreamFunction,
} from '../types.js';
import { parseSse } from '../sse.js';
import { toAnthropicMessages, toAnthropicTools } from '../convert.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  /** Optional custom headers. */
  headers?: Record<string, string>;
}

export function createAnthropicStream(
  config: AnthropicConfig,
): StreamFunction {
  return async function* streamAnthropic(
    req: CompletionRequest,
  ): AsyncIterable<AssistantEvent> {
    if (!config.apiKey) {
      yield { type: 'error', message: 'Anthropic API key is not configured' };
      return;
    }

    const { messages, system } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: req.model.id,
      max_tokens: req.maxTokens ?? req.model.maxOutputTokens,
      messages,
    };
    if (system) body.system = system;
    if (req.tools && req.tools.length > 0) {
      body.tools = toAnthropicTools(req.tools);
    }
    if (req.temperature !== undefined) {
      body.temperature = req.temperature;
    }
    body.stream = true;

    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': config.apiKey,
          ...(config.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      yield {
        type: 'error',
        message: `Anthropic request failed: ${(err as Error).message}`,
        retryable: true,
      };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield {
        type: 'error',
        message: `Anthropic ${response.status}: ${text.slice(0, 500)}`,
        retryable: response.status >= 500,
      };
      return;
    }

    yield { type: 'start' };

    // Streaming state.
    let currentBlockType: 'text' | 'tool_use' | 'thinking' | null = null;
    let currentToolId: string | null = null;
    let currentToolName: string | null = null;
    let currentToolInput = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error' | 'aborted';
    let stopReason: StopReason = 'end_turn';
    let hadToolUse = false;

    try {
      for await (const sse of parseSse(response, req.signal)) {
        if (!sse.event) continue;
        let payload: any;
        try {
          payload = JSON.parse(sse.data);
        } catch {
          continue;
        }

        switch (sse.event) {
          case 'message_start': {
            const msg = payload.message ?? {};
            const usage = msg.usage ?? {};
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
            cacheRead = usage.cache_read_input_tokens ?? 0;
            cacheWrite = usage.cache_creation_input_tokens ?? 0;
            break;
          }
          case 'content_block_start': {
            const block = payload.content_block ?? {};
            currentBlockType = block.type;
            if (block.type === 'text') {
              // No-op; deltas carry text.
            } else if (block.type === 'tool_use') {
              currentToolId = block.id;
              currentToolName = block.name;
              currentToolInput = '';
              hadToolUse = true;
              yield {
                type: 'toolcall_start',
                id: block.id,
                name: block.name,
              };
            } else if (block.type === 'thinking') {
              currentBlockType = 'thinking';
            }
            break;
          }
          case 'content_block_delta': {
            const delta = payload.delta ?? {};
            if (delta.type === 'text_delta' && currentBlockType === 'text') {
              yield { type: 'text_delta', delta: delta.text };
            } else if (
              delta.type === 'input_json_delta' &&
              currentBlockType === 'tool_use'
            ) {
              currentToolInput += delta.partial_json ?? '';
              yield {
                type: 'toolcall_delta',
                id: currentToolId ?? '',
                inputDelta: delta.partial_json,
              };
            } else if (
              delta.type === 'thinking_delta' &&
              currentBlockType === 'thinking'
            ) {
              yield { type: 'thinking_delta', delta: delta.thinking };
            }
            break;
          }
          case 'content_block_stop': {
            if (currentBlockType === 'tool_use' && currentToolId) {
              let parsedInput: unknown = {};
              try {
                parsedInput = currentToolInput ? JSON.parse(currentToolInput) : {};
              } catch {
                // Keep raw string; tool layer will reject with schema error.
                parsedInput = { __raw: currentToolInput, __error: 'invalid json from model' };
              }
              yield {
                type: 'toolcall_end',
                id: currentToolId,
                name: currentToolName ?? '',
                input: parsedInput,
              };
            }
            currentBlockType = null;
            currentToolId = null;
            currentToolName = null;
            currentToolInput = '';
            break;
          }
          case 'message_delta': {
            if (payload.delta?.stop_reason) {
              stopReason = payload.delta.stop_reason;
            }
            if (payload.usage?.output_tokens !== undefined) {
              outputTokens = payload.usage.output_tokens;
            }
            break;
          }
          case 'message_stop': {
            // Handled below.
            break;
          }
          case 'error': {
            yield { type: 'error', message: payload.message ?? 'Anthropic stream error' };
            return;
          }
        }
      }
    } catch (err) {
      yield { type: 'error', message: `Anthropic stream error: ${(err as Error).message}` };
      return;
    }

    yield {
      type: 'usage',
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead || undefined,
      cacheWriteTokens: cacheWrite || undefined,
    };
    yield {
      type: 'done',
      stopReason: (hadToolUse ? 'tool_use' : stopReason) as StopReason,
    };
  };
}
