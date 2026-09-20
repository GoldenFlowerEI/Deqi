/**
 * v3.5: mcp tool — list configured MCP servers, list their tools, or call one.
 *
 * Modes (mode param):
 *   - 'list'    (default): list configured servers (from ~/.deqi/mcp.json)
 *   - 'tools'   : list the tools exposed by one server. Required: server
 *   - 'call'    : call a tool. Required: server, tool, args (object)
 *
 * This is a client (read + call). It does NOT start/stop servers.
 * For the test suite, use the in-memory transport (createInMemoryTransport)
 * by setting Deqi_MCP_INMEM=1 in the test environment.
 */

import type { AgentTool, ToolExecutionContext, ToolExecutionResult } from '@deqi/agent-core';
import {
  loadMcpConfig,
  connectStdioServer,
  listTools as mcpListTools,
  callTool as mcpCallTool,
  type McpServerConfig,
  type McpTool,
} from '../mcp-client.js';

export const mcpTool: AgentTool = {
  name: 'mcp',
  description: `Interact with configured MCP (Model Context Protocol) servers. v3.5 ships the read + call side only — the client does NOT start, stop, or manage servers.

Modes (mode param):
  - 'list'    (default): list the configured servers (from ~/.deqi/mcp.json). No I/O, just reads the file.
  - 'tools'   : list the tools exposed by ONE server. Spawns the server, performs the initialize handshake, calls tools/list, then closes. Required: server (name).
  - 'call'    : call ONE tool on ONE server. Spawns the server, initializes, calls tools/call, then closes. Required: server, tool, args (object).

Parameters:
  - mode (string, optional, default 'list')
  - server (string, required for tools/call)
  - tool (string, required for call)
  - args (object, optional, default {}): arguments to pass to the tool

Returns:
  - list:  { servers: [{name, command, args, env}] }
  - tools: { server, serverInfo, tools: [{name, description, inputSchema}] }
  - call:  { server, tool, result: { content, isError? } }   — result is the MCP-shaped content array

When to use:
  - The user asks you to use an external service that has an MCP server (database, GitHub, Slack, …)
  - You need a tool that deqi doesn't ship natively

When NOT to use:
  - For native deqi tools (read/write/bash/… use those directly)
  - For HTTP services — use the browser tool or webFetch
  - Don't blindly call MCP tools without first listing what's available

Examples:
  - mcp mode=list → see what's configured
  - mcp mode=tools server=github → see github's tools
  - mcp mode=call server=github tool=create_issue args={"title":"...","body":"..."}

Concurrency: NOT safe (spawns child processes).`,

  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['list', 'tools', 'call'] },
      server: { type: 'string' },
      tool: { type: 'string' },
      args: { type: 'object' },
    },
  },
  isConcurrencySafe: () => false,

  async execute(args: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    const a = args as {
      mode?: 'list' | 'tools' | 'call';
      server?: string;
      tool?: string;
      args?: Record<string, unknown>;
    };
    const mode = a.mode ?? 'list';

    try {
      if (mode === 'list') {
        const servers = loadMcpConfig();
        return ok({ servers: servers.map(stripEnv) });
      }

      if (mode === 'tools') {
        if (!a.server) return err('tools mode requires a server name');
        const cfg = findServer(a.server);
        if (!cfg) return err(`no MCP server named "${a.server}" in ~/.deqi/mcp.json`);
        const conn = await connectStdioServer(cfg);
        try {
          const tools = await mcpListTools(conn.transport);
          return ok({ server: cfg.name, serverInfo: conn.serverInfo, tools });
        } finally { conn.transport.close(); }
      }

      if (mode === 'call') {
        if (!a.server) return err('call mode requires a server name');
        if (!a.tool) return err('call mode requires a tool name');
        const cfg = findServer(a.server);
        if (!cfg) return err(`no MCP server named "${a.server}" in ~/.deqi/mcp.json`);
        const conn = await connectStdioServer(cfg);
        try {
          const result = await mcpCallTool(conn.transport, a.tool, a.args ?? {});
          return ok({ server: cfg.name, tool: a.tool, result });
        } finally { conn.transport.close(); }
      }

      return err(`unknown mode: ${mode}`);
    } catch (e) {
      return err(`mcp tool failed: ${(e as Error).message}`);
    }
  },
};

function findServer(name: string): McpServerConfig | null {
  const servers = loadMcpConfig();
  return servers.find((s) => s.name === name) ?? null;
}

function stripEnv(cfg: McpServerConfig): Omit<McpServerConfig, 'env'> & { env?: Record<string, string> } {
  // Keep env keys but mask values; we don't want to leak secrets in list output
  if (!cfg.env) return { name: cfg.name, command: cfg.command, args: cfg.args };
  const masked: Record<string, string> = {};
  for (const k of Object.keys(cfg.env)) masked[k] = '***';
  return { name: cfg.name, command: cfg.command, args: cfg.args, env: masked };
}

function ok(data: unknown): ToolExecutionResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function err(msg: string): ToolExecutionResult {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

/** Re-export the in-memory transport for tests. */
export { createInMemoryTransport, initialize, listTools, callTool } from '../mcp-client.js';
export type { McpServerConfig, McpTool, McpCallResult, McpContent, McpTransport } from '../mcp-client.js';
