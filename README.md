# Deqi (得气) — v0.1.0

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

## What's in 0.1.0

| Surface                | What you get                                           |
|------------------------|--------------------------------------------------------|
| **Desktop**            | Tauri 2 + React. Left rail: New task · Search · Schedule · Plugins · Web · Mobile · Feedback · Settings. Welcome state with 4 quick actions. |
| **Server**             | 22 built-in tools, 5 plugin surfaces (tool/route/event/capability/log). Per-session permission grants (turn / session / forever). |
| **Plugins**            | 6 official: `deqi-plugin-{browser, browser-v2, git, hello, http-fetch, stamp}`. Hot-reload, capability allowlist, optional. |
| **Stack**              | Tauri 2 · React 18 · Vite 5 · Bun · TypeScript · WebView2 (Windows) · WebKit (macOS/Linux). |
| **Provider support**   | Anthropic · OpenAI · Google · OpenAI-compatible (13 models registered by default; pick from the model dropdown). |
| **Tests**              | 30+ smoke suites in `examples/smoke/`; `bun run test` runs the full suite. |

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

7 packages in `packages/`:

- `ai/` — model registry, provider abstraction (Anthropic / OpenAI / Google / openai-compat / mock)
- `agent-core/` — agent loop, state machine, tool harness
- `coding-agent/` — the 22 tools + constitutional system prompt
- `introspection/` — the 4 deep layers
- `server/` — Deqi-server (HTTP + WebSocket facade, dist/ for shipping)
- `desktop/` — Tauri 2 + React + Vite frontend
- `_tui.disabled/` — v1 TUI, preserved on disk, gitignored

Plus `examples/smoke/` (30+ smoke tests), `scripts/` (build + dev runners),
and `docs/` (per-version design docs).

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
│   └── _tui.disabled/      — v1 TUI (preserved, gitignored)
├── examples/
│   ├── smoke/              — 30+ smoke tests
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
