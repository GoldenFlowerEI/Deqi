import type {
  ContentBlock,
  Message,
  ToolDefinition,
} from './types.js';

/**
 * Convert our unified Message[] into each provider's wire format.
 * These functions are pure and side-effect-free.
 */

// --- Anthropic ------------------------------------------------------------

export function toAnthropicMessages(
  messages: Message[],
): { messages: unknown[]; system?: unknown } {
  const systemBlocks: Array<{ type: 'text'; text: string; cache_control?: unknown }> = [];
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      // Anthropic uses a top-level system field, not a system message.
      const text = typeof m.content === 'string' ? m.content : m.content.map(blockToText).join('');
      systemBlocks.push({ type: 'text', text });
      continue;
    }
    if (m.role === 'tool') {
      // Tool result: in Anthropic, this is a user message containing tool_result blocks.
      const blocks = Array.isArray(m.content) ? m.content : [];
      const toolResults: unknown[] = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content.map((c) => ({ type: 'text', text: c.text })),
            is_error: b.isError,
          });
        }
      }
      out.push({ role: 'user', content: toolResults });
      continue;
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
      } else {
        out.push({ role: 'user', content: m.content.map(toAnthropicBlock) });
      }
      continue;
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        out.push({ role: 'assistant', content: m.content });
      } else {
        out.push({ role: 'assistant', content: m.content.map(toAnthropicBlock) });
      }
      continue;
    }
  }
  const result: { messages: unknown[]; system?: unknown } = { messages: out };
  if (systemBlocks.length > 0) result.system = systemBlocks;
  return result;
}

function toAnthropicBlock(b: ContentBlock): unknown {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'image':
      if (b.source.kind === 'base64') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: b.source.mediaType,
            data: b.source.data,
          },
        };
      }
      return {
        type: 'image',
        source: { type: 'url', url: b.source.url },
      };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: b.content.map((c) => ({ type: 'text', text: c.text })),
        is_error: b.isError,
      };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: b.thinking,
        ...(b.signature ? { signature: b.signature } : {}),
      };
  }
}

export function toAnthropicTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

function blockToText(b: ContentBlock): string {
  if (b.type === 'text') return b.text;
  if (b.type === 'thinking') return `[thinking] ${b.thinking}`;
  return '';
}

// --- OpenAI ---------------------------------------------------------------

export function toOpenAIMessages(
  messages: Message[],
  systemPrompt?: string,
): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : m.content.map(blockToText).join('');
      out.push({ role: 'system', content: text });
      continue;
    }
    if (m.role === 'tool') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.toolUseId,
            content: b.content.map((c) => c.text).join(''),
          });
        }
      }
      continue;
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string') {
        out.push({ role: 'assistant', content: m.content });
        continue;
      }
      // Collect text + tool_calls.
      let text = '';
      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments: JSON.stringify(b.input ?? {}),
            },
          });
        }
        // thinking and image are best-effort: include in text as notes.
        else if (b.type === 'thinking') {
          text += `\n[thinking] ${b.thinking}`;
        } else if (b.type === 'image') {
          text += `\n[image omitted]`;
        }
      }
      const msg: Record<string, unknown> = { role: 'assistant' };
      if (text) msg.content = text;
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;
      if (Object.keys(msg).length > 1) out.push(msg);
      else if (text) out.push({ role: 'assistant', content: text });
      continue;
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
      } else {
        // OpenAI doesn't have content blocks; flatten text + images.
        const textParts: string[] = [];
        const imageParts: Array<{
          type: 'image_url';
          image_url: { url: string };
        }> = [];
        for (const b of m.content) {
          if (b.type === 'text') textParts.push(b.text);
          else if (b.type === 'image') {
            if (b.source.kind === 'url') {
              imageParts.push({
                type: 'image_url',
                image_url: { url: b.source.url },
              });
            } else {
              imageParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${b.source.mediaType};base64,${b.source.data}`,
                },
              });
            }
          }
        }
        if (imageParts.length > 0) {
          out.push({
            role: 'user',
            content: [
              ...(textParts.length > 0 ? [{ type: 'text', text: textParts.join('') }] : []),
              ...imageParts,
            ],
          });
        } else {
          out.push({ role: 'user', content: textParts.join('') });
        }
      }
    }
  }
  return out;
}

export function toOpenAITools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

// --- Google ---------------------------------------------------------------

export function toGoogleContents(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // handled separately in systemInstruction
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') {
      out.push({ role, parts: [{ text: m.content }] });
      continue;
    }
    const parts: unknown[] = [];
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image' && b.source.kind === 'base64') {
        parts.push({
          inline_data: { mime_type: b.source.mediaType, data: b.source.data },
        });
      } else if (b.type === 'image' && b.source.kind === 'url') {
        parts.push({ file_data: { file_uri: b.source.url } });
      } else if (b.type === 'tool_use') {
        parts.push({
          functionCall: { name: b.name, args: b.input ?? {} },
        });
      } else if (b.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: b.toolUseId,
            response: {
              content: b.content.map((c) => c.text).join(''),
              is_error: b.isError === true,
            },
          },
        });
      }
    }
    out.push({ role, parts });
  }
  return out;
}

export function toGoogleTools(tools: ToolDefinition[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}
