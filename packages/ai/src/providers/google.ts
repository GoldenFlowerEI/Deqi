import type {
  AssistantEvent,
  CompletionRequest,
  StreamFunction,
} from '../types.js';
import { parseSse } from '../sse.js';
import { toGoogleContents, toGoogleTools } from '../convert.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

export interface GoogleConfig {
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export function createGoogleStream(config: GoogleConfig): StreamFunction {
  return async function* streamGoogle(
    req: CompletionRequest,
  ): AsyncIterable<AssistantEvent> {
    if (!config.apiKey) {
      yield { type: 'error', message: 'Google API key is not configured' };
      return;
    }

    const systemInstruction = extractSystem(req);
    const contents = toGoogleContents(req.messages);

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = toGoogleTools(req.tools);
    }
    body.generationConfig = {
      maxOutputTokens: req.maxTokens ?? req.model.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(req.model.id)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(config.apiKey)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      yield {
        type: 'error',
        message: `Google request failed: ${(err as Error).message}`,
        retryable: true,
      };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield {
        type: 'error',
        message: `Google ${response.status}: ${text.slice(0, 500)}`,
        retryable: response.status >= 500,
      };
      return;
    }

    yield { type: 'start' };

    // Track tool calls being assembled from streaming functionCall parts.
    const toolInputs = new Map<string, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn';
    let hadToolUse = false;

    try {
      for await (const sse of parseSse(response, req.signal)) {
        let payload: any;
        try {
          payload = JSON.parse(sse.data);
        } catch {
          continue;
        }
        if (payload.error) {
          yield { type: 'error', message: payload.error.message ?? 'Google error' };
          return;
        }

        // Usage metadata can come on any chunk.
        const usage = payload.usageMetadata;
        if (usage) {
          inputTokens = usage.promptTokenCount ?? inputTokens;
          outputTokens = usage.candidatesTokenCount ?? outputTokens;
        }

        const candidate = payload.candidates?.[0];
        if (!candidate) continue;

        if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'max_tokens';
        if (candidate.finishReason === 'STOP') finishReason = 'end_turn';

        const parts: any[] = candidate.content?.parts ?? [];
        for (const part of parts) {
          if (typeof part.text === 'string') {
            yield { type: 'text_delta', delta: part.text };
          } else if (part.functionCall) {
            const id = `google-fc-${toolInputs.size}`;
            const name = part.functionCall.name ?? 'unknown';
            const args = part.functionCall.args ?? {};
            const argsStr = JSON.stringify(args);
            toolInputs.set(id, argsStr);
            yield { type: 'toolcall_start', id, name };
            yield { type: 'toolcall_delta', id, inputDelta: argsStr };
            hadToolUse = true;
          }
        }
      }
    } catch (err) {
      yield { type: 'error', message: `Google stream error: ${(err as Error).message}` };
      return;
    }

    for (const [id, raw] of toolInputs.entries()) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = { __raw: raw, __error: 'invalid json from model' };
      }
      yield { type: 'toolcall_end', id, name: '', input: parsed };
    }

    yield { type: 'usage', inputTokens, outputTokens };
    yield { type: 'done', stopReason: hadToolUse ? 'tool_use' : finishReason };
  };
}

function extractSystem(req: CompletionRequest): string {
  if (req.system) return req.system;
  for (const m of req.messages) {
    if (m.role === 'system') {
      return typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    }
  }
  return '';
}
