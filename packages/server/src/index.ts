/**
 * Entry point for the Deqi-server binary.
 *
 * Usage:
 *   deqi-server                    # bind 127.0.0.1:7700
 *   deqi-server --port 8800        # custom port
 *   deqi-server --host 0.0.0.0     # bind all interfaces (DANGEROUS)
 *
 * The server is local-only by default. If you bind to 0.0.0.0,
 * anyone on your network can drive the agent — only do this for
 * demos or local-network sharing.
 */

import { DeqiServer } from './server.js';

const argv = process.argv.slice(2);
const opts: { host?: string; port?: number } = {};
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--port' && argv[i + 1]) {
    opts.port = Number(argv[i + 1]);
    i += 1;
  } else if (argv[i] === '--host' && argv[i + 1]) {
    opts.host = argv[i + 1];
    i += 1;
  } else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('Deqi-server — local HTTP+WebSocket facade for the Deqi agent');
    console.log('');
    console.log('Usage: deqi-server [--port N] [--host IP]');
    console.log('');
    console.log('Defaults: --port 7700 --host 127.0.0.1');
    process.exit(0);
  }
}

const server = new DeqiServer(opts);
server.start().then(({ host, port }) => {
  console.log(`[Deqi-server] listening on http://${host}:${port}`);
  console.log(`[Deqi-server] WebSocket endpoint: ws://${host}:${port}/v1/chat`);
  console.log(`[Deqi-server] Health check:       http://${host}:${port}/health`);
  console.log(`[Deqi-server] Press Ctrl+C to stop.`);
}).catch((err) => {
  console.error('[Deqi-server] failed to start:', err);
  process.exit(1);
});

// Graceful shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n[Deqi-server] ${sig} received, shutting down…`);
    server.stop().then(() => process.exit(0));
  });
}
