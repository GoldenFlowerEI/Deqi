# Deqi (得气) — v0.4.0

> **得气** *(dé qì)* — the moment in Tai Chi / Qigong when the breath
> starts flowing through the body and the practice begins to take effect.
> The same idea, applied to an AI agent harness: when the agent stops
> being a tool and starts being a partner.

Deqi is an AI agent harness that pairs a Tauri 2 desktop app with a
WebSocket + HTTP server, a TypeScript plugin system, and a 4-layer
deep-cognition stack (introspection / transcendence / constitution /
user-model). It started life as GFEI (Golden Flower Emergent
Intelligence); this is the v0.1.0 rebrand under the Deqi name.

```
┌─ Deqi desktop ──────────────────────────────────────────┐
│   Tauri 2 + React + Vite.  22 built-in tools + plugins.   │
│   Connection: ws://127.0.0.1:7700/v1/chat                │
└────────────────────────────────┬─────────────────────────┘
                                 │ JSON-RPC / REST
┌────────────────────────────────▼─────────────────────────┐
│   Deqi-server (Bun-compiled, single binary)              │
│   127.0.0.1:7700 — HTTP REST + WebSocket facade          │
│   Plugin loader, telemetry, permission grants, schedule  │
└────────────────────────────────┬─────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────┐
│   Deqi packages (workspace)                         │
│   agent-core · ai · introspection · coding-agent · server │
└──────────────────────────────────────────────────────────┘
```

## What's in 0.4.0

| Surface                | What you get                                           |
|------------------------|--------------------------------------------------------|
| **Desktop**            | Tauri 2 + React. Left rail: New task · Search · Schedule · Plugins · Web · Mobile · Feedback · Settings. Welcome state with 4 quick actions. |
| **Server**             | 22 built-in tools, 5 plugin surfaces (tool/route/event/capability/log). Per-session permission grants (turn / session / forever). |
| **Permissions**        | 4 modes — `plan`, `default`, `accept-edits`, `bypass-permissions` — plus the legacy `chat_only`. Every tool call is classified (`read` / `plan` / `mutate` / `shell` / `network` / `escalate`) and the gate **fails closed**: a tool with no classification asks. |
| **Moral layer**        | 13 rules anchored to the numbered constitution principles, in three forms: **A** every finding is shown as an expandable chip as it happens, **B** an irreversible action gets one extra confirmation even in a mode that would allow it, **C** each turn closes with a short factual review. It can raise a verdict but never lower one — it never denies. See below. |
| **Diffs**             | `write` and `edit` compute a line diff where the before and after text both exist — on the server, in the tool — and stream it on `tool_end`. The client never has to guess what changed. |
| **Rendering**         | Assistant replies are Markdown (GFM tables, fenced code with a language label and a copy button). Tool inputs lead with the argument that identifies the call; bulk fields like a file body are summarised, and the full input is one click away. |
| **Plugins**            | 6 official: `deqi-plugin-{browser, browser-v2, git, hello, http-fetch, stamp}`. Hot-reload, capability allowlist, optional. |
| **Stack**              | Tauri 2 · React 18 · Vite 5 · Bun · TypeScript · WebView2 (Windows) · WebKit (macOS/Linux). |
| **Provider support**   | Anthropic · OpenAI · Google · OpenAI-compatible (13 models registered by default; pick from the model dropdown). |
| **Tests**              | 57 harness suites in `examples/smoke/` (~1500 assertions) + 239 desktop unit tests. `bun run test` runs both. |

## The moral layer

`constitution.md` is ten principles in prose, prepended to the system
prompt. In practice it is a *request*: nothing checked whether the
agent followed it, and nothing showed the user whether it did. The
moral layer turns it into something checkable.

Each rule is a pure predicate over `(toolName, args)`, anchored to a
numbered principle, and carries a **concrete consequence** rather than
an abstract rule — constitution principle 7, applied to the layer
itself. A user who disagrees with a flag can read the reasoning and
overrule it.

It appears in three forms, and each is a separate guarantee:

| Form | Where | What it does |
|---|---|---|
| **A · visible** | inline chip, as the call happens | Every finding is reported, including in modes where it does not gate. Collapsed by default; expands to the principle and the cost. |
| **B · gate** | the permission prompt | A finding that is both `high` severity *and* on the six-rule blocking list turns an `allow` into an `ask`. The prompt carries the reason. |
| **C · review** | end of turn | A one-line factual close: *"1 irreversible action · 2 tool calls"*. Emitted only when there is something to say. |

Three properties make it safe to leave on:

- **It never denies.** It can only raise a verdict or report. A moral
  judgement that silently stops work is how the feature gets switched
  off, and then it protects nothing. Deny messages still name the
  consequence, so the model can route around it deliberately.
- **`bypass-permissions` is exempt from form B.** That mode means
  "stop asking me", and overriding it would make the mode a lie. The
  findings are still audited and shown there.
- **The rules are deliberately narrow.** Each one matches a specific
  destructive shape, never a general category. `rm -rf` fires;
  `rm -r` does not, because it prompts and is recoverable. Roughly
  half of `v0.3-moral-test.ts` is commands that *look* dangerous and
  must produce no finding, because a moral layer that cries wolf gets
  muted.

`secret-in-command` is a good example of the narrowness in practice:
it looks for `sk-`/`ghp_`/`AKIA`/`xox*-` shapes in a command line,
because a key pasted into a shell is a key in the transcript, the
history, and every process's `ps` output at once.

## Install

```bash
git clone https://github.com/GoldenFlowerEI/Deqi.git
cd Deqi
bun install
bun run build
bun run tauri:dev        # native window + server + Vite all start
```

On first build, cargo compiles the Tauri shell (~5 min on Windows,
then cached). On macOS / Linux, WebKit is the system's.

## Testing

```bash
bun run test              # both suites
bun run test:harness      # examples/smoke/ — 56 suites
bun run test:desktop      # packages/desktop — vitest
bun run lint              # eslint
```

The harness runner (`examples/smoke/run-all.mjs`) **discovers** the
test files itself rather than listing them, and exits non-zero if any
suite fails. To see what it will run:

```bash
node examples/smoke/run-all.mjs --list
```

A test file that is not in that list is not being run. If you add
one, check it appears. (The runner used to be a hand-maintained
`;`-separated command chain, which discarded exit codes *and* omitted
half the files on disk — a green build proved nothing.)

Five suites need a real provider key or a live server and are skipped
unless you pass `--all`; the rest are hermetic.

## Config

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
# or any OpenAI-compatible endpoint:
export DEQI_OPENAI_COMPAT_BASE_URL=https://api.deepseek.com/v1
export DEQI_OPENAI_COMPAT_API_KEY=...

# Optional: opt in to telemetry
export DEQI_TELEMETRY=1

# Optional: enable plugins (off by default)
export DEQI_ENABLE_PLUGINS=1
```

Deqi reads `~/.deqi/config.json` on start (falls back to env vars).

## Architecture

6 packages in `packages/`:

- `ai/` — model registry, provider abstraction (Anthropic / OpenAI / Google / openai-compat / mock)
- `agent-core/` — agent loop, state machine, tool harness
- `coding-agent/` — the 22 tools + constitutional system prompt
- `introspection/` — the 4 deep layers
- `server/` — Deqi-server (HTTP + WebSocket facade, dist/ for shipping)
- `desktop/` — Tauri 2 + React + Vite frontend

Plus `examples/smoke/` (55 harness suites), `scripts/` (build + dev runners),
and `docs/` (per-version design docs).

`packages/coding-agent/_modes.disabled/` holds the old interactive /
print front-ends. They are not compiled and not run.

## Philosophy

Deqi is built on three principles:

- **Minimal core, maximal freedom** — 22 tools, 1 event loop, transparent prompt
- **Harness > Model** — most of the code is deterministic infrastructure
- **Emergent by design** — the 4 deep layers (introspection, transcendence,
  user-model, constitution) are how the agent becomes capable of observing
  its own patterns and proposing emergent goals

The previous name (GFEI) referenced the Daoist *Secret of the Golden
Flower* (太乙金华宗旨), specifically the practice of *huiguang*
(回光, returning the light). The Deqi rebrand reframes the same
philosophy through Tai Chi / Qigong vocabulary: 得气 (dé qì) is
the moment of "getting the qi" — when breath and movement first
connect, and the practice starts to flow.

## Repository layout

```
Deqi/
├── packages/
│   ├── ai/                 — model registry, provider abstraction
│   ├── agent-core/         — agent loop, state machine, tool harness
│   ├── coding-agent/       — the 22 tools + constitutional prompt
│   ├── introspection/      — the 4 deep layers
│   ├── server/             — Deqi-server (HTTP + WebSocket facade)
│   ├── desktop/            — Tauri 2 + React + Vite frontend
├── examples/
│   ├── smoke/              — 55 harness suites (run-all.mjs discovers them)
│   ├── recipes/            — Recipe YAML examples
│   └── plugins/            — 6 official plugin packages
├── scripts/
│   ├── build-all.mjs       — topological TypeScript build
│   ├── dev-desktop.mjs     — parallel runner for Deqi-server + Vite
│   └── gen-deqi-icons.mjs  — zero-dep PNG/ICO icon generator
├── docs/                   — per-version design docs
├── bin/                    — Deqi-server.js launcher
├── PHILOSOPHY.md           — the 7-layer philosophical foundations
└── README.md               — you are here
```

## License

MIT
