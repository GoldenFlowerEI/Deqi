/**
 * v3.5: MCP client (read + call, NOT open server).
 *
 * Minimal viable MCP client. The contract:
 *   - Connect to an MCP server (stdio transport; in-memory for tests)
 *   - Perform the `initialize` handshake
 *   - `listTools` → McpTool[]
 *   - `callTool(name, args)` → McpCallResult
 *
 * What v3.5 deliberately DOES NOT do (deferred to v3.5.1+):
 *   - Server lifecycle management (start/stop/restart)
 *   - The long-running MCP session (each call = new connect/close)
 *   - HTTP+SSE transport (stdio only)
 *   - Resources, prompts, sampling (only `tools` in v3.5)
 *
 * Design:
 *   - Transport is an interface so the protocol layer is testable
 *     with an in-memory stub (no real child process in unit tests).
 *   - `loadMcpConfig` reads ~/.deqi/mcp.json (servers: [{name, command, args, env}]).
 *   - Errors are returned as data, not exceptions, so the tool layer
 *     can always produce a ToolExecutionResult.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

/** Transport abstraction: send a JSON-RPC request, get a JSON-RPC response. */
export interface McpTransport {
  send(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** Stdio transport: spawns a child process and speaks line-delimited JSON over its stdio.
 *  The protocol layer (initialize/listTools/callTool) is responsible for
 *  adding `jsonrpc: '2.0'` and an `id` to outgoing messages. The transport
 *  just delivers the message and correlates the response by id. */
export function createStdioTransport(
  command: string,
  args: string[] = [],
  env: Record<string, string> = {},
): { transport: McpTransport; child: ChildProcess } {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();
  let buf = '';
  let errorBuf = '';
  let spawnError: Error | null = null;

  // Capture spawn errors (e.g. ENOENT) so we can surface them on send().
  child.on('error', (e) => {
    spawnError = e;
    for (const [id, p] of pending) {
      p.reject(new Error(`MCP child process error: ${e.message}`));
      pending.delete(id);
    }
  });

  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg.id as number | undefined;
        if (typeof id === 'number' && pending.has(id)) {
          pending.get(id)!.resolve(msg);
          pending.delete(id);
        }
      } catch { /* ignore parse errors */ }
    }
  });
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', (chunk: string) => { errorBuf += chunk; });

  const transport: McpTransport = {
    async send(message) {
      if (spawnError) throw new Error(`MCP child process error: ${spawnError.message}`);
      const id = (message.id as number | undefined) ?? Math.floor(Math.random() * 1_000_000);
      return new Promise((resolveP, rejectP) => {
        pending.set(id, { resolve: resolveP, reject: rejectP });
        try {
          child.stdin?.write(JSON.stringify(message) + '\n');
        } catch (e) {
          pending.delete(id);
          rejectP(e as Error);
          return;
        }
        // Per-call timeout (15s). A real session would be longer.
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rejectP(new Error('MCP request timed out after 15s'));
          }
        }, 15_000);
      });
    },
    close() {
      try { child.kill(); } catch { /* ignore */ }
    },
  };
  return { transport, child };
}

/** In-memory transport for tests. The handler produces a response per request. */
export function createInMemoryTransport(
  handler: (msg: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
): McpTransport {
  return {
    async send(message) {
      return await handler(message);
    },
    close() { /* no-op */ },
  };
}

// ─── Protocol (JSON-RPC 2.0) ─────────────────────────────────

let _rpcId = 0;
function nextId(): number { return ++_rpcId; }

export async function initialize(transport: McpTransport): Promise<McpServerInfo> {
  const resp = await transport.send({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'deqi', version: '3.5.0' },
    },
  });
  if (resp.error) throw new Error(`MCP initialize failed: ${(resp.error as { message: string }).message}`);
  const result = resp.result as { serverInfo?: { name?: string; version?: string } } | undefined;
  return {
    name: result?.serverInfo?.name ?? 'unknown',
    version: result?.serverInfo?.version ?? '0.0.0',
  };
}

export async function listTools(transport: McpTransport): Promise<McpTool[]> {
  const resp = await transport.send({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/list',
    params: {},
  });
  if (resp.error) throw new Error(`MCP tools/list failed: ${(resp.error as { message: string }).message}`);
  const result = resp.result as { tools?: McpTool[] } | undefined;
  return result?.tools ?? [];
}

export async function callTool(
  transport: McpTransport,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpCallResult> {
  const resp = await transport.send({
    jsonrpc: '2.0',
    id: nextId(),
    method: 'tools/call',
    params: { name, arguments: args },
  });
  if (resp.error) throw new Error(`MCP tools/call failed: ${(resp.error as { message: string }).message}`);
  return resp.result as McpCallResult;
}

// ─── Config (load from ~/.deqi/mcp.json) ─────────────────────

export function defaultMcpConfigPath(): string {
  return resolve(homedir(), '.deqi', 'mcp.json');
}

export function loadMcpConfig(path: string = defaultMcpConfigPath()): McpServerConfig[] {
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, 'utf-8');
    const data = JSON.parse(text) as { servers?: McpServerConfig[] };
    if (!Array.isArray(data.servers)) return [];
    return data.servers.filter(
      (s): s is McpServerConfig =>
        typeof s === 'object' && s !== null
        && typeof s.name === 'string' && s.name.length > 0
        && typeof s.command === 'string' && s.command.length > 0,
    );
  } catch {
    return [];
  }
}

// ─── Convenience: end-to-end call (connect + handshake + close) ───

export interface McpConnectResult {
  transport: McpTransport;
  serverInfo: McpServerInfo;
}

export async function connectStdioServer(config: McpServerConfig): Promise<McpConnectResult> {
  const { transport } = createStdioTransport(config.command, config.args ?? [], config.env ?? {});
  try {
    const serverInfo = await initialize(transport);
    return { transport, serverInfo };
  } catch (e) {
    transport.close();
    throw e;
  }
}
