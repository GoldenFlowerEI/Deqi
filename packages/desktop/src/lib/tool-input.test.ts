/**
 * tool-input.test.ts
 *
 * The failure mode this guards against is not a crash — it is a chat
 * transcript that has become unreadable. These assertions are mostly
 * about *how much* gets shown and *which* field leads.
 */

import { describe, expect, it } from 'vitest';
import { summarizeToolInput } from './tool-input';

describe('summarizeToolInput', () => {
  it('leads with the command for bash', () => {
    const s = summarizeToolInput('bash', { command: 'npm test -- --watch=false' });
    expect(s.summary).toBe('npm test -- --watch=false');
  });

  it('leads with the path for file tools', () => {
    expect(summarizeToolInput('read', { path: 'src/index.ts' }).summary).toBe('src/index.ts');
    expect(summarizeToolInput('edit', { path: 'a.ts', old_string: 'x' }).summary).toBe('a.ts');
  });

  it('falls back to the first scalar for an unknown tool', () => {
    const s = summarizeToolInput('some_new_tool', { alpha: 1, beta: 'hello' });
    expect(s.summary).toBe('1');
  });

  it('describes an empty call rather than rendering nothing', () => {
    expect(summarizeToolInput('bash', {}).summary).toBe('no arguments');
  });

  it('elides a very long summary line', () => {
    const s = summarizeToolInput('bash', { command: 'echo ' + 'a'.repeat(500) });
    expect(s.summary.length).toBeLessThanOrEqual(161);
    expect(s.summary.endsWith('…')).toBe(true);
  });

  // ─── the flooding case ───────────────────────────────────────
  it('summarises a bulk field instead of printing the file', () => {
    const content = 'x'.repeat(5000);
    const s = summarizeToolInput('write', { path: 'a.ts', content });
    // The summary is the path — the one thing the user is looking for.
    expect(s.summary).toBe('a.ts');
    // And the preview is bounded, not 5000 characters.
    expect(s.preview.length).toBeLessThan(500);
    expect(s.preview).toContain('5000 chars');
    expect(s.truncated).toBe(true);
  });

  it('leaves a short bulk field readable', () => {
    const s = summarizeToolInput('write', { path: 'a.ts', content: 'const a = 1;' });
    expect(s.preview).toContain('const a = 1;');
    expect(s.truncated).toBe(false);
  });

  it('truncates a large non-bulk value', () => {
    const s = summarizeToolInput('grep', { pattern: 'a'.repeat(2000) });
    expect(s.preview.length).toBeLessThan(500);
    expect(s.truncated).toBe(true);
  });

  it('never loses the raw input', () => {
    const input = { path: 'a.ts', content: 'y'.repeat(3000) };
    const s = summarizeToolInput('write', input);
    // The disclosure shows the preview, but the original is retained,
    // so nothing the agent sent is unrecoverable from the UI.
    expect(s.raw).toBe(input);
  });

  // ─── malformed ───────────────────────────────────────────────
  it('survives every shape the wire can hand it', () => {
    for (const bad of [undefined, null, 42, 'a string', [], [1, 2]]) {
      const s = summarizeToolInput('bash', bad);
      expect(typeof s.summary).toBe('string');
      expect(typeof s.preview).toBe('string');
    }
  });

  it('handles a non-string in the key field', () => {
    const s = summarizeToolInput('read', { path: 42 });
    expect(s.summary).toBe('42');
  });
});
