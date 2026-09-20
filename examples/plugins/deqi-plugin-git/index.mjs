// Deqi example plugin: deqi-plugin-git.
//
// Demonstrates all four PluginApi surfaces:
//   - registerTool   (3 git tools)
//   - registerRoute  (GET /v1/plugin/git/health → repo health check)
//   - on(event)      (logs every turn_end to the server console)
//   - log(msg)       (proves log() is wired)
//
// Copy this directory to ~/.deqi/plugins/deqi-plugin-git/ and
// start the server with Deqi_ENABLE_PLUGINS=1 to load it.

import { spawnSync } from 'node:child_process';

function git(api, args, cwd) {
  // v3.10: gate the subprocess call on a declared capability.
  // If a future maintainer drops the `subprocess` permission,
  // this throws before spawnSync is reached. Belt + suspenders
  // alongside the spawnSync shell:false below.
  api.requireCapability('subprocess');
  // spawnSync with shell:false is the safe choice for an agent
  // tool — we never want a plugin to be tricked into running
  // `git; rm -rf /` via a malicious diff. argv is split, not
  // shell-parsed.
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  if (r.error) return { error: r.error.message };
  if (r.status !== 0) {
    return { error: r.stderr || `git exited with code ${r.status}` };
  }
  return { output: r.stdout };
}

export function register(api) {
  // ── Tools ──────────────────────────────────────────────────────
  api.registerTool({
    name: 'git_status',
    description: 'Run `git status` in the agent cwd. Returns porcelain-format output (machine-readable).',
    input_schema: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      const r = git(api, ['status', '--porcelain'], ctx.cwd);
      if (r.error) return { error: r.error };
      return { output: r.output };
    },
  });

  api.registerTool({
    name: 'git_diff',
    description: 'Run `git diff` in the agent cwd. Returns unified diff text. Use this to review what changed before committing.',
    input_schema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'If true, show staged changes (`git diff --staged`); otherwise show unstaged.' },
        path: { type: 'string', description: 'Optional: limit diff to a specific path.' },
      },
    },
    async execute(args, ctx) {
      const argv = ['diff'];
      if (args?.staged) argv.push('--staged');
      if (args?.path) argv.push('--', args.path);
      const r = git(api, argv, ctx.cwd);
      if (r.error) return { error: r.error };
      return { output: r.output };
    },
  });

  api.registerTool({
    name: 'git_log',
    description: 'Run `git log` in the agent cwd. Returns one-line-per-commit output for the last N commits.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of commits to return. Default 10.' },
      },
    },
    async execute(args, ctx) {
      const n = Math.max(1, Math.min(100, args?.limit ?? 10));
      const r = git(api, ['log', `--max-count=${n}`, '--oneline'], ctx.cwd);
      if (r.error) return { error: r.error };
      return { output: r.output };
    },
  });

  // ── Route ──────────────────────────────────────────────────────
  // The desktop can call this to render a "git health" badge in
  // the project rail. Returns clean JSON; the server wraps the
  // return value in a 200 response.
  api.registerRoute('GET', '/v1/plugin/git/health', async (req) => {
    const cwd = req.query?.cwd;
    if (!cwd || typeof cwd !== 'string') {
      return { ok: false, error: 'missing cwd query param' };
    }
    const status = git(api, ['status', '--porcelain'], cwd);
    const branch = git(api, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    const log = git(api, ['log', '--max-count=1', '--oneline'], cwd);
    return {
      ok: !status.error && !branch.error,
      cwd,
      branch: branch.output?.trim() ?? null,
      lastCommit: log.output?.trim() ?? null,
      dirtyFiles: status.output?.split('\n').filter(Boolean).length ?? 0,
      statusOutput: status.output ?? status.error,
    };
  });

  // v3.9.1: example of a route with an express-style :param.
  // Desktop can call GET /v1/plugin/git/log/:n to get the last
  // n commits for a cwd. Demonstrates the param matching.
  api.registerRoute('GET', '/v1/plugin/git/log/:n', async (req) => {
    api.requireCapability('subprocess');
    const cwd = req.query?.cwd;
    const nRaw = req.params?.n ?? '10';
    const n = Math.max(1, Math.min(100, parseInt(String(nRaw), 10) || 10));
    if (!cwd || typeof cwd !== 'string') {
      return { ok: false, error: 'missing cwd query param' };
    }
    const r = git(api, ['log', `--max-count=${n}`, '--oneline'], cwd);
    if (r.error) return { ok: false, error: r.error };
    const commits = (r.output ?? '').split('\n').filter(Boolean).map((line) => {
      const [hash, ...rest] = line.split(' ');
      return { hash, subject: rest.join(' ') };
    });
    return { ok: true, cwd, count: commits.length, commits };
  });

  // ── Event subscription ─────────────────────────────────────────
  // This fires every time an agent turn ends. Plugin authors can
  // use this to log to a file, push telemetry, or trigger follow-up
  // work. Exceptions thrown here are swallowed by the server.
  api.on('turn_end', (ev) => {
    const { turn, stopReason } = ev;
    api.log(`turn ${turn} ended (${stopReason})`);
  });

  api.log('deqi-plugin-git registered: 3 tools, 1 route, 1 event');
}
