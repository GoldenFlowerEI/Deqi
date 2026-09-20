/**
 * v4.8: `delegate_remote` tool — fan-out across multiple Deqi
 * desktops in the same `~/.deqi/` cluster.
 *
 * v4.2's `delegate` runs all sub-agents in-process on the local
 * machine. v4.8 lifts that to multi-machine:
 *
 *   - Each task can pin to a specific desktop via `target.desktop_id`
 *   - Or pick by capability (`target.capability: "browser-v2"`)
 *   - Or pick by tag (`target.tag: "laptop"`)
 *   - Or fall back to "any live desktop" (which includes the local one)
 *
 * Resolution is per-task: the orchestrator (this desktop) walks
 * the cluster registry, picks a target, and POSTs the prompt to
 * `<target.host>:<target.port>/v1/rpc/run-task`. The remote
 * desktop runs the prompt through its own AgentRunner and returns
 * `{ ok, text, durationMs }`.
 *
 * The local aggregate mirrors v4.2's report shape so callers
 * that already render `delegate` output get the same Markdown
 * with one extra line per task showing which desktop executed it.
 *
 * Failure mode: if a target desktop is unreachable (network
 * error, no listener), the task is reported with `ok: false`
 * and a `target_unreachable` reason. Other tasks continue; we
 * don't abort the whole fan-out on a single network blip.
 *
 * Concurrency: same as v4.2's `delegate` — bounded worker pool
 * (default 4) so a 16-task fan-out doesn't hammer every desktop
 * at once. Each task takes ~one HTTP request regardless of
 * how long the remote AgentRunner takes (we just await the
 * response, but the pool is "in flight" not "running").
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';

export interface RemoteTarget {
  /** Pin to an exact desktop id. Mutually exclusive with capability/tag. */
  desktop_id?: string;
  /** Pick the first live desktop advertising this capability. */
  capability?: string;
  /** Pick the first live desktop with this tag. */
  tag?: string;
  /** Default: any live desktop. */
  any?: boolean;
}

export interface RemoteDelegateTask {
  name?: string;
  prompt: string;
  model?: string;
  allowTools?: string[];
  /** If omitted, defaults to "any" — i.e. local desktop if alone. */
  target?: RemoteTarget;
}

export interface RemoteDelegateInput {
  tasks: RemoteDelegateTask[];
  /** Default 4, max 16. */
  maxConcurrency?: number;
  /** If true, return a per-task 240-char summary instead of the full text. */
  summarize?: boolean;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const HTTP_TIMEOUT_MS = 5 * 60_000; // 5min — matches our default session timeout

interface ClusterClientShape {
  list: () => Array<{
    desktop_id: string;
    name: string;
    host: string;
    port: number;
    capabilities: string[];
    tags: string[];
  }>;
  pick: (target: { desktop_id?: string; capability?: string; tag?: string }) => {
    desktop_id: string;
    host: string;
    port: number;
  } | null;
  local: () => { desktop_id: string; name: string; host: string; port: number } | null;
}

export const delegateRemoteTool: AgentTool = {
  name: 'delegate_remote',
  description:
    'Fan out to N sub-agents across multiple Deqi desktops. Each task declares ' +
    'a (prompt, target) tuple. The target can pin to a specific desktop_id, or ' +
    'select by capability (e.g. "browser-v2") or tag (e.g. "laptop"). Without a ' +
    'target, the task is routed to any live desktop (typically the local one). ' +
    'Use this when you need to leverage machines with different capabilities — ' +
    'e.g. "run the heavy analysis on my desktop, fetch live data on the laptop". ' +
    'For in-process fan-out, prefer the simpler `delegate` tool.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Optional label for logs / UI.' },
            prompt: { type: 'string', description: 'The sub-task prompt.' },
            model: { type: 'string', description: 'Optional model override.' },
            allowTools: { type: 'array', items: { type: 'string' }, description: 'Optional tool allowlist.' },
            target: {
              type: 'object',
              description: 'Where to run the task. Defaults to any live desktop.',
              properties: {
                desktop_id: { type: 'string' },
                capability: { type: 'string' },
                tag: { type: 'string' },
                any: { type: 'boolean' },
              },
            },
          },
          required: ['prompt'],
        },
      },
      maxConcurrency: { type: 'number', description: 'Optional concurrency cap. Default 4.' },
      summarize: { type: 'boolean', description: 'If true, return a 240-char summary per task.' },
    },
    required: ['tasks'],
  },
  async execute(args, ctx): Promise<ToolExecutionResult> {
    const a = args as RemoteDelegateInput | undefined;
    if (!a?.tasks || !Array.isArray(a.tasks) || a.tasks.length === 0) {
      return { content: [{ type: 'text', text: 'delegate_remote: tasks array is required' }], isError: true };
    }
    if (a.tasks.length > 16) {
      return { content: [{ type: 'text', text: 'delegate_remote: too many tasks (max 16); split into batches' }], isError: true };
    }
    const cluster = ctx.harness?.cluster as ClusterClientShape | undefined;
    if (!cluster) {
      return { content: [{ type: 'text', text: 'delegate_remote: cluster registry not exposed (run via Deqi-server, not the CLI)' }], isError: true };
    }

    const local = cluster.local();
    if (!local) {
      return { content: [{ type: 'text', text: 'delegate_remote: local desktop not registered in the cluster' }], isError: true };
    }

    const maxConcurrency = Math.max(1, Math.min(16, a.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY));
    // The cluster check above guarantees this; capture for
    // the inner closures to skip the `?` chain in the hot path.
    const clusterClient: ClusterClientShape = cluster;
    const results: Array<{
      name?: string;
      prompt: string;
      ok: boolean;
      text: string;
      durationMs: number;
      targetDesktopId: string;
      targetDesktopName?: string;
      error?: string;
    }> = [];

    // Bounded worker pool. The pump() cursor is shared across
    // workers; each worker takes the next pending task and
    // fires an HTTP request, then loops until the pool drains.
    let cursor = 0;
    const tasks = a.tasks;
    const errors: string[] = [];

    async function runOne(task: RemoteDelegateTask): Promise<void> {
      const start = Date.now();
      const resolved = resolveTarget(task.target ?? {}, clusterClient);
      if (!resolved) {
        results.push({
          name: task.name,
          prompt: task.prompt,
          ok: false,
          text: '',
          durationMs: Date.now() - start,
          targetDesktopId: '(none)',
          error: 'no live desktop matches the target',
        });
        errors.push('no_match');
        return;
      }
      const { host, port, desktopId, desktopName } = resolved;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(`http://${host}:${port}/v1/rpc/run-task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              task_id: task.name ?? `rt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
              prompt: task.prompt,
              model: task.model,
              allowTools: task.allowTools,
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          results.push({
            name: task.name,
            prompt: task.prompt,
            ok: false,
            text: '',
            durationMs: Date.now() - start,
            targetDesktopId: desktopId,
            targetDesktopName: desktopName,
            error: `http_${res.status}: ${errText.slice(0, 200)}`,
          });
          errors.push(`http_${res.status}`);
          return;
        }
        const body = (await res.json()) as {
          ok: boolean;
          text: string;
          durationMs: number;
          error?: string;
        };
        results.push({
          name: task.name,
          prompt: task.prompt,
          ok: body.ok,
          text: body.text ?? '',
          durationMs: Date.now() - start,
          targetDesktopId: desktopId,
          targetDesktopName: desktopName,
          error: body.error,
        });
        if (!body.ok) errors.push(body.error ?? 'remote_failure');
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        results.push({
          name: task.name,
          prompt: task.prompt,
          ok: false,
          text: '',
          durationMs: Date.now() - start,
          targetDesktopId: desktopId,
          targetDesktopName: desktopName,
          error: msg.includes('abort') ? `timeout_${HTTP_TIMEOUT_MS}ms` : `target_unreachable: ${msg}`,
        });
        errors.push('network');
      }
    }

    const pool: Promise<void>[] = [];
    async function pump(): Promise<void> {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        if (!task) continue;
        const p = runOne(task);
        pool.push(p);
        if (pool.length >= maxConcurrency) {
          // Wait for any one to finish, then loop and refill the
          // slot. We don't track WHICH promise finished (the
          // completed promise stays in `pool` until drain) —
          // that's fine; we just need the backpressure.
          await Promise.race(pool);
        }
      }
    }
    await pump();
    await Promise.all(pool);

    // Build the report. The shape mirrors v4.2's `delegate` so
    // the UI can render both with the same code, plus a small
    // v4.8 line showing which desktop ran each task.
    const lines: string[] = [];
    lines.push(`# delegate_remote: ${results.length} task(s) (concurrency=${maxConcurrency})`);
    if (errors.length > 0) lines.push(`# errors: ${errors.length}`);
    lines.push('');
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i]!;
      const label = r.name ?? `task-${i + 1}`;
      const status = r.ok ? 'ok' : 'FAIL';
      const target = r.targetDesktopId === '(none)'
        ? 'no-target'
        : `${r.targetDesktopName ?? 'desktop'}(${r.targetDesktopId.slice(2, 10)})`;
      lines.push(`## ${label} (${status}, ${r.durationMs}ms, on ${target})`);
      if (r.error) {
        lines.push('');
        lines.push(`error: ${r.error}`);
      }
      lines.push('');
      const body = a.summarize ? r.text.slice(0, 240) : r.text;
      lines.push(body);
      lines.push('');
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      isError: errors.length > 0 && results.every((r) => !r.ok),
    };
  },
};

/**
 * v4.8: resolve a target spec to a concrete (host, port,
 * desktop_id, desktop_name). Returns null if no live desktop
 * matches. The "any" default falls back to the first live
 * desktop — typically the local one in single-machine setups.
 */
function resolveTarget(
  target: RemoteTarget,
  cluster: ClusterClientShape,
): { host: string; port: number; desktopId: string; desktopName?: string } | null {
  if (target.desktop_id) {
    const d = cluster.pick({ desktop_id: target.desktop_id });
    if (!d) return null;
    return { host: d.host, port: d.port, desktopId: d.desktop_id };
  }
  if (target.capability) {
    const d = cluster.pick({ capability: target.capability });
    if (!d) return null;
    return { host: d.host, port: d.port, desktopId: d.desktop_id };
  }
  if (target.tag) {
    const d = cluster.pick({ tag: target.tag });
    if (!d) return null;
    return { host: d.host, port: d.port, desktopId: d.desktop_id };
  }
  // "any" or omitted: first live desktop.
  const all = cluster.list();
  if (all.length === 0) return null;
  const d = all[0]!;
  return { host: d.host, port: d.port, desktopId: d.desktop_id, desktopName: d.name };
}
