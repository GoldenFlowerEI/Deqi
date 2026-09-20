/**
 * v3.7: tool reflection (Hermes-inspired "post-action reflect").
 *
 * After every tool call, before the next LLM call, this function
 * inspects the result and produces a short hint for the model:
 *   - isError  → suggest a fallback tool or "fix the input and retry"
 *   - empty    → suggest widening the query, trying a different tool
 *   - success  → null (no hint; the result speaks for itself)
 *
 * The hint is injected into the next system prompt (via the
 * agent's `lastGuidance` slot) and persisted to the introspection
 * log so future sessions can see "this tool often returns empty
 * for X queries".
 *
 * The reflections are intentionally short and poka-yoke: they
 * should make the model stop and think, not lecture it.
 */

import type { ToolExecutionResult } from '@deqi/agent-core';

export interface ToolReflection {
  /** Short, one-line hint. null if no hint needed. */
  hint: string | null;
  /** Category for the introspection log. */
  kind: 'error' | 'empty' | 'large' | null;
  /** The tool name + a short label for the log. */
  toolName: string;
  /** Whether the tool returned an error. */
  isError: boolean;
}

const EMPTY_PATTERNS: Array<{ tool: string; re: RegExp; hint: string }> = [
  { tool: 'read', re: /^\s*\(\d+ lines total\)\s*$/, hint: 'read returned only the footer — the file may be empty or you may have hit a sandbox limit. Try `bash ls -la <path>` first.' },
  { tool: 'read', re: /^File not found:/, hint: 'the file does not exist. Try `glob` to see what files are nearby, or check the path.' },
  { tool: 'read', re: /^Refusing to read outside cwd:/, hint: 'the path is outside cwd. Use a relative path or move the file.' },
  { tool: 'grep', re: /no matches?/i, hint: 'grep found nothing. Try a wider query (case-insensitive, no extension, or a sub-directory).' },
  { tool: 'glob', re: /^no files?/i, hint: 'glob found nothing. Check the pattern — wildcards are required to match anything.' },
  { tool: 'bash', re: /command not found/i, hint: 'the binary is not on PATH. Try `which <cmd>` or `where <cmd>` to find it.' },
  { tool: 'webFetch', re: /^Refusing non-http/i, hint: 'webFetch only accepts http(s) URLs. Use bash + curl for other protocols.' },
];

const ERROR_PREFIXES: Array<{ re: RegExp; hint: (m: RegExpMatchArray) => string }> = [
  { re: /^Tool "(\w+)" threw:/, hint: () => 'a tool threw an exception. Wrap the call in `try`-like reasoning: re-read the input, check for typos, or try a related tool.' },
  { re: /^stat failed:/, hint: () => 'stat failed — the file may have been deleted or moved. Re-check the path with `glob`.' },
  { re: /^File not found:/, hint: () => 'the file does not exist. Try `glob` to see what files are nearby, or check the path.' },
  { re: /command not found/i, hint: () => 'the binary is not on PATH. Try `which <cmd>` or `where <cmd>` to find it.' },
  { re: /^Refusing to read outside cwd:/, hint: () => 'the path is outside cwd. Use a relative path or move the file.' },
  { re: /^HTTP (\d+)/, hint: (m) => `HTTP ${m[1]} — see the response body for the server-side reason. The browser tool may help you see more context.` },
  { re: /fetch failed/i, hint: () => 'network fetch failed. Check the URL, your connection, and the safe-url allowlist (private IPs are blocked by default).' },
  { re: /timed? ?out/i, hint: () => 'the operation timed out. Increase the timeout, or break the work into smaller steps.' },
];

export function reflectOnTool(
  toolName: string,
  _input: unknown,
  result: ToolExecutionResult,
): ToolReflection {
  // 1. Error path
  if (result.isError) {
    const text = extractText(result);
    for (const { re, hint } of ERROR_PREFIXES) {
      const m = re.exec(text);
      if (m) {
        return { hint: hint(m), kind: 'error', toolName, isError: true };
      }
    }
    // Generic error
    return {
      hint: 'the tool returned an error. Read the error message, then either fix the input or try a different tool.',
      kind: 'error',
      toolName,
      isError: true,
    };
  }

  // 2. Empty result
  const text = extractText(result);
  const stripped = text.trim();
  for (const { tool, re, hint } of EMPTY_PATTERNS) {
    if (tool === toolName && re.test(stripped)) {
      return { hint, kind: 'empty', toolName, isError: false };
    }
  }

  // 3. Large result hint (>10KB might be too much for the LLM)
  if (text.length > 10_000) {
    return {
      hint: 'the result is large (>10KB). Consider using offset/limit to read a smaller slice, or run a grep to narrow the scope first.',
      kind: 'large',
      toolName,
      isError: false,
    };
  }

  // 4. No reflection needed
  return { hint: null, kind: null, toolName, isError: false };
}

function extractText(result: ToolExecutionResult): string {
  let out = '';
  for (const block of result.content) {
    const b = block as { type: string; text?: string };
    if (b.type === 'text' && typeof b.text === 'string') out += b.text;
  }
  return out;
}
