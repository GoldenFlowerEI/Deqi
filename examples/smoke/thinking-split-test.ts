/**
 * v1.1.2 smoke test: inline thinking splitter for openai-compat.
 *
 * The MiniMax M-series models emit their reasoning in three forms
 * depending on the endpoint and flag negotiation:
 *   1. `reasoning_content` field (clean — already handled)
 *   2. `<think>...</think>` inline in `content` (older revisions,
 *      some proxies ignore `reasoning_split: true`)
 *   3. `[thinking] ...` prefix at the start of an assistant turn
 *      (the model "thinking aloud" when it has to reason)
 *
 * The TUI's text_delta is the user-visible channel. The thinking
 * needs to go to thinking_delta so it doesn't pollute the response.
 * This test drives InlineThinkingSplitter directly.
 */

import { InlineThinkingSplitter } from '@deqi/ai';
import type { AssistantEvent } from '@deqi/ai';

function ok(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? '\x1b[32mok\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

function runSplitter(chunks: string[]): AssistantEvent[] {
  const s = new InlineThinkingSplitter();
  const events: AssistantEvent[] = [];
  for (const c of chunks) {
    for (const ev of s.feed(c)) events.push(ev);
  }
  for (const ev of s.flush()) events.push(ev);
  return events;
}

function textOf(events: AssistantEvent[]): string {
  return events
    .filter((e) => e.type === 'text_delta')
    .map((e) => (e as { delta: string }).delta)
    .join('');
}

function thinkOf(events: AssistantEvent[]): string {
  return events
    .filter((e) => e.type === 'thinking_delta')
    .map((e) => (e as { delta: string }).delta)
    .join('');
}

async function main(): Promise<void> {
  // -- Test 1: pure text — no markers.
  {
    const events = runSplitter(['Hello world']);
    ok('pure text produces only text_delta', events.every((e) => e.type === 'text_delta'));
    ok('pure text content matches', textOf(events) === 'Hello world');
    ok('pure text produces no thinking', thinkOf(events) === '');
  }

  // -- Test 2: <think>...</think> inline.
  {
    const events = runSplitter(['Pre<think>hidden</think>Post']);
    ok('inline <think> is recognized', thinkOf(events) === 'hidden');
    ok('text before think preserved', textOf(events) === 'PrePost');
  }

  // -- Test 3: [thinking]...[/thinking] bracket.
  {
    const events = runSplitter(['Pre[thinking]secret[/thinking]Post']);
    ok('bracket [thinking] is recognized', thinkOf(events) === 'secret');
    ok('text around bracket preserved', textOf(events) === 'PrePost');
  }

  // -- Test 4: marker split across chunks.
  {
    const events = runSplitter(['Pre<th', 'ink>hidden</think>Post']);
    ok('cross-chunk <think> recognized', thinkOf(events) === 'hidden');
    ok('cross-chunk text reassembled', textOf(events) === 'PrePost');
  }

  // -- Test 5: model "thinks aloud" with [thinking] and never closes.
  // (Flush at end must drain the buffer as text so the user sees the
  // content; better to show "I am reasoning" as text than lose it.)
  {
    const events = runSplitter(['[thinking] I am reasoning about the question.']);
    // Without a closer, the splitter buffers and flush() returns it
    // as text — so the user at least sees the content.
    ok('unclosed [thinking] still emits content', thinkOf(events) + textOf(events) === ' I am reasoning about the question.');
  }

  // -- Test 6: real-world example — the actual pattern the model emits.
  {
    const events = runSplitter([
      '[thinking]\nThe user asks about global web archive nodes. I should structure this as a survey.\n</think>\n\n# Global Web Archive Nodes\n\n## 1. Internet Archive',
    ]);
    ok('real-world <think> routing', thinkOf(events).includes('global web archive nodes'));
    ok('real-world visible text', textOf(events).includes('# Global Web Archive Nodes'));
    ok('real-world header preserved', textOf(events).includes('## 1. Internet Archive'));
  }

  // -- Test 7: bracket form [thinking] ... [/thinking] across many chunks.
  {
    const events = runSplitter([
      'Before. ',
      '[thinking] hidden',
      ' part 1 [/thinking]',
      ' Middle. ',
      '[thinking] more [/thinking]',
      ' After.',
    ]);
    // " part 1 " ends with space, " more " has leading space → 2 spaces
    // between "1" and "more". The test verifies the exact routing.
    ok('multi-chunk bracket thinking', thinkOf(events) === ' hidden part 1  more ');
    ok('multi-chunk bracket text', textOf(events) === 'Before.  Middle.  After.');
  }

  // -- Test 8: feedReasoning (the proper reasoning_content channel).
  {
    const s = new InlineThinkingSplitter();
    const events: AssistantEvent[] = [];
    for (const ev of s.feedReasoning('clean reasoning ')) events.push(ev);
    for (const ev of s.feedReasoning('more reasoning')) events.push(ev);
    ok('feedReasoning passes through', thinkOf(events) === 'clean reasoning more reasoning');
  }

  console.log(process.exitCode === 1 ? 'THINKING-SPLIT SMOKE FAILED' : 'THINKING-SPLIT SMOKE PASSED');
}

main().catch((err) => {
  console.error('thinking-split smoke crashed:', err);
  process.exit(1);
});
