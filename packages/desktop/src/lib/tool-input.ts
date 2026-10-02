/**
 * tool-input.ts — making a tool call readable.
 *
 * The tool block used to render `JSON.stringify(input, null, 2)` in
 * full, always. Three things went wrong with that at once:
 *
 *   - a `write` of a 400-line file pushed every other message off
 *     screen, to show the file the user had just asked for;
 *   - the one field anyone actually wants — the path, the command —
 *     was buried at an unpredictable depth in the JSON;
 *   - it was not collapsible, so there was no way to get it back
 *     without scrolling.
 *
 * This produces a one-line summary plus a bounded preview, and lets
 * the component show the raw JSON behind a disclosure. The full input
 * is never lost — it is one click away.
 */

/** Longest summary line before it is elided. */
const SUMMARY_MAX = 160;
/** How much of a long value to show in the preview. */
const VALUE_PREVIEW = 400;

export interface ToolInputSummary {
  /** One line: the part of the input that identifies the call. */
  summary: string;
  /** The raw input, kept so the disclosure can show all of it. */
  raw: unknown;
  /** A bounded, human-readable dump for the collapsed preview. */
  preview: string;
  /** True when the preview is shorter than the real thing. */
  truncated: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clip(s: string, max: number): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  return { text: `${s.slice(0, max)}…`, clipped: true };
}

/**
 * Pick the field that names the call, per tool.
 *
 * A fixed map rather than a heuristic: "the longest string" or "the
 * first string key" both pick the wrong field often enough to be
 * worse than an explicit list, and the list is three lines long.
 */
const KEY_FIELD: Record<string, string> = {
  bash: 'command',
  read: 'path',
  write: 'path',
  edit: 'path',
  glob: 'pattern',
  grep: 'pattern',
  webFetch: 'url',
  browser: 'url',
  mcp: 'server',
  subagent: 'prompt',
  delegate_remote: 'target',
  recipe_run: 'recipe',
  eval: 'name',
  session_history: 'query',
};

/** Fields whose value is bulk text, not an identifier. */
const BULK_FIELD = new Set(['content', 'new_string', 'old_string', 'replacement', 'text', 'prompt']);

export function summarizeToolInput(toolName: string, input: unknown): ToolInputSummary {
  const raw = input;

  if (!isRecord(input)) {
    const text = input === undefined ? '' : JSON.stringify(input) ?? String(input);
    const c = clip(text, VALUE_PREVIEW);
    return { summary: c.text, raw, preview: c.text, truncated: c.clipped };
  }

  const key = KEY_FIELD[toolName];
  const summarySource = key && typeof input[key] === 'string' ? (input[key] as string) : null;

  // The preview is the whole input, minus any field that is bulk text —
  // which is exactly the field that was flooding the screen. A file
  // body belongs in the editor or the diff, not in a chat bubble.
  const previewObj: Record<string, unknown> = {};
  let droppedBulk = false;
  for (const [k, v] of Object.entries(input)) {
    if (BULK_FIELD.has(k) && typeof v === 'string' && v.length > 80) {
      previewObj[k] = `${v.slice(0, 80)}… (${v.length} chars)`;
      droppedBulk = true;
    } else {
      previewObj[k] = v;
    }
  }
  let preview = JSON.stringify(previewObj, null, 2) ?? '';
  let truncated = false;
  if (preview.length > VALUE_PREVIEW) {
    preview = `${preview.slice(0, VALUE_PREVIEW)}\n… (${preview.length} chars total)`;
    truncated = true;
  }

  const summary = summarySource
    ? clip(summarySource, SUMMARY_MAX).text
    // No known key for this tool: fall back to the first scalar, which
    // is almost always the argument the user recognises.
    : clip(
      (Object.entries(input).find(([, v]) => typeof v === 'string' || typeof v === 'number')?.[1] ?? '').toString(),
      SUMMARY_MAX,
    ).text;

  return {
    summary: summary || (Object.keys(input).length ? `${Object.keys(input).length} argument(s)` : 'no arguments'),
    raw,
    preview,
    truncated: truncated || droppedBulk,
  };
}
