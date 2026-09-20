/**
 * Minimal SSE (Server-Sent Events) parser.
 *
 * Returns an async iterable of {event, data} pairs.
 * Lines are separated by a blank line. The trailing blank line terminates
 * an event, not a record. We accumulate fields until that terminator.
 */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export async function* parseSse(
  response: Response,
  signal?: AbortSignal,
): AsyncIterable<SseEvent> {
  if (!response.body) {
    throw new Error('SSE response has no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let eventName: string | undefined;
  let dataLines: string[] = [];
  let id: string | undefined;

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0 && eventName === undefined && id === undefined) {
      return null;
    }
    const ev: SseEvent = { data: dataLines.join('\n') };
    if (eventName) ev.event = eventName;
    if (id) ev.id = id;
    eventName = undefined;
    dataLines = [];
    id = undefined;
    return ev;
  };

  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {}
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const lines = block.split('\n');
        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r')
            ? rawLine.slice(0, -1)
            : rawLine;
          if (line.length === 0) continue;
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const field = line.slice(0, colon);
          const value = line.slice(colon + 1).replace(/^ /, '');
          switch (field) {
            case 'event':
              eventName = value;
              break;
            case 'data':
              dataLines.push(value);
              break;
            case 'id':
              id = value;
              break;
            // ignore other fields (retry, comments)
          }
        }

        const ev = flush();
        if (ev) yield ev;
      }
    }
    // Final flush for any trailing data without terminator.
    const ev = flush();
    if (ev) yield ev;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}
