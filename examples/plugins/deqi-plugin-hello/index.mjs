// Example deqi plugin — `deqi-plugin-hello`.
//
// v2.2 ships the discovery + manifest layer; the actual
// dynamic import of this file lands in v2.3. For now this
// file just exists so the `hasEntry` check in the loader
// returns true.

export function register(api) {
  api.registerTool({
    name: 'hello',
    description: 'Returns a friendly greeting.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: [],
    },
    execute: async ({ name }) => ({ greeting: `Hello, ${name ?? 'world'}!` }),
  });
}
