// Deqi plugin: deqi-plugin-stamp.
//
// Tiny demo plugin that proves the v3.9+ event subscription path.
// On every `turn_end`, it logs the wall-clock delta since the last
// turn_end (so you can watch agent turn latency from the server
// log). No capabilities needed beyond plugin:on (already in the
// safe default).
//
// Copy to ~/.deqi/plugins/deqi-plugin-stamp/ and start the server
// with Deqi_ENABLE_PLUGINS=1 to load it.

let lastTurnAt = 0;

export function register(api) {
  api.on('turn_end', (ev) => {
    const now = Date.now();
    const delta = lastTurnAt === 0 ? 0 : now - lastTurnAt;
    lastTurnAt = now;
    const turn = ev && ev.turn != null ? ev.turn : '?';
    const stop = ev && ev.stopReason ? ev.stopReason : 'unknown';
    api.log(`turn ${turn} (${stop}) — since-prev ${delta}ms`);
  });

  // Add a route so the desktop can confirm the plugin is loaded
  // without scraping server logs.
  api.registerRoute('GET', '/v1/plugin/stamp/health', async () => ({
    ok: true,
    plugin: 'deqi-plugin-stamp',
    lastTurnAt: lastTurnAt || null,
    version: '0.1.0',
  }));

  api.log('deqi-plugin-stamp registered: 0 tools, 1 route, 1 event');
}
