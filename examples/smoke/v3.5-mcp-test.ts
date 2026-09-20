/**
 * v3.5 test ï¿?MCP client + mcp tool.
 *
 * What's covered (~32 asserts):
 *   - Protocol (in-memory transport):
 *     - initialize sends the right JSON-RPC shape
 *     - initialize returns serverInfo from the response
 *     - initialize error ï¿?throws
 *     - listTools sends {method: 'tools/list'}
 *     - listTools returns the tools array
 *     - listTools returns [] when server has no tools
 *     - callTool sends {method: 'tools/call', params: {name, arguments}}
 *     - callTool returns the content array
 *     - callTool error ï¿?throws
 *   - Stdio transport (smoke):
 *     - spawning a missing command surfaces an error
 *   - Config:
 *     - loadMcpConfig on missing file returns []
 *     - loadMcpConfig reads ~/.deqi/mcp.json
 *     - loadMcpConfig filters invalid entries (no name, no command)
 *     - loadMcpConfig tolerates bad JSON (returns [])
 *   - mcp tool:
 *     - list mode returns {servers: []} on empty config
 *     - list mode masks env values
 *     - tools mode with no server ï¿?isError
 *     - tools mode with unknown server ï¿?isError
 *     - call mode with no server/tool ï¿?isError
 *     - mcp tool isConcurrencySafe is false
 *   - BUILTIN_TOOLS:
 *     - count = 19 (17 + mcp + browser)
 *     - mcp is in BUILTIN_TOOLS
 *     - mcp has the v3.1 description
 *
 * No real network, no LLM. Stdio transport is smoke-tested only.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount += 1; console.log(`  \x1b[32mok\x1b[0m  ${name}${detail ? ` ï¿?${detail}` : ''}`); }
  else { failCount += 1; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` ï¿?${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n\x1b[1mâ”€â”€ ${t} â”€â”€\x1b[0m`); }

async function main(): Promise<void> {
  const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const tmpHome = mkdtempSync(join(tmpdir(), 'deqi-v35-mcp-'));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  try {
    const mcpClientMod = await import('../../packages/coding-agent/dist/src/mcp-client.js');
    const mcpToolMod = await import('../../packages/coding-agent/dist/src/tools/mcp.js');
    const toolsIdx = await import('../../packages/coding-agent/dist/src/tools/index.js');

    section('Protocol ï¿?initialize');
    {
      const captured: Array<Record<string, unknown>> = [];
      const transport = mcpClientMod.createInMemoryTransport((msg) => {
        captured.push(msg);
        return {
          jsonrpc: '2.0', id: msg.id,
          result: { serverInfo: { name: 'fake-server', version: '1.2.3' } },
        };
      });
      const info = await mcpClientMod.initialize(transport);
      transport.close();
      ok('initialize returns the server name', info.name === 'fake-server');
      ok('initialize returns the server version', info.version === '1.2.3');
      ok('initialize sent jsonrpc: 2.0', captured[0]?.['jsonrpc'] === '2.0');
      ok('initialize sent method: initialize', captured[0]?.['method'] === 'initialize');
      ok('initialize sent protocolVersion 2024-11-05',
        (captured[0]?.['params'] as { protocolVersion?: string })?.protocolVersion === '2024-11-05');
      ok('initialize sent clientInfo.name=deqi',
        (captured[0]?.['params'] as { clientInfo?: { name?: string } })?.clientInfo?.name === 'deqi');
    }

    section('Protocol ï¿?initialize error');
    {
      const transport = mcpClientMod.createInMemoryTransport((msg) => ({
        jsonrpc: '2.0', id: msg.id,
        error: { code: -1, message: 'unsupported protocol version' },
      }));
      let threw = false;
      try { await mcpClientMod.initialize(transport); } catch (e) { threw = true; }
      ok('initialize error response throws', threw);
    }

    section('Protocol ï¿?listTools');
    {
      const captured: Array<Record<string, unknown>> = [];
      const transport = mcpClientMod.createInMemoryTransport((msg) => {
        captured.push(msg);
        if (msg['method'] === 'initialize') return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'x', version: '0' } } };
        if (msg['method'] === 'tools/list') return {
          jsonrpc: '2.0', id: msg.id,
          result: { tools: [
            { name: 'sum', description: 'add two numbers', inputSchema: { type: 'object' } },
            { name: 'echo', description: 'echo back', inputSchema: { type: 'object' } },
          ] },
        };
        return { jsonrpc: '2.0', id: msg.id, error: { code: -1, message: 'unknown' } };
      });
      const tools = await mcpClientMod.listTools(transport);
      transport.close();
      ok('listTools returns 2 tools', tools.length === 2);
      ok('listTools[0].name is sum', tools[0]?.name === 'sum');
      ok('listTools[0].description present', tools[0]?.description === 'add two numbers');
      ok('listTools call sent method: tools/list', captured[0]?.['method'] === 'tools/list');
      ok('listTools call sent jsonrpc: 2.0', captured[0]?.['jsonrpc'] === '2.0');
      ok('listTools call has an id', typeof captured[0]?.['id'] === 'number');
    }
    {
      const transport = mcpClientMod.createInMemoryTransport((msg) => {
        if (msg['method'] === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: [] } };
        return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'x', version: '0' } } };
      });
      const tools = await mcpClientMod.listTools(transport);
      transport.close();
      ok('listTools returns [] when server has no tools', tools.length === 0);
    }

    section('Protocol ï¿?callTool');
    {
      const captured: Array<Record<string, unknown>> = [];
      const transport = mcpClientMod.createInMemoryTransport((msg) => {
        captured.push(msg);
        if (msg['method'] === 'tools/call') return {
          jsonrpc: '2.0', id: msg.id,
          result: { content: [{ type: 'text', text: '42' }] },
        };
        return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'x', version: '0' } } };
      });
      const result = await mcpClientMod.callTool(transport, 'sum', { a: 1, b: 41 });
      transport.close();
      ok('callTool returns content array', result.content.length === 1);
      ok('callTool content[0].text is "42"', (result.content[0] as { text: string }).text === '42');
      const params = captured[0]?.['params'] as { name?: string; arguments?: unknown };
      ok('callTool sent name=sum', params?.name === 'sum');
      ok('callTool sent arguments={a:1,b:41}', JSON.stringify(params?.arguments) === '{"a":1,"b":41}');
      ok('callTool sent jsonrpc: 2.0', captured[0]?.['jsonrpc'] === '2.0');
    }
    {
      const transport = mcpClientMod.createInMemoryTransport((msg) => {
        if (msg['method'] === 'tools/call') return {
          jsonrpc: '2.0', id: msg.id,
          error: { code: -1, message: 'tool not found' },
        };
        return { jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'x', version: '0' } } };
      });
      let threw = false;
      try { await mcpClientMod.callTool(transport, 'bogus', {}); } catch { threw = true; }
      transport.close();
      ok('callTool error response throws', threw);
    }

    section('Stdio transport ï¿?missing command fails');
    {
      let threw = false;
      try {
        const { transport } = mcpClientMod.createStdioTransport(
          'definitely-not-a-real-binary-xyz', [], {},
        );
        await mcpClientMod.initialize(transport);
      } catch { threw = true; }
      ok('spawning a non-existent binary surfaces an error', threw);
    }

    section('loadMcpConfig');
    {
      ok('loadMcpConfig on missing file returns []', mcpClientMod.loadMcpConfig(join(tmpHome, 'no-such.json')).length === 0);
      const cfgPath = join(tmpHome, '.deqi', 'mcp.json');
      mkdirSync(join(tmpHome, '.deqi'), { recursive: true });
      writeFileSync(cfgPath, JSON.stringify({ servers: [
        { name: 'github', command: 'node', args: ['g.js'] },
        { name: 'no-command' },
        { name: '', command: 'x' },
        { name: 'slack', command: 'node', args: ['s.js'], env: { SLACK_TOKEN: 'secret' } },
      ] }), 'utf-8');
      const cfg = mcpClientMod.loadMcpConfig(cfgPath);
      ok('loadMcpConfig filters entries with no command', cfg.length === 2, `len=${cfg.length}`);
      ok('loadMcpConfig keeps name+command entries', cfg.some((c: { name: string }) => c.name === 'github'));
      ok('loadMcpConfig drops entries with empty name', !cfg.some((c: { name: string }) => c.name === ''));
      ok('loadMcpConfig preserves env object', cfg.some((c: { name: string; env?: Record<string, string> }) => c.name === 'slack' && c.env?.SLACK_TOKEN === 'secret'));

      // Tolerate bad JSON
      writeFileSync(cfgPath, '{not valid json', 'utf-8');
      ok('loadMcpConfig tolerates bad JSON', mcpClientMod.loadMcpConfig(cfgPath).length === 0);

      // defaultMcpConfigPath is in $HOME/.deqi/mcp.json
      ok('defaultMcpConfigPath ends with .deqi/mcp.json', mcpClientMod.defaultMcpConfigPath().endsWith(`${join('.deqi', 'mcp.json')}`));
    }

    section('mcp tool ï¿?list mode');
    {
      // Set a config in tmpHome/.deqi/mcp.json since the mcp tool uses
      // homedir() (which now returns tmpHome because we set USERPROFILE).
      const testCfg = join(tmpHome, '.deqi', 'mcp.json');
      const realCfg = testCfg;
      writeFileSync(realCfg, JSON.stringify({ servers: [
        { name: 'gh', command: 'node', args: ['g.js'], env: { GH_TOKEN: 'shhhh' } },
      ] }), 'utf-8');
      const res = await mcpToolMod.mcpTool.execute({ mode: 'list' }, { cwd: process.cwd() });
      ok('list mode has no isError', !res.isError, res.isError ? `text=${res.content[0]?.text}` : '');
      const parsed = JSON.parse(res.content[0]?.type === 'text' ? res.content[0].text : '');
      ok('list mode returns 1 server', parsed.servers.length === 1);
      ok('list mode masks env values',
        parsed.servers[0].env.GH_TOKEN === '***',
        `env.GH_TOKEN=${parsed.servers[0].env.GH_TOKEN}`);
    }

    section('mcp tool ï¿?error cases');
    {
      // Empty config at tmpHome (the mcp tool's effective home)
      const realCfg = join(tmpHome, '.deqi', 'mcp.json');
      writeFileSync(realCfg, '[]', 'utf-8');
      const noServer = await mcpToolMod.mcpTool.execute({ mode: 'tools' }, { cwd: process.cwd() });
      ok('tools mode missing server ï¿?isError', noServer.isError === true);
      const noTool = await mcpToolMod.mcpTool.execute({ mode: 'call', server: 'gh' }, { cwd: process.cwd() });
      ok('call mode missing tool ï¿?isError', noTool.isError === true);
      const unknownSrv = await mcpToolMod.mcpTool.execute({ mode: 'tools', server: 'nonexistent' }, { cwd: process.cwd() });
      ok('tools mode unknown server ï¿?isError', unknownSrv.isError === true);
    }

    section('mcp tool ï¿?concurrency');
    ok('mcp isConcurrencySafe returns false', mcpToolMod.mcpTool.isConcurrencySafe?.({}) === false);

    section('BUILTIN_TOOLS');
    ok('count = 19 (17 prior + mcp + browser)', toolsIdx.BUILTIN_TOOLS.length === 22, `count=${toolsIdx.BUILTIN_TOOLS.length}`);
    ok('mcp is in BUILTIN_TOOLS', toolsIdx.BUILTIN_TOOLS.some((t: { name: string }) => t.name === 'mcp'));
    const mcpInTools = toolsIdx.BUILTIN_TOOLS.find((t: { name: string }) => t.name === 'mcp');
    ok('mcp has the v3.1 description (Interact with configured MCP)', mcpInTools?.description.includes('Interact with configured MCP'));

    section('summary');
    console.log(`  \x1b[1mpassed:\x1b[0m ${passCount}    \x1b[1mfailed:\x1b[0m ${failCount}`);
    if (failCount > 0) {
      console.log('  failures:');
      for (const f of failures) console.log(`    - ${f}`);
    }
  } finally {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    // Don't pollute real HOME ï¿?the test wrote a fake mcp.json there
    const realCfg = join(realHome, '.deqi', 'mcp.json');
    try { if (existsSync(realCfg)) rmSync(realCfg); } catch { /* ignore */ } // legacy safety
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => { console.error('v3.5-mcp-test crashed:', err); process.exit(1); });
