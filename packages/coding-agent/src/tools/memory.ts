/**
 * v3.2: memory tool (Generative Agents-inspired long-term memory).
 *
 * Three targets: facts (small key-value), prefs (user preferences),
 * patterns (recurring task recipes). Each target has a search and a
 * write subcommand.
 *
 * Search is a simple bag-of-words scorer (no embeddings) — fine for
 * the small number of facts an individual project accumulates.
 * Future: replace with a local embedding model.
 *
 * Concurrency: NOT safe (mutates a file). Reads via search are safe
 * but we mark the tool as not-safe to discourage fanning out many
 * parallel searches.
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import {
  addFact, searchFacts, findFact, deleteFact, readFacts,
  setPref, getPref, readPrefs,
  addPattern, searchPatterns, readPatterns,
  type Fact,
} from '../memory.js';

export const memoryTool: AgentTool = {
  name: 'memory',
  description: `Read or write the agent's long-term memory (Generative Agents pattern). Survives across sessions. Three targets:

Targets (target param):
  - 'facts'    — small key-value facts (paths, env, integrations).  Each fact has a category, key, value.
  - 'prefs'    — user preferences (default model, tone, schedule). One value per key.
  - 'patterns' — recurring task recipes. A trigger string + a list of steps to follow.

Actions (action param):
  - 'search'  — query the target. Required: target, query. Returns top matches.
  - 'get'     — exact lookup. Required: target, key. Returns the value or null.
  - 'write'   — set a value. Required: target, key, value. For 'patterns', also pass 'recipe' (string[]).
  - 'delete'  — remove an entry. Required: target, id (or key, depending on target).
  - 'list'    — list all entries. Required: target.

When to use:
  - You learned something that will be useful in future sessions (a path, a preference, a workflow)
  - You're about to do a task similar to one you've done before — search patterns first
  - The user corrects a default (model, tone) — write to prefs so you remember next time

When NOT to use:
  - For ephemeral state (use the working memory / session_history instead)
  - For the user's literal request (that's a session_history entry, not a memory)
  - For data that's already in the project state (use \`session_history\` for the current session)

Parameters:
  - target (string, required): 'facts' | 'prefs' | 'patterns'
  - action (string, required): 'search' | 'get' | 'write' | 'delete' | 'list'
  - key (string): required for get/write/delete on facts and prefs
  - value (string): required for write on facts and prefs
  - category (string, optional): for facts, one of 'env'|'path'|'integration'|'user'|'project'
  - query (string): required for search
  - recipe (string[]): for patterns write, the step list
  - id (string): for delete on patterns
  - limit (number, default 10): max results for search/list

Returns:
  - search: array of matches
  - get: single entry or null
  - write: confirmation + the entry
  - delete: confirmation
  - list: array of entries

Examples:
  - memory target=prefs action=write key=defaultModel value=claude-sonnet-4-5 → "saved"
  - memory target=facts action=search query=python → matching facts
  - memory target=patterns action=search query=deploy → matching recipes

Concurrency: NOT safe (writes state).`,

  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', enum: ['facts', 'prefs', 'patterns'] },
      action: { type: 'string', enum: ['search', 'get', 'write', 'delete', 'list'] },
      key: { type: 'string' },
      value: { type: 'string' },
      category: { type: 'string', enum: ['env', 'path', 'integration', 'user', 'project'] },
      query: { type: 'string' },
      recipe: { type: 'array', items: { type: 'string' } },
      id: { type: 'string' },
      limit: { type: 'number' },
    },
    required: ['target', 'action'],
  },
  isConcurrencySafe: () => false,
  async execute(args: unknown, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const a = args as {
      target?: 'facts' | 'prefs' | 'patterns';
      action?: 'search' | 'get' | 'write' | 'delete' | 'list';
      key?: string;
      value?: string;
      category?: Fact['category'];
      query?: string;
      recipe?: string[];
      id?: string;
      limit?: number;
    };
    if (!a?.target || !a?.action) {
      return { content: [{ type: 'text', text: 'Missing target or action' }], isError: true };
    }
    const limit = a.limit ?? 10;

    try {
      if (a.target === 'facts') {
        if (a.action === 'list') return okResult(readFacts().slice(0, limit));
        if (a.action === 'get') {
          if (!a.key) return errResult('facts.get requires key');
          return okResult(findFact((a.category ?? 'env') as Fact['category'], a.key));
        }
        if (a.action === 'search') {
          if (!a.query) return errResult('facts.search requires query');
          return okResult(searchFacts(a.query, limit));
        }
        if (a.action === 'write') {
          if (!a.key || a.value === undefined) return errResult('facts.write requires key and value');
          const cat = (a.category ?? 'env') as Fact['category'];
          return okResult(addFact(cat, a.key, a.value));
        }
        if (a.action === 'delete') {
          if (!a.id) return errResult('facts.delete requires id');
          deleteFact(a.id);
          return okResult({ ok: true, deleted: a.id });
        }
      }

      if (a.target === 'prefs') {
        if (a.action === 'list') return okResult(readPrefs().slice(0, limit));
        if (a.action === 'get') {
          if (!a.key) return errResult('prefs.get requires key');
          return okResult(getPref(a.key));
        }
        if (a.action === 'search') {
          if (!a.query) return errResult('prefs.search requires query');
          const all = readPrefs();
          const q = a.query.toLowerCase();
          return okResult(all.filter((p) => p.key.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)).slice(0, limit));
        }
        if (a.action === 'write') {
          if (!a.key || a.value === undefined) return errResult('prefs.write requires key and value');
          return okResult(setPref(a.key, a.value));
        }
        if (a.action === 'delete') {
          if (!a.key) return errResult('prefs.delete requires key');
          setPref(a.key, '');
          return okResult({ ok: true, deleted: a.key });
        }
      }

      if (a.target === 'patterns') {
        if (a.action === 'list') return okResult(readPatterns().slice(0, limit));
        if (a.action === 'get') {
          if (!a.key) return errResult('patterns.get requires key (pattern id)');
          const p = readPatterns().find((x) => x.id === a.key);
          return okResult(p ?? null);
        }
        if (a.action === 'search') {
          if (!a.query) return errResult('patterns.search requires query');
          return okResult(searchPatterns(a.query, limit));
        }
        if (a.action === 'write') {
          if (!a.query || !a.recipe) return errResult('patterns.write requires query (trigger) and recipe (string[])');
          return okResult(addPattern(a.query, a.recipe));
        }
        if (a.action === 'delete') {
          if (!a.id) return errResult('patterns.delete requires id');
          const all = readPatterns().filter((p) => p.id !== a.id);
          // import writePatterns
          const { writePatterns } = await import('../memory.js');
          writePatterns(all);
          return okResult({ ok: true, deleted: a.id });
        }
      }

      return errResult(`unsupported ${a.target}.${a.action}`);
    } catch (e) {
      return errResult((e as Error).message);
    }
  },
};

function okResult(data: unknown): ToolExecutionResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function errResult(msg: string): ToolExecutionResult {
  return { content: [{ type: 'text', text: msg }], isError: true };
}
