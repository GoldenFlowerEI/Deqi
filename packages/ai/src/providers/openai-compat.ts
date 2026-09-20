/**
 * OpenAI-compatible provider.
 *
 * Many vendors (DeepSeek, Kimi/Moonshot, Qwen, OpenRouter, custom gateways,
 * llama.cpp's OpenAI shim) speak the OpenAI Chat Completions API. This module
 * reuses the OpenAI request/response conversion but with a configurable
 * base URL and key.
 */

import type {
  AssistantEvent,
  CompletionRequest,
  StreamFunction,
} from '../types.js';
import { parseSse } from '../sse.js';
import { toOpenAIMessages, toOpenAITools } from '../convert.js';

export interface OpenAICompatConfig {
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** Optional path appended to baseUrl; default "/v1/chat/completions". */
  path?: string;
}

export function createOpenAICompatStream(
  config: OpenAICompatConfig,
): StreamFunction {
  return async function* stream(req: CompletionRequest): AsyncIterable<AssistantEvent> {
    if (!config.apiKey) {
      yield { type: 'error', message: 'OpenAI-compatible API key is not configured' };
      return;
    }
    if (!config.baseUrl) {
      yield { type: 'error', message: 'OpenAI-compatible baseUrl is not configured' };
      return;
    }

    const systemPrompt = extractSystem(req);
    const messages = toOpenAIMessages(req.messages, systemPrompt);
    const body: Record<string, unknown> = {
      model: req.model.id,
      messages,
      max_tokens: req.maxTokens ?? req.model.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    // v1.1.1: MiniMax-family models support `reasoning_split: true`,
    // which routes the internal <think>…</think> block into a separate
    // `reasoning_content` field (already handled at line 115 below).
    // For other OpenAI-compatible providers the field is silently
    // ignored, so it's safe to send unconditionally.
    body.reasoning_split = true;
    if (req.tools && req.tools.length > 0) {
      body.tools = toOpenAITools(req.tools);
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const path = config.path ?? '/v1/chat/completions';
    const url = `${baseUrl}${path.startsWith('/') ? path : '/' + path}`;

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
      const cause = (err as Error).cause as { code?: string } | undefined;
      const where = cause?.code ? ` (${cause.code})` : '';
      yield {
        type: 'error',
        // v1.1.2: don't echo the raw fetch failure text. Common cases are
        // "fetch failed" / `TypeError: fetch failed` from undici with
        // an empty cause — useless to the user. Surface the cause code
        // (ECONNREFUSED / ENOTFOUND / ETIMEDOUT / EAI_AGAIN) so the
        // TUI can show "no network" vs "DNS failed" vs "endpoint
        // unreachable" instead of one opaque line.
        message: `OpenAI-compat network error${where}: cannot reach ${baseUrl}`,
        retryable: true,
      };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryAfterSec = Number(response.headers.get('retry-after') ?? '0');
      const retryable = response.status === 429 || response.status >= 500;
      yield {
        type: 'error',
        // v1.1.2: try to extract a human-readable message from the JSON
        // body; fall back to a clean `{status} {statusText}` summary.
        // Never dump the raw body — for many providers it is mojibake
        // (UTF-8 read as GBK) and clutters the TUI.
        message: formatHttpError(response.status, response.statusText, text),
        retryable,
        retryAfterMs: retryAfterSec > 0 ? retryAfterSec * 1000 : undefined,
      };
      return;
    }

    yield { type: 'start' };

    // v1.1.5: tool-call buffer. Each entry is { name, args }.
    // `name` may be empty until a later chunk supplies it; we only
    // emit toolcall_start once `name` is known. `args` accumulates
    // until the stream ends.
    const toolInputs = new Map<string, { name: string; args: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason = 'stop';
    let hadToolUse = false;
    // v1.1.2: the MiniMax openai-compat endpoint supports `reasoning_split`,
    // which routes <think>…</think> into `reasoning_content`. If the
    // server ignores the flag (or another openai-compat provider is
    // used), the model embeds the thinking block inline in `content`.
    // We split inline thinking into its own thinking_delta stream so
    // the TUI can render it separately and never dump the model's
    // internal monologue as user-visible text.
    const splitter = new InlineThinkingSplitter();

    try {
      for await (const sse of parseSse(response, req.signal)) {
        if (sse.data === '[DONE]') break;
        let payload: any;
        try {
          payload = JSON.parse(sse.data);
        } catch {
          continue;
        }
        if (payload.usage) {
          inputTokens = payload.usage.prompt_tokens ?? inputTokens;
          outputTokens = payload.usage.completion_tokens ?? outputTokens;
        }
        const choice = payload.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta ?? {};
        if (delta.content) {
          for (const ev of splitter.feed(delta.content)) yield ev;
        }
        if (delta.reasoning_content) {
          for (const ev of splitter.feedReasoning(delta.reasoning_content)) yield ev;
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            // v1.1.5: tool-call chunk merging for the openai-compat
            // stream. The MiniMax M-series sometimes fragments a
            // single tool call across chunks in a way the previous
            // parser mishandled:
            //   - First chunk: id + name + args-start
            //   - Continuation: only `index` (and args delta)
            //   - Or: name arrives in a later chunk
            //   - Or: arguments are interleaved with name updates
            //
            // We track (id, name, args) per call. The trick is that
            // a single call can be addressed by EITHER `id` (first
            // chunk) OR `index` (continuation). We index by both:
            //   - `id` is the canonical key in toolInputs
            //   - `idx-${index}` is a side-channel that maps back to
            //     the same entry
            //
            // When a continuation chunk arrives with only `index`,
            // we look up the entry via the index side-channel.
            const tcId = tc.id ?? '';
            const tcIndexKey = tc.index !== undefined ? `idx-${tc.index}` : '';
            const tcName = tc.function?.name ?? '';
            const tcArgs = tc.function?.arguments;
            let entryId = tcId || tcIndexKey;
            let entry = entryId ? toolInputs.get(entryId) : undefined;
            if (entryId && !entry) {
              // First chunk for this call. Create the entry.
              // Index it by both `id` and `idx-${index}` if either
              // is provided, so a continuation chunk that uses
              // the OTHER key can still find it.
              entry = { name: '', args: '' };
              toolInputs.set(entryId, entry);
              const otherKey = tcId ? tcIndexKey : (tcId || '');
              if (otherKey && otherKey !== entryId) {
                toolInputs.set(otherKey, entry);
              }
            }
            if (!entry) {
              // No id AND no index. Some chunks truly have neither
              // (rare; mostly defensive). Fall back to the most
              // recent in-flight entry — it's almost always the
              // one being continued.
              let lastKey: string | null = null;
              for (const k of toolInputs.keys()) lastKey = k;
              if (lastKey) {
                entry = toolInputs.get(lastKey)!;
                entryId = lastKey;
              }
            }
            if (!entry) continue;
            if (tcName && !entry.name) {
              entry.name = tcName;
              yield { type: 'toolcall_start', id: entryId, name: tcName };
              hadToolUse = true;
            }
            if (tcArgs) {
              entry.args += tcArgs;
              yield { type: 'toolcall_delta', id: entryId, inputDelta: tcArgs };
            }
          }
        }
      }
    } catch (err) {
      yield { type: 'error', message: `OpenAI-compat stream error: ${(err as Error).message}` };
      return;
    }

    // v1.1.5: dedupe entries. The id↔idx-N side-channel means an
    // entry can be reached under two keys; we only want one
    // toolcall_end per actual call. We use the canonical id (the
    // `id` field if we have it, else `idx-N`) for the end event so
    // it matches the start event the agent saw.
    const emitted = new Set<{ name: string; args: string }>();
    for (const [key, entry] of toolInputs) {
      if (emitted.has(entry)) continue;
      emitted.add(entry);
      let parsed: unknown = {};
      try {
        parsed = entry.args ? JSON.parse(entry.args) : {};
      } catch {
        parsed = { __raw: entry.args, __error: 'invalid json from model' };
      }
      // Prefer the real `id` over `idx-N` for matching with start.
      // The side-channel is `idx-N` only when the API never sent `id`.
      const canonicalId = key.startsWith('idx-') ? '' : key;
      yield { type: 'toolcall_end', id: canonicalId, name: entry.name, input: parsed };
    }

    // v1.1.2: flush any tail the splitter was holding.
    for (const ev of splitter.flush()) yield ev;

    yield { type: 'usage', inputTokens, outputTokens };
    yield {
      type: 'done',
      stopReason: hadToolUse
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : 'end_turn',
    };
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

/**
 * Splits a stream of `content` chunks into text_delta / thinking_delta
 * events. The MiniMax openai-compat endpoint puts <think>...</think>
 * inline in `content` when the `reasoning_split: true` flag is ignored
 * (older revisions, some proxies). The MiniMax M-series also writes a
 * `[thinking] ...` prefix at the start of some assistant turns when it
 * has to reason aloud. This class hides both shapes from the TUI by
 * routing them through the same thinking_delta channel that proper
 * reasoning_content uses.
 */
export class InlineThinkingSplitter {
  private buf = '';
  private inThink = false;
  private inBracket = false;
  private tailPending = '';
  /** Position of the most recent `[thinking]` or `<think>` opener in
   *  the current chunk. Used to re-find the start of an unclosed
   *  thinking block at chunk boundaries. Reset on every `feed()`. */
  private lastOpenPos = -1;

  *feed(chunk: string): IterableIterator<AssistantEvent> {
    // Concatenate with any leftover tail from a previous chunk so
    // markers that span chunk boundaries still match. We have two
    // buffers: `tailPending` for the tail of plain-text mode (held
    // back so a partial opener isn't emitted prematurely) and `buf`
    // for unclosed thinking content (we're inside a `<think>` or
    // `[thinking]` block waiting for the closer). Concatenate both.
    const text = (this.tailPending || this.buf) + chunk;
    this.tailPending = '';
    this.buf = '';
    this.lastOpenPos = -1;
    // v1.1.2: track whether THIS iteration of the while loop is the
    // one that just opened a thinking block. If so, the in-bracket
    // flush path needs to buffer from the post-opener position
    // (i), not from a safeEnd that may lie before i.
    let enteredThisIter = false;
    let i = 0;
    let outStart = 0;
    while (i < text.length) {
      if (!this.inThink && !this.inBracket) {
        // Look for the next opening marker. Shortest-first so the
        // rarer / more specific shape doesn't get swallowed by <think>.
        const nextThink = text.indexOf('<think>', i);
        const nextOpenBracket = text.indexOf('[thinking]', i);
        let next = -1;
        let openKind: 'think' | 'bracket' | null = null;
        if (nextThink !== -1 && (nextOpenBracket === -1 || nextThink < nextOpenBracket)) {
          next = nextThink;
          openKind = 'think';
        } else if (nextOpenBracket !== -1) {
          next = nextOpenBracket;
          openKind = 'bracket';
        }
        if (next === -1) {
          // No more markers. Emit everything up to the last 8 chars
          // (longest marker start) as text and hold the rest.
          const safeEnd = Math.max(outStart, text.length - 8);
          if (safeEnd > outStart) {
            yield { type: 'text_delta', delta: text.slice(outStart, safeEnd) };
          }
          this.tailPending = text.slice(safeEnd);
          return;
        }
        if (next > outStart) {
          yield { type: 'text_delta', delta: text.slice(outStart, next) };
        }
        if (openKind === 'think') {
          this.inThink = true;
          this.lastOpenPos = next;
          i = next + '<think>'.length;
        } else {
          this.inBracket = true;
          this.lastOpenPos = next;
          i = next + '[thinking]'.length;
        }
        outStart = i;
        enteredThisIter = true;
        // Don't continue — the rest of the chunk is thinking
        // content. Let the next iteration of the while loop hit
        // the in-bracket path which will look for the closer
        // (potentially in this same chunk) or buffer the rest.
        continue;
        outStart = i;
        continue;
      }
      // We're inside a thinking block. Look for the matching close.
      // v1.1.2: accept either closer regardless of opener, because
      // the model occasionally opens with `[thinking]` and closes
      // with `</think>` (or vice versa).
      const thinkClose = text.indexOf('</think>', i);
      const bracketClose = text.indexOf('[/thinking]', i);
      let closeIdx = -1;
      let closer = '';
      if (thinkClose !== -1 && (bracketClose === -1 || thinkClose < bracketClose)) {
        closeIdx = thinkClose;
        closer = '</think>';
      } else if (bracketClose !== -1) {
        closeIdx = bracketClose;
        closer = '[/thinking]';
      }
      if (closeIdx === -1) {
        // No closer in this chunk. If we just entered the thinking
        // block in THIS iteration, buffer the whole rest from i
        // (the post-opener position). Otherwise, use the safety
        // holdback so a partial closer at the very end isn't
        // emitted as thinking content.
        if (enteredThisIter) {
          this.buf = text.slice(i);
        } else {
          const safeEnd = Math.max(i, text.length - 10);
          if (safeEnd > i) {
            yield { type: 'thinking_delta', delta: text.slice(i, safeEnd) };
          }
          this.buf = text.slice(safeEnd);
        }
        return;
      }
      // Note: if we just entered a thinking block (inThink/inBracket
      // became true this iteration) and the closer happens to be
      // in the SAME chunk, the loop falls through here and we
      // process it correctly. If it's not in this chunk, the loop
      // ends with us in {inThink|inBracket} mode and `i` advanced
      // past the opener; we then need to handle the remaining
      // text below (the post-loop block).
      if (closeIdx > i) {
        yield { type: 'thinking_delta', delta: text.slice(i, closeIdx) };
      }
      this.inThink = false;
      this.inBracket = false;
      i = closeIdx + closer.length;
      outStart = i;
    }
    // v1.1.2: emit any remaining plain text (only if we're NOT in a
    // thinking block — if we just entered one, the in-bracket path
    // already handled the tail or it's buffered).
    if (outStart < text.length && !this.inThink && !this.inBracket) {
      yield { type: 'text_delta', delta: text.slice(outStart) };
    }
  }

  *feedReasoning(reasoning: string): IterableIterator<AssistantEvent> {
    // Provider gave us a real `reasoning_content` field; just pass it
    // through. This is the preferred path (reasoning_split: true).
    if (reasoning) yield { type: 'thinking_delta', delta: reasoning };
  }

  /**
   * Call once after the stream ends so any buffered tail gets emitted
   * as text (in case the model never closed a <think> block).
   */
  *flush(): IterableIterator<AssistantEvent> {
    if (this.buf || this.tailPending) {
      yield {
        type: 'text_delta',
        delta: this.buf + this.tailPending,
      };
      this.buf = '';
      this.tailPending = '';
    }
  }
}

/**
 * Best-effort extraction of a human message from an OpenAI-style error body.
 *
 * The body is usually a JSON object like
 *   `{ "type": "error", "error": { "type": "rate_limit_error",
 *     "message": "...", "http_code": "429" } }`
 * but providers vary (some return plain text, some nest the message deeper,
 * some include mojibake on the wire). We try the common shapes and return
 * a short, single-line summary.
 */
function formatHttpError(status: number, statusText: string, body: string): string {
  let detail = '';
  const head = body.slice(0, 2000);
  try {
    const j = JSON.parse(head) as Record<string, unknown>;
    const err = (j as { error?: { message?: string; type?: string } }).error;
    if (err && typeof err === 'object' && typeof err.message === 'string') {
      detail = err.message.slice(0, 300);
    } else if (typeof (j as { message?: string }).message === 'string') {
      detail = ((j as { message: string }).message).slice(0, 300);
    } else if (typeof j === 'string') {
      detail = (j as unknown as string).slice(0, 300);
    }
  } catch {
    // Not JSON. Use the raw body, but strip newlines and clamp.
    detail = head.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  }
  if (!detail) return `OpenAI-compat ${status} ${statusText}`;
  return `OpenAI-compat ${status}: ${detail}`;
}
