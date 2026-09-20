/**
 * v3.1: Anthropic 4-principles tool description rewrite.
 *
 * Reference: https://www.anthropic.com/engineering/building-effective-agents
 *   1. Be specific: tell the model when to use AND when not to.
 *   2. Poka-yoke: shape inputs so the model can't write them wrong.
 *   3. Token-efficient output: short result + footer for truncation.
 *   4. Test in the workbench: iterate.
 *
 * These string constants are the `description` field on each BUILTIN_TOOL.
 * The buildSystemPrompt will use these directly (it used to inline
 * its own terse version). Edit here to update the model's view of
 * every tool.
 */

export const TOOL_DESCRIPTIONS = {
  read: `Read a file. Returns the file content with 1-indexed line numbers, like \`cat -n\`. Supports \`offset\` (1-indexed start line) and \`limit\` (max lines).

When to use:
  - You need the actual contents of a file before editing or summarizing
  - Investigating a bug, a config, or a code path
  - The user said "show me file X" / "what's in Y"

When NOT to use:
  - You only need to know whether a file exists or its size — use \`glob\` or \`bash\` (\`ls\`)
  - You want to find files by name pattern — use \`glob\` instead
  - The file is binary (image, PDF, video) — these are not supported in v3.1; tell the user

Parameters:
  - path (string, required): absolute path or path relative to cwd. Absolute is preferred.
  - offset (number): 1-indexed line to start at. Default: 1.
  - limit (number): max lines to return. Default: 500. Max: 5000.

Returns:
  - "<n>\\t<line>" per line, then a footer "(N lines total)".
  - If file is larger than 5MB, returns an error suggesting offset/limit.

Examples:
  - read path=/abs/src/auth.ts → numbered lines of the file
  - read path=src/auth.ts offset=100 limit=50 → next 50 lines starting at 100

Concurrency: SAFE (read-only).`,

  write: `Write a file, creating it if it doesn't exist or overwriting if it does. This is the primary way to produce new content (code, docs, configs).

When to use:
  - Creating a new file from scratch
  - Replacing a file's contents entirely (refactor, scaffolding)
  - Writing generated output (test fixtures, fixtures)

When NOT to use:
  - Surgical change to an existing file — use \`edit\` instead (avoids overwriting unrelated changes)
  - Writing to a path outside cwd (refuses; if you really need it, ask the user first)

Parameters:
  - path (string, required): absolute or cwd-relative path. Will be created if it doesn't exist.
  - content (string, required): the full file content. Use \\n for newlines.

Returns:
  - On success: "wrote N bytes to <path>"

Examples:
  - write path=src/utils.ts content="export const x = 1;\\n" → file created with 1-line content

Concurrency: NOT safe (always run alone).`,

  edit: `Surgically edit a file by replacing a unique substring. Prefer this over \`write\` whenever you're changing an existing file.

When to use:
  - Tweaking a function, fixing a typo, adding a log line
  - You want to make sure you don't accidentally clobber unrelated changes in the same file
  - Editing config files where exact context matters

When NOT to use:
  - Writing a brand-new file (use \`write\`)
  - The \`old_text\` appears multiple times in the file (the edit will refuse; you must disambiguate with more context)

Parameters:
  - path (string, required): file to edit
  - old_text (string, required): the EXACT substring to replace, with enough surrounding context to be unique
  - new_text (string, required): the replacement

Returns:
  - On success: "edited <path> (N bytes changed)"

Examples:
  - edit path=src/auth.ts old_text="const port = 3000" new_text="const port = process.env.PORT ?? 3000"

Concurrency: NOT safe (mutates a file).`,

  bash: `Run a shell command. The default shell is \`sh\` on POSIX and \`cmd.exe\` on Windows; \`bash\` is used if available. Output is truncated past 100KB and the command is killed after 30s by default.

When to use:
  - Running tests, build commands, linters
  - Inspecting the filesystem: ls, find, stat, file
  - Calling system utilities: grep, sed, awk, curl
  - Spawning dev processes: npm start, cargo run
  - Anything you can't do with the other tools

When NOT to use:
  - Reading a file with line numbers — use \`read\` (faster, no shell)
  - Searching file contents — use \`grep\` (skips binary, line-numbered)
  - The command is destructive and you don't have a clear undo (rm -rf, git push --force) — confirm with the user first
  - Long-running dev servers (will time out at 30s; use \`timeout: 600000\` for up to 10 min)

Parameters:
  - command (string, required): the shell command
  - timeout (number, default 30000, max 600000): kill after N ms
  - description (string): short human description of what you're doing

Returns:
  - On success: "<stdout>\\n<stderr>\\n(exit 0, Nms)"
  - On failure: same plus "(exit N)"

Examples:
  - bash command="npm test" → runs the test suite
  - bash command="ls -la /tmp | head -20" → filesystem listing

Concurrency: depends on the command. Read-only commands are safe; mutations are not.`,

  grep: `Search for a pattern across files in a directory, with line numbers and context. Recursive by default, respects .gitignore.

When to use:
  - Finding where a function, variable, or string is used
  - Investigating "who imports X?" or "where is Y called?"
  - Searching for TODOs, error messages, or log lines

When NOT to use:
  - Searching a single known file — use \`read\` first
  - Searching for file names — use \`glob\`
  - Searching binary files (will return garbage or skip)

Parameters:
  - pattern (string, required): regex pattern
  - path (string, default cwd): directory to search
  - include (string): file glob filter, e.g. "*.ts" or "*.{ts,tsx}"
  - context (number, default 2): lines of context around each match

Returns:
  - "<path>:<line>:<content>" per match, with N context lines above/below

Examples:
  - grep pattern="TODO" include="*.ts" → all TS TODOs
  - grep pattern="function getUser" context=5 → matches with 5 lines of context

Concurrency: SAFE.`,

  glob: `Find files by name pattern. Returns paths relative to the search root. Skips \`node_modules\`, \`.git\`, \`dist\`, \`build\`, etc. by default.

When to use:
  - Listing files in a directory
  - Finding all files of a certain type (*.test.ts, *.md)
  - Checking whether a file exists at a known pattern

When NOT to use:
  - Searching file CONTENT — use \`grep\`
  - Reading a specific known file — use \`read\`

Parameters:
  - pattern (string, required): glob like "**/*.ts" or "src/**/*.test.*"
  - path (string, default cwd): search root

Returns:
  - Newline-separated list of paths, max 200 entries

Examples:
  - glob pattern="**/*.test.ts" → all test files
  - glob pattern="src/**/index.{ts,tsx}" → index files under src

Concurrency: SAFE.`,

  subagent: `Spawn a focused sub-agent for a self-contained task. The sub-agent has its own context window, runs to completion, and returns a single report. It does NOT share memory with you.

When to use:
  - The task is a focused, self-contained unit of work (write tests for this one function, summarize this one paper)
  - You want a second opinion from a different model (sub-agent can use a different model)
  - You want to keep the main context window small (sub-agent's full transcript is summarized into one report)

When NOT to use:
  - You need shared state with the sub-agent (it can't see your other tool calls)
  - The task is trivial — just do it inline
  - You need real-time control over the sub-agent (it's fire-and-forget)

Parameters:
  - prompt (string, required): the task description. Be specific; the sub-agent has no context. Always pass absolute paths.
  - model (string, optional): override the default model. Useful for "use a smaller model for this trivial task" or "use a bigger model for this hard task".

Returns:
  - A single report string from the sub-agent. The sub-agent's tool calls are NOT shown to you.

Examples:
  - subagent prompt="Find every place that calls getUser and list them" → list of references
  - subagent prompt="Write a 200-line tutorial on how the auth flow works" → tutorial

Concurrency: NOT safe (recursion). NEVER call subagent from inside a subagent.`,

  constitution: `Read the project's constitutional principles. These are the values that should shape every decision. The agent should re-read this whenever it's uncertain whether an action is in scope.

When to use:
  - Before any decision with significant consequences (deletion, deployment, public statements)
  - When the user gives a task that might conflict with a higher-order principle
  - When you feel yourself reaching for a tool you'd rather not use

When NOT to use:
  - For ordinary reads, edits, and shells (just do the work)
  - To override the user's explicit request (the constitution is a guide, not a hard override)

Parameters: none.

Returns:
  - A multi-paragraph statement of principles.

Examples:
  - Before rm -rf: read the constitution first to confirm the principle applies
  - Before pushing to a public registry: confirm the action is in scope

Concurrency: SAFE.`,

  user_model: `Inspect the current model of the user's goals, topic distribution, and recent surprises. The model is updated after every turn. Use it when you want to understand why the user is doing what they're doing.

When to use:
  - The user seems to be shifting direction and you want to know what the model thinks the new topic is
  - You want to ask a clarifying question (look at the topic distribution to see if you're in the right neighborhood)
  - You're about to surface a "surprise" event — what does the model think the user is doing?

When NOT to use:
  - For every turn (the model updates automatically; you don't need to re-read it)
  - To override the user's literal request — the model is a guess, the user is always the ground truth; never act against a literal request because the model says the user "probably" wants something else

Parameters:
  - aspect (string, optional): "topics" | "surprises" | "all". Default: "all".

Returns:
  - The current user model state.

Examples:
  - user_model aspect=surprises → list of recent surprise events (good for self-reflection)
  - user_model aspect=topics → topic distribution across recent turns

Concurrency: SAFE.`,

  session_history: `Read the entries of the current session (or a past one) — user messages, assistant messages, tool calls, tool results. Use it for re-orienting in a long session.

When to use:
  - "What did I say 10 turns ago?"
  - "What tool did I call before this?"
  - You suspect you're repeating work

When NOT to use:
  - For the current turn's events (you already have them in context)
  - For cross-session memory — use \`memory\` (v3.2+)

Parameters:
  - sessionId (string, optional): defaults to the current session. Always use the absolute session id from the URL.
  - limit (number, optional): max entries to return (default 50, max 500)
  - filter (string, optional): "user" | "assistant" | "tool" | "all"

Returns:
  - JSONL stream of session entries

Examples:
  - session_history limit=20 → last 20 entries of current session
  - session_history sessionId=abc123 filter=tool → only the tool calls in that session

Concurrency: SAFE.`,

  self_reflect: `Reflect on your own recent behavior. Reads the introspection snapshot of the last N turns and produces a reflection. The reflection is private (not shown to the user) and is written to the introspection log so future sessions can build on it.

When to use:
  - You just finished a long task — capture what worked and what didn't
  - The user said "remember that" — encode the preference into the log
  - You feel stuck — surface your recent patterns to find a fresh angle

When NOT to use:
  - As a user-facing tool (the reflection is private — do not quote it in the chat)
  - For one-shot tasks (no need to reflect on a single tool call)

Parameters:
  - focus (string, optional): "tools" | "strategy" | "user" — what aspect to focus on. Default: "all".
  - depth (string, optional): "shallow" | "deep". Default: "shallow".

Returns:
  - The reflection text + a confirmation that it was written to the log.

Examples:
  - self_reflect focus=tools depth=deep → analyze your tool-use patterns over the last session
  - self_reflect focus=user → synthesize observations about the user's habits

Concurrency: SAFE (private write).`,

  webFetch: `Fetch a URL over HTTP(S) and return the response body as text. Use this to read web pages, call public APIs, or download text content.

When to use:
  - "Look up the docs for X"
  - "Get the current weather / stock price / API response"
  - "Summarize this article"
  - "What does this URL return?"

When NOT to use:
  - file:// or any non-http(s) scheme (refuses)
  - Downloading large binaries (200KB cap; use bash + curl for that)
  - Pages that require login or JavaScript (use a headless browser instead; v3.5+)

Parameters:
  - url (string, required): absolute http:// or https:// URL
  - headers (object, optional): custom request headers
  - maxBytes (number, default 200000): truncate the response body at N bytes
  - timeout (number, default 30000, max 300000): request timeout in ms

Returns:
  - "HTTP <status> (<ms>, <final-url>)\\n<headers>\\n\\n<body\\n(N bytes)"

Examples:
  - webFetch url="https://api.github.com/repos/torvalds/linux" → JSON repo info
  - webFetch url="https://example.com" maxBytes=1000 → first 1KB of example.com

Concurrency: NOT safe (network).`,

  plan: `Decompose a multi-step task into a dependency-aware plan, or checkpoint progress on an existing plan.

When to use:
  - User asks for >3 steps of work (build a feature, investigate a problem, ship a refactor)
  - You want a paper trail that survives session restarts
  - The task has dependencies between subtasks (do A, then B depends on A)

When NOT to use:
  - Single-step question/answer
  - One tool call will resolve it
  - You're already inside a planned execution (use \`record\` only)

Modes (action param):
  - 'propose' (default): returns a validated step list. Required: \`goal\`, \`steps\`.
  - 'record': checkpoint one step. Required: \`planId\`, \`stepId\`, \`status\`.
  - 'list': list plan ids for the cwd.
  - 'read': read a plan. Required: \`planId\`.

Returns:
  - propose: { planId, steps, validated: true } or { error, issues: [...] }
  - record: { ok: true, status, notes }
  - list: { planIds: [...] }
  - read: { plan: {...} } or { error: 'not found' }

Examples:
  - plan action=propose goal="refactor auth" steps=[{title:"audit", action:"grep auth files", dependsOn:[]}, {title:"refactor", action:"edit + test", dependsOn:["s1"]}]
  - plan action=record planId=plan_abc stepId=s1 status=done note="all 5 files mapped"

Concurrency: NOT safe (writes state to disk).`,

  memory: `Read or write the agent's long-term memory (Generative Agents pattern). Survives across sessions. Three targets:

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

  skill: `Load, save, or run a reusable sub-workflow ("skill"). Skills live under ~/.deqi/memory/skills/<name>/ as SKILL.md (the spec) + optional run.sh (the executor).

Actions (action param):
  - 'list'   — list all skill names + descriptions. No other params required.
  - 'read'   — read a skill's SKILL.md. Required: name.
  - 'write'  — create or update a skill. Required: name, body. Optional: runScript.
  - 'run'    — execute the skill's run.sh. Required: name. Optional: args (string[]).

When to use:
  - You have a multi-step workflow you keep doing (build, test, deploy, lint, etc.) — save it as a skill
  - The user mentions a "skill" by name — load it
  - You want to make your work reproducible across sessions — save a skill

When NOT to use:
  - For one-off commands (use \`bash\` instead)
  - For things that change every run (use \`write\` to update the skill each time)
  - For binaries (run.sh is interpreted, not compiled)

Parameters:
  - action (string, required): 'list' | 'read' | 'write' | 'run'
  - name (string, required for read/write/run): skill name (kebab-case recommended)
  - body (string, required for write): the SKILL.md content. First line is treated as the title; second line should start with 'description:'.
  - runScript (string, optional, for write): the run.sh content. If omitted, the skill is documentation-only.
  - args (string[], optional, for run): arguments to pass to run.sh.

Returns:
  - list: array of {name, description, dir, hasRun}
  - read: full SKILL.md body
  - write: {ok: true, path}
  - run: stdout + stderr from run.sh

Examples:
  - skill action=list → all skills
  - skill action=read name=deploy → SKILL.md
  - skill action=write name=lint body="title: lint\\ndescription: run eslint" runScript="#!/bin/bash\\nnpx eslint .\\n"
  - skill action=run name=lint → runs run.sh

Concurrency: NOT safe (writes skill files).`,

  orchestrator: `Dispatch a multi-step task to a specialist agent. v3.3 ships three specialists: code-reviewer, test-runner, doc-writer. v3.4 will replace the deterministic stubs with real LLM-backed runs.

When to use:
  - You want a focused, parallelizable unit of work (review, test, docs)
  - The task is well-bounded and the specialist's output format is what you need
  - You want a separate context window so the main session stays clean

When NOT to use:
  - You need a tool the specialist isn't allowed to use (specialists are restricted)
  - The task is interactive (the specialist is fire-and-forget)
  - You could do the work yourself in 1-2 tool calls

Parameters:
  - specialist (string, required): 'code-reviewer' | 'test-runner' | 'doc-writer'
  - task (string, required): the unit of work. The specialist sees ONLY this string + the sandboxed directory.
  - sandbox (string, optional): absolute path OR path relative to cwd. Limits where the specialist can read. Invalid paths → isError.

Returns:
  - the specialist's report (text).
  - The first line is always a header: \`# <specialist>: <task>\`
  - The rest follows the specialist's contract (see specialists.ts).

Examples:
  - orchestrator specialist=code-reviewer task="review the last 3 commits" sandbox=src/
  - orchestrator specialist=test-runner task="run the full test suite"
  - orchestrator specialist=doc-writer task="document the public API" sandbox=packages/server/src

Concurrency: NOT safe (LLM-backed in v3.4).`,

  eval: `Self-grade a recent action or your own turn. Writes the grade to the introspection log. v3.4 ships this as a self-report — the grade is the model's honest assessment, not an external oracle (the bench harness in bench/ is the oracle).

Modes (mode param):
  - 'grade'   (default): grade ONE recent action. Required: subject, grade (0..1), rationale.
  - 'turn'    : grade your entire current turn. Same fields; 'subject' is auto-filled.
  - 'stats'   : return the aggregate stats from the introspection log (no writes).
  - 'recent'  : return the last N introspection entries (no writes). Required: limit?

Parameters:
  - mode (string, optional, default 'grade')
  - subject (string, required for grade): what you're grading (e.g. "tool:webFetch url=https://...")
  - grade (number, 0..1, required for grade): 0=failed, 1=perfect, 0.5=partial
  - rationale (string, required for grade): one or two sentences explaining the grade
  - sessionId (string, optional): session to grade against; defaults to current
  - limit (number, optional, default 10): for 'recent'

Returns:
  - grade: {ok: true, id, grade, meanGrade}  — the new entry + rolling mean
  - turn:  same shape, subject="<auto>"
  - stats: AggregateStats
  - recent: array of IntrospectionEntry

When to use:
  - You just did something the user might evaluate (a tool call, a long answer) — grade yourself
  - You want to know how you've been doing this session — call stats
  - You want to remember what happened — call recent

When NOT to use:
  - For user-facing grades (this is private)
  - For every turn (use it for the ones that matter — long answers, tool failures, ambiguous results)
  - Instead of doing the work (the grade is metadata, not a substitute for action)

Examples:
  - eval subject="tool:webFetch url=..." grade=0.9 rationale="worked first try"
  - eval mode=turn grade=0.7 rationale="got the answer but had to retry bash twice"
  - eval mode=stats → aggregate stats for the whole log

Concurrency: NOT safe (writes the introspection log).`,

  mcp: `Interact with configured MCP (Model Context Protocol) servers. v3.5 ships the read + call side only — the client does NOT start, stop, or manage servers.

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
  - list:  { servers: [{name, command, args, env}] } (env values masked)
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

  browser: `Fetch a URL and return its content. v3.5 ships a fetch-based implementation (no JS execution, no real layout). For real screenshots, use a headless browser via the MCP browser server (v3.5.1).

URL safety:
  - Only http/https schemes are accepted
  - Private/loopback/link-local/multicast IPs are REJECTED by default
  - Pass allowPrivate=true ONLY for testing against 127.0.0.1

Modes (mode param):
  - 'navigate'  (default): fetch + return status, headers, content-type, and a 4KB body preview
  - 'extract'   : fetch + extract text. Optional 'selector' for simple selectors (#id, .class, tag).
  - 'screenshot': fetch + return the raw HTML as base64 (clearly labeled; NOT a real image in v3.5)

Parameters:
  - mode (string, optional, default 'navigate')
  - url (string, required)
  - selector (string, optional, extract only)
  - allowPrivate (boolean, optional, default false)

Returns:
  - navigate:  { ok, status, headers, contentType, bodyPreview }
  - extract:   { ok, text }
  - screenshot:{ ok, mimeType, encoding, data, note }

When to use:
  - The user gives you a URL to read
  - You need to verify a doc or API
  - You need to extract text from a page (without JS)

When NOT to use:
  - For pages that require login + JS (use a real browser via MCP)
  - For binary downloads (use bash + curl/wget)
  - For internal services (private IPs are blocked)`,

  // v4.0: Recipe — declarative multi-step workflow.
  recipe: `Run a Recipe YAML file (v4.0). A recipe is a list of steps, each declaring a tool + args. The runner executes them in order; failures stop the run.

When to use:
  - The user has a known multi-step workflow they want to encode once and replay (release, smoke-test, open-pr)
  - CI wants to drive the agent without chatting
  - You want a sub-workflow with a single LLM call instead of N (faster, cheaper, more deterministic)

When NOT to use:
  - The user is exploring or iterating — chat is the right tool
  - The workflow depends on real-time decisions between steps
  - The recipe references tools that don't exist in the current registry

Examples:
  - recipe_run path="./recipes/release.yaml" → runs bump + tag + push
  - recipe_run path="~/hardproblems/recipes/build-and-deploy.yaml" → CI path

Inputs:
  - path (string, required): path to a .yaml recipe file. Relative paths resolve against the agent cwd.

Returns:
  - { ok, recipe: { name, steps }, results: [{ step, tool, ok, preview, durationMs }] }`,

  // v4.2: delegate — fan-out to N sub-agents in parallel.
  delegate: `Fan out to N sub-agents in parallel and return a combined report (v4.2). Each task declares a prompt + optional model + tool allowlist. Sub-agents run concurrently (bounded by maxConcurrency, default 4). Sub-agent events stream back to the parent in real time.

When to use:
  - The user has multiple independent angles to research ("compare 3 frameworks on perf, ergonomics, license")
  - The next turn of the agent would otherwise do them sequentially with subagent
  - You want a single LLM call to result in a "synthesis" report

When NOT to use:
  - The sub-tasks are dependent (task B needs task A's output) — use sequential subagent
  - You only have one sub-task — use subagent directly
  - The provider rate limit would be violated (cap with maxConcurrency)

Examples:
  - delegate tasks=[{prompt: "summarize spec A"}, {prompt: "summarize spec B"}] → 2 parallel summaries
  - delegate tasks=3 angle prompts, maxConcurrency=2 → batches of 2

Returns:
  - A markdown report with one section per task (status, duration, body)`,

  // v4.8: delegate_remote — fan-out across multiple Deqi
  // desktops in the same ~/.deqi/ cluster.
  delegate_remote: `Fan out to N sub-agents across multiple Deqi desktops (v4.8). Each task declares a (prompt, target) tuple; the target can pin to a specific desktop_id, or select by capability (e.g. "browser-v2") or tag (e.g. "laptop"). Without a target, the task routes to any live desktop (typically the local one). Sub-agents run concurrently (bounded by maxConcurrency, default 4).

When to use:
  - You need to leverage machines with different capabilities (only the laptop has browser-v2; only the desktop has a fast GPU).
  - You want load distribution across a small fleet.
  - The task is intrinsically multi-machine (a build farm, a regional comparison).

When NOT to use:
  - All work fits on one machine — use the simpler \`delegate\` tool.
  - You need a stream of live sub-agent events back to the parent (v4.8 returns only the final text; v4.9+ will stream).
  - The target desktop is unreachable — you'll get a "target_unreachable" error for that task, not a hard fail.

Examples:
  - delegate_remote tasks=[{prompt: "fetch the API", target:{capability:"browser-v2"}}, {prompt: "summarize locally", target:{tag:"desktop"}}] → splits by capability + tag
  - delegate_remote tasks=[{prompt: "...", target:{desktop_id:"d_8a3f4b2c"}}] → exact pin

Returns:
  - A markdown report with one section per task (status, duration, target desktop_id, body)`,
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;

export function getToolDescription(name: string): string | null {
  return (TOOL_DESCRIPTIONS as Record<string, string | undefined>)[name] ?? null;
}
